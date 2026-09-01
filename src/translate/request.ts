import type { Config } from "../config.js";
import type {
    AnthBlock,
    AnthropicRequest,
    OpenAIContentPart,
    OpenAIMessage,
    OpenAIRequest,
    OpenAITool,
    OpenAIToolCall,
} from "../types.js";
import { mapToolChoice } from "./maps.js";

/** Anthropic image block -> an OpenAI image_url (data: URL for base64, else the url), or null. */
function imageToUrl(block: unknown): string | null {
    const source = (block as { source?: { type?: string; media_type?: string; data?: string; url?: string } }).source;
    if (!source) return null;
    if (source.type === "base64" && source.data) {
        return `data:${source.media_type ?? "image/png"};base64,${source.data}`;
    }
    if (source.type === "url" && source.url) return source.url;
    return null;
}

function systemToString(system: AnthropicRequest["system"]): string | null {
    if (!system) return null;
    if (typeof system === "string") return system;
    const text = system
        .filter((b): b is { type: string; text?: string } => !!b && (b as { type?: string }).type === "text")
        .map((b) => b.text ?? "")
        .join("\n\n");
    return text.length ? text : null;
}

function toolResultToString(content: string | unknown[]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content ?? "");
    const parts: string[] = [];
    for (const b of content) {
        const block = b as { type?: string; text?: string };
        if (block?.type === "text") parts.push(block.text ?? "");
        else if (block?.type === "image") parts.push("[image — see next message]");
        else parts.push(typeof b === "string" ? b : JSON.stringify(b));
    }
    return parts.join("\n");
}

/** Collect image URLs from a tool_result's content blocks (OpenAI tool messages can't carry images). */
function toolResultImages(content: string | unknown[]): string[] {
    if (!Array.isArray(content)) return [];
    const urls: string[] = [];
    for (const b of content) {
        if ((b as { type?: string }).type === "image") {
            const url = imageToUrl(b);
            if (url) urls.push(url);
        }
    }
    return urls;
}

/** Translate an Anthropic Messages request into an OpenAI chat-completions request. */
export function translateRequest(req: AnthropicRequest, cfg: Config): OpenAIRequest {
    const messages: OpenAIMessage[] = [];

    const sys = systemToString(req.system);
    if (sys) messages.push({ role: "system", content: sys });

    for (const msg of req.messages) {
        if (typeof msg.content === "string") {
            messages.push({ role: msg.role, content: msg.content } as OpenAIMessage);
            continue;
        }

        const blocks = msg.content as AnthBlock[];

        if (msg.role === "system") {
            // Claude Code's inline system-reminders stay system messages.
            const text = blocks
                .filter((b): b is { type: string; text?: string } => (b as { type?: string }).type === "text")
                .map((b) => b.text ?? "")
                .join("\n");
            if (text.length) messages.push({ role: "system", content: text });
            continue;
        }

        if (msg.role === "assistant") {
            let text = "";
            const toolCalls: OpenAIToolCall[] = [];
            for (const b of blocks) {
                if (b.type === "text") {
                    text += (b as { text?: string }).text ?? "";
                } else if (b.type === "tool_use") {
                    const tu = b as { id: string; name: string; input?: unknown };
                    toolCalls.push({
                        id: tu.id,
                        type: "function",
                        function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
                    });
                }
                // thinking / redacted_thinking blocks are dropped from history
            }
            const out: Extract<OpenAIMessage, { role: "assistant" }> = {
                role: "assistant",
                content: text.length ? text : null,
            };
            if (toolCalls.length) out.tool_calls = toolCalls;
            messages.push(out);
        } else {
            // user turn: tool_result blocks become dedicated `tool` messages
            // (which must directly follow the assistant tool_calls); free text +
            // images become a trailing user message. Images can't live in an
            // OpenAI `tool` message, so tool_result images are lifted into the
            // user message too (as image_url parts).
            let userText = "";
            const imageUrls: string[] = [];
            const toolMsgs: OpenAIMessage[] = [];
            for (const b of blocks) {
                if (b.type === "tool_result") {
                    const tr = b as { tool_use_id: string; content: string | unknown[] };
                    toolMsgs.push({
                        role: "tool",
                        tool_call_id: tr.tool_use_id,
                        content: toolResultToString(tr.content),
                    });
                    imageUrls.push(...toolResultImages(tr.content));
                } else if (b.type === "text") {
                    userText += (b as { text?: string }).text ?? "";
                } else if (b.type === "image") {
                    const url = imageToUrl(b);
                    if (url) imageUrls.push(url);
                }
            }
            for (const tm of toolMsgs) messages.push(tm);
            if (imageUrls.length) {
                const parts: OpenAIContentPart[] = [];
                if (userText.length) parts.push({ type: "text", text: userText });
                for (const url of imageUrls) parts.push({ type: "image_url", image_url: { url } });
                messages.push({ role: "user", content: parts });
            } else if (userText.length) {
                messages.push({ role: "user", content: userText });
            }
        }
    }

    const tools: OpenAITool[] | undefined = req.tools?.map((t: unknown) => {
        const tool = t as { name: string; description?: string; input_schema?: unknown };
        return {
            type: "function",
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema ?? { type: "object", properties: {} },
            },
        };
    });

    const out: OpenAIRequest = {
        model: cfg.forceModel ?? req.model,
        messages,
        max_tokens: req.max_tokens ?? cfg.defaultMaxTokens,
        stream: req.stream ?? false,
    };
    if (req.temperature !== undefined) out.temperature = req.temperature;
    if (req.top_p !== undefined) out.top_p = req.top_p;
    if (req.stop_sequences?.length) out.stop = req.stop_sequences;
    if (tools?.length) {
        out.tools = tools;
        const tc = mapToolChoice(req.tool_choice);
        if (tc) out.tool_choice = tc;
    }
    if (out.stream) out.stream_options = { include_usage: true };
    return out;
}