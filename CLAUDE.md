## Project

**Bifröst** is a small, dependency-light **API bridge**: it speaks the
**Anthropic Messages API** (`POST /v1/messages`) on the front and the
**OpenAI chat-completions API** (`POST /v1/chat/completions`) on the back.
Its job is to let **Claude Code** drive a **MimirMind** inference server —
which only exposes the OpenAI surface — including **SSE streaming** and
**tool calls**, the two places these bridges usually break.

The reference upstream model is **Qwen3.6-35B-A3B (NVFP4)** running
serving-class on a DGX Spark. Bifröst itself is model-agnostic: it forwards
to whatever MimirMind serves.

Sister project: **MimirMind** (C++ inference engine, separate repo) — the
upstream this bridge targets. Part of the `OpenSourcePKG` family alongside
`pegenaut`.

## Codebase Conventions

- **Language:** TypeScript, **ESM only** (`"type": "module"`), Node.js ≥ 20.
- **Web framework:** [Hono](https://hono.dev) (`@hono/node-server`, `hono/streaming`).
- **Runtime validation:** [**vts**](https://github.com/OpenSourcePKG/vts)
  (`Vts.isString` / `Vts.isObject` / `Vts.isArray`, schema builders).
  **Do not add zod or another validator** — vts is the house library.
- **Module imports:** relative imports use the `.js` extension (NodeNext
  resolution), even from `.ts` sources.
- **Style:** 4-space indent, double quotes, semicolons, `strict` TypeScript.
  Prefer explicit interfaces over `any`; where external payloads are
  untyped, validate the fields you read and cast once at the boundary.
- **English only** in source, comments, and log lines.
- **Tolerant translation:** unknown Anthropic content-block types (images,
  thinking, future kinds) must never hard-fail the bridge — switch on
  `block.type` and pass through / drop gracefully.

## Layout

```
src/
  server.ts             # Hono app: /v1/messages, /v1/messages/count_tokens, /v1/models, /health
  config.ts             # env-driven config (loadConfig)
  types.ts              # request/response types + vts structural validation
  translate/
    request.ts          # Anthropic  → OpenAI
    response.ts         # OpenAI     → Anthropic  (non-streaming)
    stream.ts           # OpenAI SSE → Anthropic SSE  (the core; index-tracked)
    maps.ts             # stop_reason / tool_choice / id helpers
assets/logo.svg         # bronze bridge medallion, sibling of the MimirMind mark
```

## Commands

- `npm run dev` — hot-reload dev server (tsx).
- `npm run build` — `tsc` to `dist/`.
- `npm run serve` — run built `dist/server.js` (no esbuild needed).
- `npm run typecheck` — `tsc --noEmit`.

> If `tsx` (dev/start) fails on a missing esbuild binary, approve the install
> script: `npm install-scripts approve esbuild`. The `build` + `serve` path
> does not need esbuild.

## The translation contract (core knowledge)

Request **Anthropic → OpenAI** (`translate/request.ts`):
- top-level `system` → a leading `{role:"system"}` message.
- assistant `tool_use` block → `tool_calls[]` (`arguments` = `JSON.stringify(input)`).
- user `tool_result` block → its **own** `{role:"tool", tool_call_id, content}`
  message, emitted **directly after** the assistant's tool_calls (ordering matters);
  free user text becomes a trailing `user` message.
- `tools[] {name, description, input_schema}` → `{type:"function", function:{…, parameters}}`.
- `tool_choice` `auto` / `any` / `tool` / `none` → `auto` / `required` / `{function}` / `none`.

Response **OpenAI → Anthropic** (`translate/response.ts`):
- `message.content` → `{type:"text"}`; `tool_calls[]` → `{type:"tool_use", input: JSON.parse(args)}`.
- `finish_reason` → `stop_reason`: `stop→end_turn`, `length→max_tokens`, `tool_calls→tool_use`.

Streaming **OpenAI SSE → Anthropic SSE** (`translate/stream.ts`):
- Emit the exact sequence `message_start → ping → (content_block_start/delta/stop)* → message_delta → message_stop`.
- Text deltas → `text_delta`; streamed tool-call argument fragments → `input_json_delta` (`partial_json`).
- **Content-block indices are tracked in the bridge** — OpenAI does not send them.

When changing translation logic, verify against a realistic payload that
includes a tool_use round-trip and a streamed tool call (see the smoke tests
used during bring-up).

## Configuration

Env-driven (`.env.example`): `PORT`, `UPSTREAM_BASE_URL` (must include `/v1`),
`UPSTREAM_API_KEY`, `CLIENT_API_KEY`, `UPSTREAM_MODEL`, `DEFAULT_MAX_TOKENS`,
`LOG_LEVEL`. Claude Code points at Bifröst via `ANTHROPIC_BASE_URL`; the exact
auth env var (`ANTHROPIC_AUTH_TOKEN` vs `ANTHROPIC_API_KEY`) can differ by
Claude Code version.

## Memory (Synaipse)

This project is Synaipse-scoped to **`bifrost`** via `.mcp.json`
(`X-Synaipse-Project: bifrost`) — notes land in `Memory/bifrost/`. Reach
Synaipse **only through the MCP tools**, never the vault on disk.

- Before non-trivial work: `synaipse_search` / `synaipse_prime` for prior
  decisions, known issues, and the translation-contract notes.
- After: store new decisions, gotchas (especially streaming/tool-call edge
  cases and Claude-Code compatibility quirks), and lessons learned; link
  related notes.

## Guardrails

- **No `git push`** on the user's behalf — commits are fine when asked, push
  is the user's.
- Keep the bridge **thin**: translation and transport only. Business logic,
  model behaviour, and weights belong in MimirMind, not here.
- Match the **MimirMind visual identity** for any brand asset (navy `#1A2A4A`
  → `#06091A` medallion, bronze `#E8B968` → `#8C5E20`, runic frame).