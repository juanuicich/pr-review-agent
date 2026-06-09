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
  GOOSE_MODEL: string;
  LLM_API_KEY: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

interface ActiveReview {
  sandboxId: string;
  owner: string;
  repo: string;
  prNumber: number;
  sha: string;
  startedAt: string;
  runId: string;
}

function parseGooseModel(model: string): { provider: string; modelName: string; apiKeyEnvVar: string } {
  const provider = model.split("/")[0];
  const modelName = model.split("/").slice(1).join("/");
  const PROVIDER_API_KEY_MAP: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    google: "GOOGLE_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    xai: "XAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    ollama: "OLLAMA_API_KEY",
  };
  return {
    provider,
    modelName,
    apiKeyEnvVar: PROVIDER_API_KEY_MAP[provider] ?? `${provider.toUpperCase()}_API_KEY`,
  };
}

function validateAuth(request: Request, token: string): boolean {
  const auth = request.headers.get("Authorization");
  if (!auth) return false;
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return false;
  return parts[1] === token;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function signJWT(appId: string, privateKeyPem: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 600, iss: appId };

  const encoder = new TextEncoder();
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const keyData = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    encoder.encode(signingInput),
  );

  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  return `${signingInput}.${encodedSignature}`;
}

async function getInstallationToken(env: Env): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    return env.GH_TOKEN;
  }

  const cacheKey = "github:app:installation_id";
  let installationId = await env.KV.get(cacheKey);

  const jwt = await signJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  if (!installationId) {
    const resp = await fetch("https://api.github.com/app/installations", {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "pr-review-agent",
      },
    });
    if (!resp.ok) {
      console.error(`Failed to list installations: ${resp.status}`);
      return env.GH_TOKEN;
    }
    const installations = (await resp.json()) as { id: number }[];
    if (installations.length === 0) {
      console.error("No app installations found");
      return env.GH_TOKEN;
    }
    installationId = String(installations[0].id);
    await env.KV.put(cacheKey, installationId, { expirationTtl: 7 * 24 * 60 * 60 });
  }

  const tokenResp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "pr-review-agent",
      },
    },
  );
  if (!tokenResp.ok) {
    console.error(`Failed to create installation token: ${tokenResp.status}`);
    return env.GH_TOKEN;
  }
  const tokenData = (await tokenResp.json()) as { token: string };
  return tokenData.token;
}

