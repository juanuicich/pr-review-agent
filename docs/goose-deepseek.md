# Using Goose with DeepSeek

Goose does not have a native DeepSeek provider, but DeepSeek's API is OpenAI-compatible. The trick is to use the `openai` provider with a custom host.

## Configuration

Set these environment variables:

```sh
GOOSE_PROVIDER=openai
GOOSE_MODEL=deepseek-v4-pro
OPENAI_HOST=https://api.deepseek.com
OPENAI_API_KEY=<your-deepseek-api-key>
GOOSE_DISABLE_KEYRING=1
```

## How it works

Goose's `openai` provider accepts an `OPENAI_HOST` override. When pointed at `https://api.deepseek.com`, requests go to DeepSeek's servers instead of OpenAI's. The model name (`deepseek-v4-pro`, `deepseek-chat`, etc.) is passed through as-is.

## What doesn't work

- **Custom provider files** (`~/.config/goose/custom_providers/deepseek.json`) — goose only reads these from the interactive `configure` / `session` commands, not from `goose run`. Setting `GOOSE_PROVIDER=deepseek` via env var fails with "Unknown provider".

## Testing locally

```sh
OPENAI_API_KEY=sk-xxx \
OPENAI_HOST=https://api.deepseek.com \
GOOSE_PROVIDER=openai \
GOOSE_MODEL=deepseek-v4-pro \
GOOSE_DISABLE_KEYRING=1 \
goose run --no-session -t "Say hello in one word"
```

## For the pr-review-agent

The `parseGooseModel` function in `src/index.ts` detects the `deepseek` provider from the `GOOSE_MODEL` env var (format: `provider/model`) and sets the env vars accordingly:

```
GOOSE_MODEL=deepseek/deepseek-v4-pro
```

becomes:

```
GOOSE_PROVIDER=openai
GOOSE_MODEL=deepseek-v4-pro
OPENAI_HOST=https://api.deepseek.com
OPENAI_API_KEY=<LLM_API_KEY>
```

## Other OpenAI-compatible providers

The same pattern works for any OpenAI-compatible API. Set `GOOSE_PROVIDER=openai` and override `OPENAI_HOST` to the provider's base URL:

| Provider | OPENAI_HOST |
|---|---|
| DeepSeek | `https://api.deepseek.com` |
| Together AI | `https://api.together.xyz` |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` |
| Groq | `https://api.groq.com/openai/v1` |
