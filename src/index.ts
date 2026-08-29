import { getSandbox, type DirectoryBackup, type Sandbox } from "@cloudflare/sandbox";
import DEFAULT_PROMPT from "./templates/default-review.md";
import ENTRYPOINT_SCRIPT from "./templates/entrypoint.sh";
export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  KV: KVNamespace;
  BACKUP_BUCKET: R2Bucket;
  AUTH_TOKEN: string;
  GH_TOKEN: string;
  LINEAR_API_KEY: string;
  REVIEW_WORKER_URL: string;
  OPENCODE_MODEL: string;
  OPENCODE_VARIANT?: string;
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
  checkRunId?: number;
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

async function hashContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const CHECK_RUN_NAME = "AI Review";

// Nothing else bounds how long a container lives: keepAlive is set on every
// sandbox, so sleepAfter never fires. This covers provisioning as well as the
// review, and a cold toolchain build has taken over an hour, so the ceiling
// sits well clear of that -- it only ever catches genuine orphans.
const SANDBOX_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

// A cold `mise install` of a language toolchain builds from source and can run
// for the better part of an hour. At the old five minute cap the setup step was
// killed halfway and its half-built workspace was then saved as the backup.
const SETUP_TIMEOUT_MS = 45 * 60 * 1000;

// A sandbox can only be destroyed by name, and the review record that holds
// that name is keyed per PR -- so a second review round for the same PR used to
// overwrite the first run's id and strand its container running forever. This
// index records every sandbox on its own key so the sweep can always reap it.
type TrackedSandbox = { sandboxId: string; startedAt: string };

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "pr-review-agent",
});

async function createCheckRun(
  ghToken: string,
  owner: string,
  repo: string,
  sha: string,
  detailsUrl: string,
): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/check-runs`,
      {
        method: "POST",
        headers: GH_HEADERS(ghToken),
        body: JSON.stringify({
          name: CHECK_RUN_NAME,
          head_sha: sha,
          status: "in_progress",
          started_at: new Date().toISOString(),
          details_url: detailsUrl,
          output: {
            title: "Review in progress",
            summary: "The AI review agent is analyzing this PR.",
          },
        }),
      },
    );
    if (!resp.ok) {
      console.error(`createCheckRun failed: ${resp.status} ${await resp.text()}`);
      return null;
    }
    return ((await resp.json()) as { id: number }).id;
  } catch (e) {
    console.error("createCheckRun error:", e);
    return null;
  }
}

async function updateCheckRun(
  ghToken: string,
  owner: string,
  repo: string,
  checkRunId: number,
  params: Record<string, unknown>,
): Promise<boolean> {
  // This PATCH is the only thing that moves a check run out of "in_progress".
  // When it failed silently the PR sat pending until the cron sweep stamped a
  // timeout on a review that had in fact finished, so it retries and reports.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
        {
          method: "PATCH",
          headers: GH_HEADERS(ghToken),
          body: JSON.stringify(params),
        },
      );
      if (resp.ok) return true;
      console.error(
        `updateCheckRun ${owner}/${repo} check ${checkRunId} attempt ${attempt} failed: ` +
          `${resp.status} ${await resp.text()}`,
      );
      // A 4xx that is not throttling will not resolve itself.
      if (resp.status < 500 && resp.status !== 403 && resp.status !== 429) return false;
    } catch (e) {
      console.error(
        `updateCheckRun ${owner}/${repo} check ${checkRunId} attempt ${attempt} error:`,
        e,
      );
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return false;
}

// The KV record is keyed per PR and only ever holds the newest run, so it
// cannot be trusted to name the check run for the run that is reporting in.
// Ask GitHub instead, using the sha that was actually reviewed.
async function findCheckRunId(
  ghToken: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs` +
        `?check_name=${encodeURIComponent(CHECK_RUN_NAME)}&per_page=100`,
      { headers: GH_HEADERS(ghToken) },
    );
    if (!resp.ok) {
      console.error(`findCheckRunId failed: ${resp.status} ${await resp.text()}`);
      return null;
    }
    const runs =
      ((await resp.json()) as {
        check_runs?: { id: number; status: string; started_at: string }[];
      }).check_runs ?? [];
    // Prefer one that is still open; otherwise the most recently started.
    const open = runs.filter((r) => r.status !== "completed");
    const [pick] = (open.length ? open : runs).sort((a, b) =>
      (b.started_at ?? "").localeCompare(a.started_at ?? ""),
    );
    return pick?.id ?? null;
  } catch (e) {
    console.error("findCheckRunId error:", e);
    return null;
  }
}

