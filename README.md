# DeepSeek API Proxy — OpenAI-compatible gateway for DeepSeek web chat

Turns the free chat at [chat.deepseek.com](https://chat.deepseek.com) into a local, **OpenAI-compatible API** — no API key, no credits, no paid plan. Sign in with your DeepSeek account(s) once, then call the API from any OpenAI client, including coding agents such as [opencode](https://opencode.ai).

> **Unofficial project.** Not affiliated with or endorsed by DeepSeek. It automates the consumer DeepSeek web experience, so use it responsibly, at your own risk, and within DeepSeek's terms of service. Use **dedicated accounts**, not your personal one.

---

## Features

- **OpenAI-compatible API** — `POST /v1/chat/completions` (streaming + non-streaming) and `GET /v1/models`
- **Tool calling** — full agent-loop support: tool-call emission, tool-result round-trip, and continuation (works with opencode and similar agents)
- **Multi-account rotation** — spreads load across accounts, with per-account pacing and automatic mute/suspension detection
- **Browser-based login** — handles DeepSeek's WAF challenges and proof-of-work automatically
- **Web dashboard** — manage accounts, view logs and usage at `http://localhost:26406/dashboard`

---

## Requirements

- **[Bun](https://bun.sh)** 1.x (`curl -fsSL https://bun.sh/install | bash`)
- **DeepSeek accounts** — 1 works, **3+ recommended** for rotation headroom
- macOS, Linux, or Windows (WSL)

---

## Quick start

```bash
git clone https://github.com/Chumdararith-LOU/deepseek_API_proxy.git
cd deepseek_API_proxy
bun install          # installs deps + browser binaries
bun run start        # starts the gateway on port 26406
```

Then open **http://localhost:26406/dashboard** → **Accounts** → **Add Account**, and enter your DeepSeek email + password. Login runs automatically in a headless browser.

Verify it works:

```bash
curl http://localhost:26406/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Hello!"}]}'
```

---

## Adding accounts

Pick one of three methods:

**1. Dashboard (recommended)** — http://localhost:26406/dashboard/accounts → *Add Account*

**2. API**

```bash
curl -X POST http://localhost:26406/api/accounts \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'
```

On **Windows PowerShell** (`curl` is aliased to `Invoke-WebRequest`, which rejects these flags — use this instead):

```powershell
Invoke-RestMethod -Method POST http://localhost:26406/api/accounts -ContentType 'application/json' -Body '{"email":"you@example.com","password":"your-password"}'
```

**3. Environment variables** — format `ACCOUNTn=email:password`:

```bash
ACCOUNT1=a@example.com:pass1 ACCOUNT2=b@example.com:pass2 bun run start
```

Passwords are encrypted at rest in `.deepseek/` (local only, git-ignored). Check status any time at `GET /health`.

---

## Using the API

Any OpenAI client works — just point `baseURL` at `http://localhost:26406/v1`.

**Python (openai SDK)**

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:26406/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

**opencode (coding agent)** — add to `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "deepseek-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:26406/v1" },
      "models": {
        "deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash",
          "limit": { "context": 1000000, "output": 384000 }
        },
        "deepseek-v4-pro": {
          "name": "DeepSeek V4 Pro",
          "limit": { "context": 1000000, "output": 384000 }
        }
      }
    }
  }
}
```

**Endpoints**

| Method | Path                   | Description                          |
| ------ | ---------------------- | ------------------------------------ |
| POST   | `/v1/chat/completions` | Chat (streaming + non-streaming, tool calls) |
| GET    | `/v1/models`           | List available models                |
| GET    | `/health`              | Health + account status              |
| GET    | `/dashboard`           | Web dashboard                        |

---

## Models

| Model               | DeepSeek web mode | Notes                            |
| ------------------- | ----------------- | -------------------------------- |
| `deepseek-v4-flash` | default           | Faster, higher message allowance — best for agent loops |
| `deepseek-v4-pro`   | expert            | Stronger reasoning / tool-call compliance, tighter quota |

Append `-no-thinking` (e.g. `deepseek-v4-flash-no-thinking`) to disable reasoning output.

---

## Rate limits & account protection

DeepSeek's web chat throttles accounts that send messages too fast ("Messages too frequent") and can **mute or suspend** accounts that burst. This gateway protects you with:

- **Per-account pacing** — enforces a minimum gap between messages per account (`CHAT_MIN_INTERVAL_MS`, default **10s**)
- **Mute/suspension detection** — muted accounts are detected from the upstream response, throttled until their mute expires, and requests rotate to the next account
- **Round-robin rotation** — requests spread across all non-throttled accounts automatically

**Best practices:** use 3+ dedicated accounts, keep pacing enabled, and never send bursts of requests back-to-back.

---

## Configuration

Settings live in `config.json` (auto-created on first run) or environment variables. Key options:

| Key                       | Default  | Description                              |
| ------------------------- | -------- | ---------------------------------------- |
| `PORT`                    | `26406`  | Gateway port                             |
| `API_KEY`                 | *(empty)*| If set, all endpoints require `Authorization: Bearer <key>` |
| `TOOL_CALLING`            | `true`   | Enable tool-call support                 |
| `CLEAN_OUTPUT`            | `true`   | Strip internal markup from output        |
| `STREAMING_MODE`          | `auto`   | `auto` / `stream` / `non-stream`         |
| `CHAT_MIN_INTERVAL_MS`    | `10000`  | Minimum ms between messages per account  |
| `RATE_LIMIT_COOLDOWN_MS`  | `120000` | Cooldown when an account is throttled    |
| `DELETE_SESSION`          | `true`   | Delete DeepSeek chat sessions after use  |
| `RETRY_MAX_ATTEMPTS`      | `3`      | Upstream retry attempts                  |

---

## Development

```bash
bun run dev        # start with auto-reload
bun test           # run unit tests
bun run typecheck  # TypeScript check
bun run lint       # biome lint
```

**Project layout**

| Path        | Description                                    |
| ----------- | ---------------------------------------------- |
| `src/`      | TypeScript gateway (Hono + Bun)                |
| `test/`     | Unit tests                                     |
| `bin/dsg`   | CLI launcher                                   |
| `.deepseek/`| Local account state (git-ignored, never commit)|
| `server/`, `deepseek/`, `examples/` | Legacy Python reference implementation |

---

## Credits

Based on [sums001/Deepseek-API](https://github.com/sums001/Deepseek-API).

## License

Released under the [MIT License](LICENSE). As this is an unofficial project, you remain responsible for complying with DeepSeek's terms of service.
