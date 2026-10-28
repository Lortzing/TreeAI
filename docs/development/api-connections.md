# API connections

Studio accepts API-key connections through `--api-config FILE`. Configure providers and model IDs in JSON, then select one at startup. No account sign-in, OAuth, subscription session or token-plan credential import is provided by this configuration path. The URL can point to an official API, an API-compatible service or a local proxy. A proxy's upstream billing/routing is outside TreeAI's visibility.

## Studio settings

Open **API 设置** in the top bar. Choose or add a provider/model, edit its API format,
URL, key environment variable and token limits. The advanced JSON editor also
supports headers and multiple profiles; IDs can be renamed there. **测试连接**
sends a small fixed request through the actual Pi SDK in a temporary session. It
does not send saved conversations or change the active model. Tests are bounded
to 25 seconds and their temporary files are removed. Closing the dialog cancels
the browser request; the server probe still has its bounded cleanup deadline.

**保存设置** writes only profile metadata and environment references to
`<data>/api-settings.json`. Changes apply after restart. Supply any required key
environment variables to that process first. Missing variables are shown by name;
there is no browser key storage, token-plan login, or system keychain integration.
Saving profiles is allowed while a key is missing so they can be prepared before
the environment is set; startup and connection tests still fail explicitly.

Restart with the same data directory to use the saved selection:

```sh
npm run start --workspace @treeai/studio -- --data /absolute/path/treeai-data
```

Explicit `--api-config` or `--agent-dir` selects the CLI configuration instead of
saved Studio settings. Explicit `--provider` / `--model` overrides saved selection.
An explicit `--driver echo` opens an offline recovery instance; saved product
facts remain available and a corrupt settings file can be replaced from the
settings page. Old conversations keep their stored model identity. API settings
requests are local, same-origin, uncached; writes require a custom request header
and stale concurrent edits are rejected.

```sh
npm run start --workspace @treeai/studio -- \
  --driver pi --api-config /absolute/path/api-providers.json \
  --provider local-api --model claude-haiku-4-5 \
  --data /absolute/path/treeai-data
```

`--api-config` cannot be combined with `--agent-dir`. It creates a controlled `api-agent/` inside the data directory. Main and terminology runtimes use these API profiles. Existing conversations keep their saved model identity; switching the startup model applies to new sessions, not a rewrite of old sessions.

The repository's [local proxy example](../../examples/api-providers.example.json) targets `http://127.0.0.1:15722`. The supplied CC Switch proxy ignores client authentication; for that proxy only, a nonsecret placeholder can satisfy the API client's key requirement:

```sh
export TREEAI_LOCAL_API_KEY=local-proxy-client
```

For a service that authenticates API keys, populate the named environment variable from your secret manager or a hidden shell prompt before starting Studio. Never paste keys into JSON, flags, commits or logs. Studio stores environment references in the generated Pi configuration; key values stay in process memory. No credentials are imported from `~/.pi` or another application's settings.

## Formats and profiles

| `api` | Interface | Typical base URL shape |
| --- | --- | --- |
| `anthropic-messages` | Anthropic Messages | `https://api.anthropic.com` or a compatible proxy |
| `openai-completions` | OpenAI Chat Completions | `https://api.openai.com/v1` or a compatible API |
| `openai-responses` | OpenAI Responses | `https://api.openai.com/v1` or a compatible API |
| `google-generative-ai` | Gemini API key interface | API base URL required by your service |

These are the supported wire formats in the pinned Pi adapter. An endpoint must implement its selected format; an arbitrary service-specific protocol is not automatically compatible. No live claim is made for providers that have not been tested against their actual service.

```json
{
  "providers": {
    "company-chat": {
      "api": "openai-completions",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "COMPANY_API_KEY",
      "headerEnv": { "X-Client-Name": "COMPANY_CLIENT_NAME" },
      "models": [
        { "id": "model-from-your-service", "contextWindow": 32768, "maxTokens": 4096, "reasoning": false, "input": ["text"] }
      ]
    }
  }
}
```

Add providers to the `providers` object and models to each provider's `models` array. Select `--provider` / `--model`; use `--terminology-provider` / `--terminology-model` for a separately configured terminology model. All declared key/header environment variables must be present at startup. Optional `headerEnv` values are environment variable names, never raw header secrets or shell commands.

Each model requires `id`; optional `name`, positive `contextWindow` (default 32768), `maxTokens` (default 4096), `reasoning` (default false), and `input` (`text`, optionally `image`) describe the API's actual capabilities. Confirm limits with your provider. Unknown fields, inline keys, OAuth/token fields, invalid selections and unsupported formats fail before product storage is opened. Remote URLs require HTTPS; loopback HTTP is supported. URL credentials, query strings and fragments are rejected.

Configuration is applied on process restart. Tools remain disabled unless explicitly enabled with the existing controlled tool flags. The legacy `--agent-dir` startup remains available for existing installations; `--api-config` needs no manually maintained Pi configuration files.
