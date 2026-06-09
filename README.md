# pr-review-agent

AI-powered code review agent that runs on Cloudflare Workers. A GitHub Action triggers the worker, which spins up a sandboxed environment to clone the PR, gather context (CI logs, Linear issues, diff), and run code review via `goose`. The agent decides whether to approve, request changes, comment, or skip review entirely.

Supports any LLM provider that goose supports (DeepSeek, Anthropic, OpenAI, Google, etc). Model selection is configured via an environment variable.

## Architecture

```
GitHub Action  ──POST /review──▶  Cloudflare Worker
                                      │
                                       ├─ Create Sandbox (Docker image with gh, goose, mise, jq)
                                      ├─ Fetch .review-agent/setup.sh from GitHub
                                      ├─ Hash setup.sh + prompt.md, check KV for cached R2 backup
                                      │   ├─ Backup exists: restore it (skip setup)
                                      │   └─ No backup: run setup.sh, store backup in R2
                                      ├─ Write agent config + entrypoint into sandbox
                                      ├─ Start entrypoint as background process
                                      │   ├─ Clone PR, gather context (CI logs, Linear, diff)
                                       │   ├─ Run `goose run`
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

### Configuration

Copy the wrangler template and fill in the resource IDs:

```sh
cp wrangler.jsonc.example wrangler.jsonc
```

Create a KV namespace (name is account-scoped, pick anything):

```sh
wrangler kv namespace create pr-review-agent-kv
```

Create an R2 bucket (name must be globally unique across all Cloudflare accounts):

```sh
wrangler r2 bucket create <your-unique-bucket-name>
```

Paste the returned KV namespace ID and your chosen bucket name into the GitHub repo variables `CF_KV_NAMESPACE_ID` and `CF_R2_BUCKET_NAME`. The CI workflow injects them into the config at deploy time.

### Secrets

**GitHub** (only `CLOUDFLARE_API_TOKEN` is needed for CI):

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | [Cloudflare Dashboard > API Tokens > Create Token](https://dash.cloudflare.com/profile/api-tokens) -- use "Edit Cloudflare Workers" template |

**Worker** (set via `npx wrangler secret put <NAME> --name pr-review-agent`):

| Secret | Where to get it |
|---|---|
| `AUTH_TOKEN` | Generate one: `openssl rand -hex 32` |
| `LINEAR_API_KEY` | [Linear Settings > API > Personal API Keys](https://linear.app/settings/account/security) |
| `LLM_API_KEY` | Your LLM provider's dashboard (e.g. Anthropic, OpenAI, DeepSeek) |
| `GOOSE_MODEL` | Not a secret -- set via `wrangler secret put` or as a Worker var. Format: `provider/model` (e.g. `anthropic/claude-sonnet-4-6`) |
| `REVIEW_WORKER_URL` | Set after first deploy (e.g. `https://pr-review-agent.<account>.workers.dev`) |

**GitHub authentication** — choose one:

| Secret | Description |
|---|---|
| `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` | **(Recommended)** Auto-generates installation tokens so reviews post as the bot (`app-name[bot]`). See [Creating a GitHub App](#creating-a-github-app) below. |
| `GH_TOKEN` | **(Fallback)** A personal access token. Works but reviews post under your personal GitHub user. [GitHub Settings > Developer settings > Fine-grained tokens](https://github.com/settings/personal-access-tokens/new) with: **Contents** (Read), **Pull requests** (Read and write), **Actions** (Read). |

If both are set, the App takes precedence.

### Creating a GitHub App

To post reviews under a bot identity instead of your personal account:

1. Go to **GitHub Settings > Developer settings > GitHub Apps > New GitHub App**
2. Configure:
   - **GitHub App name:** `pr-review-agent` (or any name — this becomes the bot username)
   - **Homepage URL:** your repo URL or any valid URL
   - **Webhook:** uncheck "Active" (not needed)
   - **Callback URL:** leave blank
   - **Expire user authorization tokens:** check this box (disables user-to-server OAuth)
3. Permissions:
   - **Contents:** Read-only
   - **Pull requests:** Read and write
   - **Actions:** Read-only
4. **Where can this GitHub App be installed?** — choose "Any account"
5. Click **Create GitHub App**
6. Note the **App ID** at the top of the settings page
7. Scroll to **Private keys** and click **Generate a private key** — save the `.pem` file
8. **Install the App** on your organization/repo:
   - Go to **Install App** in the sidebar
   - Select your organization
   - Choose "Only select repositories" and pick the target repo(s)
9. Set the secrets on the worker:

```sh
wrangler secret put GITHUB_APP_ID       # paste the App ID
wrangler secret put GITHUB_APP_PRIVATE_KEY  # paste the full PEM file
```

The worker auto-generates a fresh installation token on each review. The installation ID is cached in KV for 7 days.

## Deploy

Pushes to `main` auto-deploy via GitHub Actions. Set these in the repo's GitHub settings:

**Repository variables** (Settings > Variables and secrets > Actions > Variables):

| Variable | Description |
|---|---|
| `CF_KV_NAMESPACE_ID` | KV namespace ID from `wrangler kv namespace create KV` |
| `CF_R2_BUCKET_NAME` | R2 bucket name from `wrangler r2 bucket create <name>` |

**Repository secrets** (Settings > Variables and secrets > Actions > Secrets):

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers edit permissions |

The CI workflow copies `wrangler.jsonc.example`, replaces the placeholders with the repo variables, and runs `wrangler deploy`.

### Manual deploy

```sh
cp wrangler.jsonc.example wrangler.jsonc
# fill in KV namespace ID and R2 bucket name
npm install
wrangler deploy
```

After the first deploy, set `REVIEW_WORKER_URL`:

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
