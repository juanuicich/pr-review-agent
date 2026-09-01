# AGENTS.md

Orientation for agents working in this repo. Setup and secrets are documented in README.md; read that for first-time deployment.

## What this is

An AI code-review agent for GitHub PRs, deployed as a Cloudflare Worker. A composite action in a target repo POSTs to the worker's `/review` endpoint. The worker provisions a Cloudflare Sandbox (a container managed as a Durable Object), which clones the PR, gathers context, runs `opencode run`, and posts a review through the GitHub REST API.

There is no local container. "The reviewer container" is a per-review Cloudflare Sandbox. Local Docker being off is normal and irrelevant to the deployed worker.

## Flow

1. Target repo's workflow calls the composite action (juanuicich/pr-review-agent-action), which POSTs `/review` with PR metadata (owner, repo, pr_number, sha, run_id, branches).
2. The worker resolves a GitHub App installation token (per-owner, cached in KV 7 days; falls back to `GH_TOKEN` if the App is not set).
3. It provisions sandbox `pr:<owner>:<repo>:<n>:<run_id>`, sets env vars (`GH_TOKEN`, `LINEAR_API_KEY`, `LLM_API_KEY`, `REVIEW_WORKER_URL`, `REVIEW_WORKER_TOKEN`, `MISE_DATA_DIR`), and creates the "AI Review" check run on the PR.
4. It fetches the target repo's `.review-agent/setup.sh` and `.review-agent/prompt.md`, runs setup if there is no cached R2 backup (backup key is a hash of setup.sh alone), writes `/workspace/.opencode.json` (model + `{env:LLM_API_KEY}`), `REVIEW_AGENT.md`, and the entrypoint, then starts the entrypoint in the background.
5. The entrypoint (`src/templates/entrypoint.sh`) clones the PR shallowly, gathers `pr-context.json`, `pr.diff`, `changed-files.txt`, CI logs, and optional Linear context into `/workspace`, then runs `opencode run --auto`. The agent posts one review via the REST API, the entrypoint POSTs its log to `/logs`, closes the check run, and calls `/cleanup`, which destroys the sandbox.
6. A cron (`*/10`) marks reviews older than 30 minutes as timed out and destroys sandboxes older than 2 hours.

## Files

- `src/index.ts` — the worker. Routes: `POST /review`, `POST /cleanup`, `GET+POST /logs`, `GET+PUT /deps-cache`, plus `scheduled`. All POST/PUT routes require `Authorization: Bearer <AUTH_TOKEN>`; `GET /logs` is public (check-run links point at it).
- `src/templates/entrypoint.sh` — sandbox entrypoint: context gathering and the `opencode` invocation.
- `src/templates/default-review.md` — default review prompt. A target repo's `.review-agent/prompt.md` replaces it entirely.
- `wrangler.jsonc.example` — deploy template. CI fills in `CF_KV_NAMESPACE_ID` and `CF_R2_BUCKET_NAME` from repo variables. The local `wrangler.jsonc` and root `opencode.json` are gitignored scratch config.
- `agent/` — local scratch, not part of the deployment.

## Model and provider

`OPENCODE_MODEL` is a plain var in `wrangler.jsonc` (opencode `provider/model` format, e.g. `deepseek/deepseek-v4-flash`). The matching API key is the `LLM_API_KEY` worker secret. Changing provider means editing the var, setting the secret, and redeploying.

## Diagnosing missing reviews

1. Find the check run for the PR's head sha:
   `gh api repos/<owner>/<repo>/commits/<sha>/check-runs --jq '.check_runs[] | select(.name == "AI Review") | {id, status, conclusion}'`
2. A `success` conclusion only means the entrypoint exited 0. The review may still not have been posted. Read the full sandbox log (entrypoint output, opencode transcript, `gh api` responses) from:
   `gh api repos/<owner>/<repo>/check-runs/<id> --jq '.output.text'`
   The same log lives in KV under `logs:<owner>:<repo>:<pr_number>` with a 7-day TTL.
3. Worker-side logs: `npx wrangler tail pr-review-agent` (needs Cloudflare auth).
4. No check run at all means the action never reached the worker: check the target repo's workflow, `REVIEW_WORKER_URL`, and `REVIEW_WORKER_TOKEN` in that repo.

## Known gotchas

- `opencode run` is non-interactive: every permission ask auto-rejects. The sandbox is destroyed after each review, so the generated config allows everything (`"*": "allow"` plus `external_directory: {"/**": "allow"}`) and the entrypoint passes `--auto`. Do not remove these without replacing them; a rejected tool call silently ends the review with the check still green.
- The REST reviews endpoint (`POST /repos/{o}/{r}/pulls/{n}/reviews`) rejects any comment object containing `subject_type` with a 422; that field is GraphQL-only. Tested payload shapes (body-only and inline comments) are documented in `src/templates/default-review.md`. If a target repo overrides the prompt, copy that section there too.
- opencode reads config from the working directory, not from `--dir`. The entrypoint `cd /workspace` before running matters.
- `wrangler deploy --dry-run` needs Docker for the container image build and fails locally when Docker is off. TypeScript still typechecks and bundles before that step, so it works as a syntax check. CI runners have Docker.

## Deploy

Push to `main` triggers the GitHub Actions "Deploy" workflow (regenerates `wrangler.jsonc` from the example, runs `wrangler deploy`). Manual: `npm run deploy` (needs local `wrangler.jsonc` filled in and Docker for the image). Secrets: `npx wrangler secret put <NAME> --name pr-review-agent`.