async function getPrHeadSha(
  ghToken: string,
  owner: string,
  repo: string,
  prNumber: string,
): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      { headers: GH_HEADERS(ghToken) },
    );
    if (!resp.ok) return null;
    return ((await resp.json()) as { head?: { sha?: string } }).head?.sha ?? null;
  } catch {
    return null;
  }
}

// Only reports false when GitHub confirms the run already reported a result.
// Anything ambiguous stays "open" so a timeout is still surfaced.
async function isCheckRunOpen(
  ghToken: string,
  owner: string,
  repo: string,
  checkRunId: number,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
      { headers: GH_HEADERS(ghToken) },
    );
    if (!resp.ok) return true;
    return ((await resp.json()) as { status?: string }).status !== "completed";
  } catch {
    return true;
  }
}

async function handleReview(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!validateAuth(request, env.AUTH_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const missing = [
    ["OPENCODE_MODEL", env.OPENCODE_MODEL],
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
    keepAlive: true,
  });
  const sandboxId = `${kvKey}:${run_id}`;
  const provisionStart = new Date().toISOString();
  // Before any provisioning work: a container that exists but is not yet
  // tracked cannot be reaped if this request dies partway through.
  await env.KV.put(
    `sandbox:${sandboxId}`,
    JSON.stringify({ sandboxId, startedAt: provisionStart } as TrackedSandbox),
    { expirationTtl: 7 * 24 * 60 * 60 },
  );

  const ghToken = await getInstallationToken(env);

  // Kick off independent operations in parallel: setting sandbox env vars,
  // fetching repo config files, and creating the check run are all
  // independent API calls that were previously sequential.
  const logUrl = `${env.REVIEW_WORKER_URL}/logs?owner=${owner}&repo=${repo}&pr_number=${pr_number}`;
  const [, setupScript, promptMd, checkRunId] = await Promise.all([
    sandbox.setEnvVars({
      GH_TOKEN: ghToken,
      LINEAR_API_KEY: env.LINEAR_API_KEY,
      LLM_API_KEY: env.LLM_API_KEY,
      REVIEW_WORKER_URL: env.REVIEW_WORKER_URL,
      REVIEW_WORKER_TOKEN: env.AUTH_TOKEN,
      OPENCODE_VARIANT: env.OPENCODE_VARIANT ?? "max",
      MISE_DATA_DIR: "/workspace/.mise",
    }),
    fetchGitHubFile(ghToken, full_repo, ".review-agent/setup.sh"),
    fetchGitHubFile(ghToken, full_repo, ".review-agent/prompt.md"),
    createCheckRun(ghToken, owner, repo, sha, logUrl),
  ]);

  // Cache setup output in R2 (keyed on a hash of setup.sh + prompt.md) so we
  // don't re-run slow setup (e.g. building toolchains) on every review.
  const setupHash = await hashContent((setupScript ?? "") + (promptMd ?? ""));
  const backupKey = `backup:${owner}:${repo}:${setupHash}`;
  const existingBackup = await env.KV.get(backupKey);
  let restored = false;
  let restoreMs = 0;
  let setupMs = 0;
  let backupMs = 0;
  if (existingBackup) {
    const started = Date.now();
    try {
      // Backups are created against the local R2 binding; make sure restore
      // takes the same path (otherwise it tries presigned URLs -> undefined).
      await sandbox.restoreBackup({
        ...(JSON.parse(existingBackup) as DirectoryBackup),
        localBucket: true,
      });
      restored = true;
      console.log(`Restored setup backup for ${owner}/${repo}`);
    } catch (e) {
      console.error("restoreBackup failed, will re-run setup:", e);
      await env.KV.delete(backupKey);
    }
    restoreMs = Date.now() - started;
  }
  if (!restored && setupScript) {
    const started = Date.now();
    await sandbox.writeFile("/workspace/setup.sh", setupScript);
    await sandbox.exec("bash /workspace/setup.sh", { timeout: SETUP_TIMEOUT_MS });
    setupMs = Date.now() - started;
    const backupStarted = Date.now();
    try {
      const backup = await sandbox.createBackup({
        dir: "/workspace",
        localBucket: true,
      });
      await env.KV.put(backupKey, JSON.stringify(backup));
      console.log(`Stored setup backup for ${owner}/${repo}`);
    } catch (e) {
      console.error("createBackup failed (review will still proceed):", e);
    }
    backupMs = Date.now() - backupStarted;
  }

  await Promise.all([
    sandbox.writeFile("/workspace/.opencode.json", buildOpenCodeConfig(env.OPENCODE_MODEL)),
    sandbox.writeFile("/workspace/REVIEW_AGENT.md", promptMd ?? DEFAULT_PROMPT),
    sandbox.writeFile("/workspace/entrypoint.sh", ENTRYPOINT_SCRIPT),
  ]);
  await sandbox.exec("chmod +x /workspace/entrypoint.sh");

  const review: ActiveReview = {
    sandboxId,
    owner,
    repo,
    prNumber: pr_number,
    sha,
    startedAt: new Date().toISOString(),
    runId: run_id,
    checkRunId: checkRunId ?? undefined,
  };
  await env.KV.put(kvKey, JSON.stringify(review));

  const timings = {
    restored,
    restoreMs,
    setupMs,
    backupMs,
    provisionMs: Date.now() - Date.parse(provisionStart),
  };
  console.log(`[${owner}/${repo}#${pr_number}] provisioning ${JSON.stringify(timings)}`);
  await env.KV.put(
    `timing:${owner}:${repo}:${pr_number}:${run_id}`,
    JSON.stringify({ ...timings, at: provisionStart }),
    { expirationTtl: 7 * 24 * 60 * 60 },
  );

  await sandbox.startProcess(
    `bash /workspace/entrypoint.sh ${owner} ${repo} ${full_repo} ${pr_number} ${sha} ${run_id} ${base_branch} ${head_branch}`,
    {
      autoCleanup: false,
      env: {
        GH_TOKEN: ghToken,
        LINEAR_API_KEY: env.LINEAR_API_KEY,
        LLM_API_KEY: env.LLM_API_KEY,
        REVIEW_WORKER_URL: env.REVIEW_WORKER_URL,
        REVIEW_WORKER_TOKEN: env.AUTH_TOKEN,
        OPENCODE_VARIANT: env.OPENCODE_VARIANT ?? "max",
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

  // Mark the check run as complete and attach the review output (full log viewable in the Checks tab).
  // The log body is already stored by this point, so everything below is
  // best-effort and must not throw: losing the check run here is what used to
  // leave a finished review pending until the cron sweep called it a timeout.
  const kvKey = `pr:${owner}:${repo}:${prNumber}`;
  const exitCode = url.searchParams.get("exit");
  const failed = exitCode !== null && exitCode !== "0";
  const reportedSha = url.searchParams.get("sha");

  try {
    let existing: ActiveReview | null = null;
    try {
      existing = (await env.KV.get(kvKey, "json")) as ActiveReview | null;
    } catch (e) {
      console.error(`KV read failed for ${kvKey}:`, e);
    }

    const ghToken = await getInstallationToken(env);
    const sha =
      reportedSha ?? existing?.sha ?? (await getPrHeadSha(ghToken, owner, repo, prNumber));

    // Take the cached id only when the record describes the run reporting in;
    // otherwise (missing record, or one replaced by a newer run) ask GitHub.
    let checkRunId: number | null =
      existing?.checkRunId && (!sha || !existing.sha || existing.sha === sha)
        ? existing.checkRunId
        : null;
    if (!checkRunId && sha) {
      checkRunId = await findCheckRunId(ghToken, owner, repo, sha);
    }

    if (!checkRunId) {
      console.error(
        `No check run to close for ${owner}/${repo}#${prNumber} (sha ${sha ?? "unknown"})`,
      );
    } else {
      const MAX = 65000;
      const text = output.length > MAX
        ? `\n...truncated...\n${output.slice(-MAX)}`
        : output;
      const closed = await updateCheckRun(ghToken, owner, repo, checkRunId, {
        status: "completed",
        conclusion: failed ? "failure" : "success",
        completed_at: new Date().toISOString(),
        output: {
          title: failed ? "Review failed" : "Review complete",
          summary: failed
            ? "The AI review agent did not finish successfully. See the attached output for details."
            : "The AI review agent finished processing this PR. Full output is attached below.",
          text,
        },
      });
      if (!closed) {
        console.error(
          `Could not close check run ${checkRunId} for ${owner}/${repo}#${prNumber}`,
        );
      }
    }
  } catch (e) {
    console.error(`Check run completion failed for ${owner}/${repo}#${prNumber}:`, e);
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleGetLogs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  const prNumber = url.searchParams.get("pr_number");
  if (!owner || !repo || !prNumber) {
    return new Response("Missing required fields: owner, repo, pr_number", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const output = await env.KV.get(`logs:${owner}:${repo}:${prNumber}`);
  if (output === null) {
    return new Response("No review logs found for this PR yet.", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response(output, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function handleCleanup(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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
  let existing: ActiveReview | null = null;
  try {
    existing = (await env.KV.get(kvKey, "json")) as ActiveReview | null;
  } catch (e) {
    console.error(`KV read failed for ${kvKey}:`, e);
  }

  // A newer run for this PR owns the record now; it will clean up after itself.
  if (sha && existing && existing.sha !== sha) {
    return new Response(JSON.stringify({ status: "skipped" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Order matters. This request comes from inside the sandbox we are about to
  // destroy, so the teardown severs the caller's connection and the runtime
  // cancels the rest of the invocation. Deleting the record is what disarms the
  // cron sweep, so it has to land before anything can cut the request short.
  try {
    await env.KV.delete(kvKey);
  } catch (e) {
    console.error(`KV delete failed for ${kvKey}:`, e);
  }

  if (existing && existing.runId) {
    const sandbox = getSandbox(
      env.Sandbox,
      `pr:${owner}:${repo}:${pr_number}:${existing.runId}`,
      { keepAlive: true },
    );
    // waitUntil so the teardown still completes once it drops its own caller.
    ctx.waitUntil(sandbox.destroy().catch(() => {}));
  }

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
        // Destroy the (keepAlive'd) sandbox so it doesn't leak.
        const sandbox = getSandbox(
          env.Sandbox,
          `pr:${review.owner}:${review.repo}:${review.prNumber}:${review.runId}`,
          { keepAlive: true },
        );
        await sandbox.destroy().catch(() => {});

        // Surface the timeout in the PR checks UI, but only when the review
        // really is unfinished -- a record that outlived its cleanup must not
        // overwrite a check run that already reported a result.
        if (review.checkRunId) {
          const ghToken = await getInstallationToken(env);
          if (await isCheckRunOpen(ghToken, review.owner, review.repo, review.checkRunId)) {
            await updateCheckRun(ghToken, review.owner, review.repo, review.checkRunId, {
              status: "completed",
              conclusion: "failure",
              completed_at: new Date().toISOString(),
              output: {
                title: "Review timed out",
                summary: "The AI review agent did not complete within 30 minutes.",
              },
            });
          } else {
            console.log(`Stale record for an already-reported check: ${key.name}`);
          }
        }

        await env.KV.delete(key.name);
        await env.KV.delete(`sandbox:${review.sandboxId}`).catch(() => {});
        console.log(`Cleaned up stale review: ${key.name}`);
      }
    } catch {
      await env.KV.delete(key.name);
    }
  }

  // Reap any container that outlived its review, including ones whose review
  // record was replaced by a later run for the same PR and which nothing else
  // can address. No sandbox is ever reused -- ids are per run -- so there is no
  // warm instance to preserve here.
  const sandboxes = await env.KV.list({ prefix: "sandbox:" });
  for (const key of sandboxes.keys) {
    const raw = await env.KV.get(key.name);
    if (!raw) continue;

    try {
      const { sandboxId, startedAt } = JSON.parse(raw) as TrackedSandbox;
      if (now - new Date(startedAt).getTime() <= SANDBOX_MAX_LIFETIME_MS) continue;

      const sandbox = getSandbox(env.Sandbox, sandboxId, { keepAlive: true });
      await sandbox.destroy().catch(() => {});
      await env.KV.delete(key.name);
      console.log(`Reaped sandbox past max lifetime: ${sandboxId}`);
    } catch {
      await env.KV.delete(key.name);
    }
  }
}

async function handleDepsCacheGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  const hash = url.searchParams.get("hash");
  if (!owner || !repo || !hash) {
    return new Response("Missing required fields: owner, repo, hash", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const key = `deps-cache:${owner}:${repo}:${hash}`;
  const obj = await env.BACKUP_BUCKET.get(key);
  if (obj === null) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(obj.body, {
    headers: { "Content-Type": "application/gzip", "Cache-Control": "no-store" },
  });
}

async function handleDepsCachePut(request: Request, env: Env): Promise<Response> {
  if (!validateAuth(request, env.AUTH_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  const hash = url.searchParams.get("hash");
  if (!owner || !repo || !hash) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: owner, repo, hash" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const key = `deps-cache:${owner}:${repo}:${hash}`;
  await env.BACKUP_BUCKET.put(key, request.body, {
    customMetadata: { owner, repo, createdAt: new Date().toISOString() },
  });
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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
      return handleCleanup(request, env, ctx);
    }

    if (url.pathname === "/logs" && request.method === "GET") {
      return handleGetLogs(request, env);
    }

    if (url.pathname === "/logs" && request.method === "POST") {
      return handleLogs(request, env);
    }

    if (url.pathname === "/deps-cache" && request.method === "GET") {
      return handleDepsCacheGet(request, env);
    }

    if (url.pathname === "/deps-cache" && request.method === "PUT") {
      return handleDepsCachePut(request, env);
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
