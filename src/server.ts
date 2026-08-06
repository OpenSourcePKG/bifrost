import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { loadConfig } from "./config.js";
import { translateRequest } from "./translate/request.js";
import { translateResponse } from "./translate/response.js";
import { anthropicSSE } from "./translate/stream.js";
import { validateAnthropicRequest } from "./types.js";
import type { OpenAIResponse } from "./types.js";

const cfg = loadConfig();
const app = new Hono();

function log(level: "debug" | "info", ...args: unknown[]): void {
    if (cfg.logLevel === "silent") return;
    if (level === "debug" && cfg.logLevel !== "debug") return;
    console.log("[bifrost]", ...args);
}

function anthErr(type: string, message: string) {
    return { type: "error", error: { type, message } };
}

function clientKeyOk(c: Context): boolean {
    if (!cfg.clientApiKey) return true;
    const fromKey = c.req.header("x-api-key");
    const fromAuth = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    return fromKey === cfg.clientApiKey || fromAuth === cfg.clientApiKey;
}

function upstreamHeaders(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (cfg.upstreamApiKey) h.authorization = `Bearer ${cfg.upstreamApiKey}`;
    return h;
}

/** Rough char/4 token estimate — used for the usage fields Claude Code shows. */
function estimateTokens(body: unknown): number {
    let chars = 0;
    const walk = (x: unknown): void => {
        if (typeof x === "string") chars += x.length;
        else if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") Object.values(x).forEach(walk);
    };
    walk(body);
    return Math.max(1, Math.round(chars / 4));
}

app.get("/health", (c) => c.json({ status: "ok", upstream: cfg.upstreamBaseUrl }));

app.post("/v1/messages", async (c) => {
    if (!clientKeyOk(c)) return c.json(anthErr("authentication_error", "invalid API key"), 401);

    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        return c.json(anthErr("invalid_request_error", "invalid JSON body"), 400);
    }

    const check = validateAnthropicRequest(body);
    if (!check.ok) return c.json(anthErr("invalid_request_error", check.error), 400);

    const areq = check.value;
    const oreq = translateRequest(areq, cfg);
    log("debug", `→ ${oreq.model} (${oreq.messages.length} msgs, stream=${!!areq.stream})`);

    let upstream: Response;
    try {
        upstream = await fetch(`${cfg.upstreamBaseUrl}/chat/completions`, {
            method: "POST",
            headers: upstreamHeaders(),
            body: JSON.stringify(oreq),
        });
    } catch (e) {
        return c.json(anthErr("api_error", `upstream unreachable: ${(e as Error).message}`), 502);
    }

    if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        log("info", `upstream ${upstream.status}: ${text.slice(0, 300)}`);
        const status = (upstream.status >= 400 ? upstream.status : 502) as ContentfulStatusCode;
        return c.json(anthErr("api_error", `upstream ${upstream.status}: ${text.slice(0, 500)}`), status);
    }

    if (areq.stream) {
        const est = estimateTokens(body);
        return streamSSE(c, async (stream) => {
            for await (const ev of anthropicSSE(upstream, oreq.model, est)) {
                await stream.writeSSE(ev);
            }
        });
    }

    const data = (await upstream.json()) as OpenAIResponse;
    return c.json(translateResponse(data, oreq.model));
});

app.post("/v1/messages/count_tokens", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ input_tokens: estimateTokens(body) });
});

app.get("/v1/models", async (c) => {
    try {
        const r = await fetch(`${cfg.upstreamBaseUrl}/models`, { headers: upstreamHeaders() });
        if (r.ok) return c.json(await r.json());
    } catch {
        /* fall through to empty list */
    }
    return c.json({ object: "list", data: [] });
});

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
    log("info", `listening on http://localhost:${info.port}  →  upstream ${cfg.upstreamBaseUrl}`);
});