async function fetchGitHubFile(
  ghToken: string,
  fullRepo: string,
  path: string,
): Promise<string | null> {
  const resp = await fetch(
    `https://api.github.com/repos/${fullRepo}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${ghToken}`,
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

async function handleReview(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!validateAuth(request, env.AUTH_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const missing = [
    ["GOOSE_MODEL", env.GOOSE_MODEL],
    ["GH_TOKEN", env.GH_TOKEN],
    ["GITHUB_APP_ID", env.GITHUB_APP_ID],
    ["GITHUB_APP_PRIVATE_KEY", env.GITHUB_APP_PRIVATE_KEY],
    ["LLM_API_KEY", env.LLM_API_KEY],
    ["LINEAR_API_KEY", env.LINEAR_API_KEY],
    ["REVIEW_WORKER_URL", env.REVIEW_WORKER_URL],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (!env.GH_TOKEN && (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)) {
    return new Response(
      JSON.stringify({ error: "Missing GitHub credentials: set GH_TOKEN or both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  if (missing.length > 0) {
    return new Response(
      JSON.stringify({ error: `Missing worker secrets: ${missing.join(", ")}` }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
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

  const existing = (await env.KV.get(kvKey, "json")) as ActiveReview | null;
  if (existing) {
    if (existing.runId === run_id) {
      return new Response(
        JSON.stringify({ error: "Review already in progress for this PR" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    await env.KV.delete(kvKey);
  }

  const sandbox = getSandbox(env.Sandbox, `${kvKey}:${run_id}`, {
    sleepAfter: "30m",
  });
  const sandboxId = `${kvKey}:${run_id}`;

  const ghToken = await getInstallationToken(env);

  const setupScript = await fetchGitHubFile(
    ghToken,
    full_repo,
    ".review-agent/setup.sh",
  );
  const promptMd = await fetchGitHubFile(
    ghToken,
    full_repo,
    ".review-agent/prompt.md",
  );

  if (setupScript) {
    await sandbox.writeFile("/workspace/setup.sh", setupScript);
    await sandbox.exec("bash /workspace/setup.sh", { timeout: 300_000 });
  }

  const { provider, modelName, apiKeyEnvVar } = parseGooseModel(env.GOOSE_MODEL);

  await sandbox.setEnvVars({
    GOOSE_PROVIDER: provider,
    GOOSE_MODEL: modelName,
    [apiKeyEnvVar]: env.LLM_API_KEY,
    GOOSE_DISABLE_KEYRING: "1",
    GH_TOKEN: ghToken,
    LINEAR_API_KEY: env.LINEAR_API_KEY,
    LLM_API_KEY: env.LLM_API_KEY,
    REVIEW_WORKER_URL: env.REVIEW_WORKER_URL,
    REVIEW_WORKER_TOKEN: env.AUTH_TOKEN,
    MISE_DATA_DIR: "/workspace/.mise",
  });
  await sandbox.writeFile(
    "/workspace/REVIEW_AGENT.md",
    promptMd ?? DEFAULT_PROMPT,
  );
  await sandbox.writeFile("/workspace/entrypoint.sh", ENTRYPOINT_SCRIPT);
  await sandbox.exec("chmod +x /workspace/entrypoint.sh");

  const review: ActiveReview = {
    sandboxId,
    owner,
    repo,
    prNumber: pr_number,
    sha,
    startedAt: new Date().toISOString(),
    runId: run_id,
  };
  await env.KV.put(kvKey, JSON.stringify(review));

  await sandbox.startProcess(
    `bash /workspace/entrypoint.sh ${owner} ${repo} ${full_repo} ${pr_number} ${sha} ${run_id} ${base_branch} ${head_branch}`,
    {
      autoCleanup: false,
      env: {
        GOOSE_PROVIDER: provider,
        GOOSE_MODEL: modelName,
        [apiKeyEnvVar]: env.LLM_API_KEY,
        GOOSE_DISABLE_KEYRING: "1",
        GH_TOKEN: ghToken,
        LINEAR_API_KEY: env.LINEAR_API_KEY,
        LLM_API_KEY: env.LLM_API_KEY,
        REVIEW_WORKER_URL: env.REVIEW_WORKER_URL,
        REVIEW_WORKER_TOKEN: env.AUTH_TOKEN,
        MISE_DATA_DIR: "/workspace/.mise",
      },
    },
  );

  return new Response(JSON.stringify({ status: "started" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleLogs(request: Request, env: Env): Promise<Response> {
  if (!validateAuth(request, env.AUTH_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  const prNumber = url.searchParams.get("pr_number");

  if (!owner || !repo || !prNumber) {
    return new Response(
      JSON.stringify({ error: "Missing required fields" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength && parseInt(contentLength, 10) > 1_048_576) {
    return new Response(
      JSON.stringify({ error: "Log body exceeds 1 MB limit" }),
      { status: 413, headers: { "Content-Type": "application/json" } },
    );
  }

  const output = await request.text();
  const logKey = `logs:${owner}:${repo}:${prNumber}`;
  await env.KV.put(logKey, output, { expirationTtl: 7 * 24 * 60 * 60 });

  const tail = output.length > 4000 ? `\n...truncated...\n${output.slice(-4000)}` : output;
  console.log(`[${owner}/${repo}#${prNumber}] Review output:\n${tail}`);

  return new Response(JSON.stringify({ status: "ok" }), {
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
  const existing = (await env.KV.get(kvKey, "json")) as ActiveReview | null;
  if (sha && existing && existing.sha !== sha) {
    return new Response(JSON.stringify({ status: "skipped" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (existing && existing.runId) {
    const sandbox = getSandbox(env.Sandbox, `${kvKey}:${existing.runId}`, {
      sleepAfter: "30m",
    });
    await sandbox.destroy().catch(() => {});
  }

  await env.KV.delete(kvKey);

  return new Response(JSON.stringify({ status: "cleaned" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const now = Date.now();
  const timeoutMs = 30 * 60 * 1000;

  const reviews = await env.KV.list({ prefix: "pr:" });
  for (const key of reviews.keys) {
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
      return handleReview(request, env, ctx);
    }

    if (url.pathname === "/cleanup" && request.method === "POST") {
      return handleCleanup(request, env);
    }

    if (url.pathname === "/logs" && request.method === "POST") {
      return handleLogs(request, env);
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
