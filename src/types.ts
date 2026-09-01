import { Vts } from "vts";

/* ------------------------------------------------------------------ *
 * Anthropic Messages API — incoming (from Claude Code)
 * ------------------------------------------------------------------ */

export interface AnthMessage {
    // Claude Code interleaves system-reminders as `role:"system"` messages in
    // the array, so the bridge accepts them alongside user/assistant.
    role: "user" | "assistant" | "system";
    content: string | AnthBlock[];
}

export interface AnthropicRequest {
    model: string;
    messages: AnthMessage[];
    system?: string | Array<{ type: string; text?: string }>;
    max_tokens?: number;
    stop_sequences?: string[];
    temperature?: number;
    top_p?: number;
    top_k?: number;
    tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
    tool_choice?: unknown;
    stream?: boolean;
    metadata?: unknown;
}

export interface AnthTextBlock {
    type: "text";
    text: string;
}
export interface AnthToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
}
export interface AnthToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string | unknown[];
    is_error?: boolean;
}
export type AnthBlock =
    | AnthTextBlock
    | AnthToolUseBlock
    | AnthToolResultBlock
    | { type: string; [k: string]: unknown };

/* ------------------------------------------------------------------ *
 * Lightweight structural validation (no runtime schema dependency).
 * We only assert the fields the bridge actually reads; unknown block
 * types are tolerated and handled with explicit `type` switches so new
 * Anthropic block kinds never hard-fail the bridge.
 * ------------------------------------------------------------------ */

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateAnthropicRequest(body: unknown): Validated<AnthropicRequest> {
    if (!Vts.isObject(body)) return { ok: false, error: "body must be a JSON object" };
    const b = body as Record<string, unknown>;

    if (!Vts.isString(b.model)) return { ok: false, error: "`model` must be a string" };
    if (!Vts.isArray(b.messages)) return { ok: false, error: "`messages` must be an array" };

    for (let i = 0; i < b.messages.length; i++) {
        const m = b.messages[i];
        if (!Vts.isObject(m)) return { ok: false, error: `messages[${i}] must be an object` };
        const mm = m as Record<string, unknown>;
        if (mm.role !== "user" && mm.role !== "assistant" && mm.role !== "system") {
            return { ok: false, error: `messages[${i}].role must be "user", "assistant" or "system"` };
        }
        if (!Vts.isString(mm.content) && !Vts.isArray(mm.content)) {
            return { ok: false, error: `messages[${i}].content must be a string or an array of blocks` };
        }
    }

    if (b.tools !== undefined && !Vts.isArray(b.tools)) {
        return { ok: false, error: "`tools` must be an array" };
    }
    if (b.max_tokens !== undefined && !Vts.isNumber(b.max_tokens)) {
        return { ok: false, error: "`max_tokens` must be a number" };
    }

    // Structurally sound for every field the bridge reads. Unknown block
    // types inside content are tolerated and handled downstream.
    return { ok: true, value: body as unknown as AnthropicRequest };
}

/* ------------------------------------------------------------------ *
 * OpenAI chat-completions — outgoing (to MimirMind)
 * ------------------------------------------------------------------ */

export interface OpenAITool {
    type: "function";
    function: { name: string; description?: string; parameters?: unknown };
}
export interface OpenAIToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}
/** OpenAI multimodal content part (text or an image URL, incl. data: URLs). */
export type OpenAIContentPart =
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } };

export type OpenAIMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string | OpenAIContentPart[] }
    | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
    | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAIRequest {
    model: string;
    messages: OpenAIMessage[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string[];
    stream?: boolean;
    stream_options?: { include_usage: boolean };
    tools?: OpenAITool[];
    tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
}

export interface OpenAIResponse {
    id?: string;
    model?: string;
    choices?: Array<{
        index?: number;
        message?: {
            role?: string;
            content?: string | null;
            tool_calls?: OpenAIToolCall[];
        };
        finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}
