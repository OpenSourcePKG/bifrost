import type { OpenAIResponse } from "../types.js";
import { mapStopReason, newId } from "./maps.js";

/** Translate a non-streaming OpenAI chat-completion into an Anthropic message. */
export function translateResponse(resp: OpenAIResponse, model: string) {
    const choice = resp.choices?.[0];
    const msg = choice?.message ?? {};
    const content: Array<Record<string, unknown>> = [];

    if (typeof msg.content === "string" && msg.content.length) {
        content.push({ type: "text", text: msg.content });
    }

    const toolCalls = msg.tool_calls ?? [];
    for (const tc of toolCalls) {
        let input: unknown = {};
        try {
            input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
            input = { _raw: tc.function?.arguments ?? "" };
        }
        content.push({
            type: "tool_use",
            id: tc.id ?? newId("toolu"),
            name: tc.function?.name ?? "unknown",
            input,
        });
    }

    if (content.length === 0) content.push({ type: "text", text: "" });

    return {
        id: resp.id ?? newId("msg"),
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: mapStopReason(choice?.finish_reason, toolCalls.length > 0),
        stop_sequence: null,
        usage: {
            input_tokens: resp.usage?.prompt_tokens ?? 0,
            output_tokens: resp.usage?.completion_tokens ?? 0,
        },
    };
}