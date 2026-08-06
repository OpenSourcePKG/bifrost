<p align="center">
  <img src="assets/logo.svg" alt="Bifröst" width="180">
</p>

<h1 align="center">Bifröst</h1>

<p align="center">
  <b>The rainbow bridge between Claude Code and MimirMind.</b><br>
  A tiny, dependency-light proxy that speaks the <b>Anthropic Messages API</b> on the front
  and the <b>OpenAI chat-completions API</b> on the back — so you can drive
  <a href="https://claude.com/claude-code">Claude Code</a> against a
  <a href="https://github.com/OpenSourcePKG">MimirMind</a> inference server.
</p>

---

## Why

Claude Code talks the **Anthropic Messages API** (`POST /v1/messages`). MimirMind's
`serve` exposes only the **OpenAI** surface (`POST /v1/chat/completions`). Bifröst sits
between them and translates in both directions — including **SSE streaming** and
**tool calls**, the two places these bridges usually break.

```
   Claude Code                    Bifröst                         MimirMind
 ┌──────────────┐   Anthropic   ┌───────────┐   OpenAI        ┌──────────────────┐
 │  /v1/messages │ ───────────▶ │ translate │ ─────────────▶ │ /v1/chat/         │
 │  (streaming,  │ ◀─────────── │  ⇄  SSE   │ ◀───────────── │   completions     │
 │   tool_use)   │   Anthropic   └───────────┘   OpenAI        │  (Qwen3.6, …)    │
 └──────────────┘      SSE                          SSE        └──────────────────┘
```

The upstream model can be anything MimirMind serves — the reference target is
**Qwen3.6-35B-A3B (NVFP4)** running serving-class on a DGX Spark.

## Requirements

- **Node.js ≥ 20** (ESM only)
- A running MimirMind server reachable over HTTP(S)

## Quickstart

```bash
npm install
cp .env.example .env      # edit UPSTREAM_BASE_URL / UPSTREAM_API_KEY
npm run dev               # hot-reload dev server (tsx)
```

Or built:

```bash
npm run build && npm run serve
```

Sanity check:

```bash
curl http://localhost:8787/health
# {"status":"ok","upstream":"http://localhost:8080/v1"}
```

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)):

| Variable            | Default                     | Purpose                                                              |
| ------------------- | --------------------------- | ------------------------------------------------------------------- |
| `PORT`              | `8787`                      | Port Bifröst listens on.                                            |
| `UPSTREAM_BASE_URL` | `http://localhost:8080/v1`  | MimirMind OpenAI base URL (**must include `/v1`**).                 |
| `UPSTREAM_API_KEY`  | —                           | Bearer token forwarded to MimirMind.                               |
| `CLIENT_API_KEY`    | —                           | If set, clients must present it (`x-api-key` / `Authorization`).    |
| `UPSTREAM_MODEL`    | —                           | Force every request onto this model id. Empty = pass client's through. |
| `DEFAULT_MAX_TOKENS`| `1024`                      | Fallback when the client omits `max_tokens`.                        |
| `LOG_LEVEL`         | `info`                      | `debug` \| `info` \| `silent`.                                      |

## Point Claude Code at Bifröst

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_AUTH_TOKEN=whatever      # matched against CLIENT_API_KEY, if set
export ANTHROPIC_MODEL=qwen3.6-35b-a3b     # or leave UPSTREAM_MODEL to force it
claude
```

> The exact auth env var (`ANTHROPIC_AUTH_TOKEN` vs `ANTHROPIC_API_KEY`) can differ by
> Claude Code version — `ANTHROPIC_BASE_URL` is the stable one. If auth is rejected,
> try the other, or leave `CLIENT_API_KEY` empty for a fully open local bridge.

## Endpoints

| Method & path                 | Purpose                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `POST /v1/messages`           | Main bridge. Non-streaming and `stream:true` both supported.    |
| `POST /v1/messages/count_tokens` | Rough token estimate (char/4) for the context UI.           |
| `GET  /v1/models`             | Proxied from upstream (empty list on failure).                 |
| `GET  /health`                | Liveness + resolved upstream.                                  |

## How the translation works

- **System prompt** — Anthropic's top-level `system` becomes a leading `system` message.
- **Tool calls** — Anthropic `tool_use` blocks ⇄ OpenAI `tool_calls`; a user turn's
  `tool_result` blocks become dedicated `role:"tool"` messages placed directly after the
  assistant call, so ordering stays valid.
- **Tools** — `{name, description, input_schema}` ⇄ `{type:"function", function:{…, parameters}}`;
  `tool_choice` `auto` / `any` / `tool` ⇄ `auto` / `required` / `{function}`.
- **Streaming** — OpenAI delta chunks are re-emitted as the Anthropic SSE sequence
  (`message_start → content_block_* → message_delta → message_stop`), with streamed tool-call
  argument fragments mapped to `input_json_delta`. Content-block indices are tracked here.
- **Stop reasons** — `stop → end_turn`, `length → max_tokens`, `tool_calls → tool_use`.

Unknown Anthropic content-block types (images, thinking) are tolerated — the upstream
reference model is text-only, so images are replaced with a placeholder note.

## Project layout

```
src/
  server.ts             # Hono app: /v1/messages, /count_tokens, /models, /health
  config.ts             # env-driven config
  types.ts              # request/response types + vts structural validation
  translate/
    request.ts          # Anthropic  → OpenAI
    response.ts         # OpenAI     → Anthropic  (non-streaming)
    stream.ts           # OpenAI SSE → Anthropic SSE  (core)
    maps.ts             # stop_reason / tool_choice / id helpers
```

## Status

Early but working: request/response/streaming and tool calls are wired and tested.
Runtime type checking uses [**vts**](https://github.com/OpenSourcePKG/vts).

## License

See [LICENSE](LICENSE).