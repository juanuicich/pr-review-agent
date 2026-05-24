import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import DEFAULT_PROMPT from "./templates/default-review.md";
import ENTRYPOINT_SCRIPT from "./templates/entrypoint.sh";
export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  KV: KVNamespace;
  AUTH_TOKEN: string;
  GH_TOKEN: string;
  LINEAR_API_KEY: string;
  REVIEW_WORKER_URL: string;
  OPENCODE_MODEL: string;
  LLM_API_KEY: string;
}

interface ActiveReview {
  sandboxId: string;
  owner: string;
  repo: string;
  prNumber: number;
  sha: string;
  startedAt: string;
}

function buildOpenCodeConfig(model: string): string {
  const provider = model.split("/")[0];
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model,
      provider: {
        [provider]: {
          options: {
            apiKey: "{env:LLM_API_KEY}",
          },
        },
      },
      permission: {
        "*": "allow",
      },
    },
    null,
    2,
  );
}

function validateAuth(request: Request, token: string): boolean {
  const auth = request.headers.get("Authorization");
  if (!auth) return false;
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;
  return parts[1] === token;
}

async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchGitHubFile(
  env: Env,
  fullRepo: string,
  path: string,
): Promise<string | null> {
  const resp = await fetch(
    `https://api.github.com/repos/${fullRepo}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "pr-review-agent",
      },
    },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) {
    console.error(
      `GitHub API error for ${path}: ${resp.status} ${await resp.text()}`,
    );
    return null;
  }
  const data = (await resp.json()) as { content?: string; encoding?: string };
  if (data.encoding === "base64" && data.content) {
    return atob(data.content.replace(/\n/g, ""));
  }
  return null;
}

async function handleReview(request: Request, env: Env): Promise<Response> {
  if (!validateAuth(request, env.AUTH_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as {
    owner: string;
    repo: string;
    full_repo: string;
    pr_number: number;
    sha: string;
    run_id: string;
    base_branch: string;
    head_branch: string;
  };

  const { owner, repo, full_repo, pr_number, sha, run_id, base_branch, head_branch } =
    body;
  if (!owner || !repo || !full_repo || !pr_number || !sha || !run_id) {
    return new Response(
      JSON.stringify({ error: "Missing required fields" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const kvKey = `pr:${owner}:${repo}:${pr_number}`;

  const existing = await env.KV.get(kvKey);
  if (existing) {
    await env.KV.delete(kvKey);
  }

  const sandbox = getSandbox(env.Sandbox, kvKey);
  const sandboxId = kvKey;

  await sandbox.setEnvVars({
    GH_TOKEN: env.GH_TOKEN,
    LINEAR_API_KEY: env.LINEAR_API_KEY,
    LLM_API_KEY: env.LLM_API_KEY,
    REVIEW_WORKER_URL: env.REVIEW_WORKER_URL,
    REVIEW_WORKER_TOKEN: env.AUTH_TOKEN,
    MISE_DATA_DIR: "/workspace/.mise",
  });

  const setupScript = await fetchGitHubFile(
    env,
    full_repo,
    ".review-agent/setup.sh",
  );
  const promptMd = await fetchGitHubFile(
    env,
    full_repo,
    ".review-agent/prompt.md",
  );

  const setupHash = await hashContent((setupScript ?? "") + (promptMd ?? ""));
  const backupKey = `backup:${owner}:${repo}:${setupHash}`;

  const existingBackup = await env.KV.get(backupKey);
  if (existingBackup) {
    const backupHandle = JSON.parse(existingBackup);
    backupHandle.localBucket = true;
    await sandbox.restoreBackup(backupHandle);
  } else if (setupScript) {
    await sandbox.writeFile("/workspace/setup.sh", setupScript);
    await sandbox.exec("bash /workspace/setup.sh");
    const backup = await sandbox.createBackup({ dir: "/workspace", localBucket: true });
    await env.KV.put(backupKey, JSON.stringify(backup));
  }

  await sandbox.writeFile("/workspace/.opencode.json", buildOpenCodeConfig(env.OPENCODE_MODEL));
  await sandbox.writeFile(
    "/workspace/REVIEW_AGENT.md",
    promptMd ?? DEFAULT_PROMPT,
  );
  await sandbox.writeFile("/workspace/entrypoint.sh", ENTRYPOINT_SCRIPT);
  await sandbox.exec("chmod +x /workspace/entrypoint.sh");

  await sandbox.startProcess(
    `bash /workspace/entrypoint.sh ${owner} ${repo} ${full_repo} ${pr_number} ${sha} ${run_id} ${base_branch} ${head_branch}`,
  );

  const review: ActiveReview = {
    sandboxId,
    owner,
    repo,
    prNumber: pr_number,
    sha,
    startedAt: new Date().toISOString(),
  };
  await env.KV.put(kvKey, JSON.stringify(review));

  return new Response(JSON.stringify({ status: "started" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleCleanup(request: Request, env: Env): Promise<Response> {
  if (!validateAuth(request, env.AUTH_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as {
    owner: string;
    repo: string;
    pr_number: number;
    sha: string;
  };

  const { owner, repo, pr_number, sha } = body;
  if (!owner || !repo || !pr_number) {
    return new Response(
      JSON.stringify({ error: "Missing required fields" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const kvKey = `pr:${owner}:${repo}:${pr_number}`;
  if (sha) {
    const existing = (await env.KV.get(kvKey, "json")) as ActiveReview | null;
    if (existing && existing.sha !== sha) {
      return new Response(JSON.stringify({ status: "skipped" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  await env.KV.delete(kvKey);

  return new Response(JSON.stringify({ status: "cleaned" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const list = await env.KV.list({ prefix: "pr:" });
  const now = Date.now();
  const timeoutMs = 30 * 60 * 1000;

  for (const key of list.keys) {
    const raw = await env.KV.get(key.name);
    if (!raw) continue;

    try {
      const review: ActiveReview = JSON.parse(raw);
      const startedAt = new Date(review.startedAt).getTime();
      if (now - startedAt > timeoutMs) {
        await env.KV.delete(key.name);
        console.log(`Cleaned up stale review: ${key.name}`);
      }
    } catch {
      await env.KV.delete(key.name);
    }
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/review" && request.method === "POST") {
      return handleReview(request, env);
    }

    if (url.pathname === "/cleanup" && request.method === "POST") {
      return handleCleanup(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await handleScheduled(event, env);
  },
};
