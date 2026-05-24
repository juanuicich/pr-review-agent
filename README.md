# pr-review-agent

AI-powered code review agent that runs on Cloudflare Workers. A GitHub Action triggers the worker, which spins up a sandboxed environment to clone the PR, gather context (CI logs, Linear issues, diff), and run code review via `opencode`. The agent decides whether to approve, request changes, comment, or skip review entirely.

Supports any LLM provider that opencode supports (DeepSeek, Anthropic, OpenAI, Google, etc). Model selection is configured via an environment variable.

## Architecture

```
GitHub Action  ──POST /review──▶  Cloudflare Worker
                                      │
                                      ├─ Create Sandbox (Docker image with gh, opencode, mise, jq)
                                      ├─ Fetch .review-agent/setup.sh from GitHub
                                      ├─ Hash setup.sh + prompt.md, check KV for cached R2 backup
                                      │   ├─ Backup exists: restore it (skip setup)
                                      │   └─ No backup: run setup.sh, store backup in R2
                                      ├─ Write agent config + entrypoint into sandbox
                                      ├─ Start entrypoint as background process
                                      │   ├─ Clone PR, gather context (CI logs, Linear, diff)
                                      │   ├─ Run `opencode run`
                                      │   └─ Agent posts review via `gh pr review`
                                      └─ Store active review in KV
                                      │
                    Cron (*/10 min) ──├─ GC: delete KV entries older than 30 minutes
```

**Worker endpoints:**

| Route | Method | Purpose |
|---|---|---|
| `/review` | POST | Start a review for a PR |
| `/cleanup` | POST | Remove completed review from KV |

## Setup

### Prerequisites

- Cloudflare Workers Paid plan ($5/month) -- required for Sandbox SDK
- Node.js 18+

### Secrets

Set via `wrangler secret put`:

```
AUTH_TOKEN             # Shared secret for worker authentication
CLOUDFLARE_ACCOUNT_ID  # Your Cloudflare account ID
GH_TOKEN               # GitHub PAT with repo access
LINEAR_API_KEY         # Linear API key (optional, for issue context)
LLM_API_KEY            # API key for the selected LLM provider
OPENCODE_MODEL         # Model in provider/model format (e.g. deepseek/deepseek-v4-pro)
REVIEW_WORKER_URL      # Deployed worker URL (e.g. https://pr-review-agent.<account>.workers.dev)
R2_ACCESS_KEY_ID       # R2 API token for backup presigned URLs
R2_SECRET_ACCESS_KEY   # R2 API token for backup presigned URLs
```

### Model Selection

The `OPENCODE_MODEL` secret selects the model using opencode's `provider/model` format (e.g. `deepseek/deepseek-v4-pro`, `anthropic/claude-sonnet-4-6`, `openai/gpt-5.5`). Make sure `LLM_API_KEY` matches the selected provider.

### KV Namespace

Create a KV namespace and update the ID in `wrangler.jsonc`:

```sh
wrangler kv namespace create KV
```

### R2 Bucket

Create the backup bucket and update the name in `wrangler.jsonc`:

```sh
wrangler r2 bucket create <your-bucket-name>
```

## Deploy

```sh
npm install
wrangler deploy
```

After the first deploy, set `REVIEW_WORKER_URL` to the deployed worker URL:

```sh
wrangler secret put REVIEW_WORKER_URL
```

## Usage

Add the composite action to your target repo's workflow:

```yaml
- uses: juanuicich/pr-review-agent-action@v1
  with:
    worker-url: ${{ vars.REVIEW_WORKER_URL }}
    worker-token: ${{ secrets.REVIEW_WORKER_TOKEN }}
```

The action sends a POST request to the worker with PR metadata and returns. The review runs asynchronously in the sandbox.

## Configuration

Target repos add a `.review-agent/` directory at the repository root:

| File | Required | Description |
|---|---|---|
| `.review-agent/setup.sh` | No | Project-specific setup script (install deps, build tools). Runs once and is cached as an R2 backup keyed on a hash of its content plus `prompt.md`. |
| `.review-agent/prompt.md` | No | Custom review instructions. Overrides the default prompt. |

The default prompt instructs the agent to read PR context, CI logs, and optional Linear issue data, then decide whether to post a review using `gh pr review`.

## Cost

- **Cloudflare Workers Paid plan**: $5/month (includes 10M requests, Durable Objects, R2, KV)
- **Sandbox SDK**: billed as Durable Object usage (included in Workers paid plan allocation)
- **LLM**: per-token pricing depends on the selected provider and model
- **R2**: minimal storage for sandbox backups (free tier covers first 10GB)

A typical review costs less than $0.05 in LLM tokens depending on PR size and model.
