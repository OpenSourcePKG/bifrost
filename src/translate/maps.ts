import { randomUUID } from "node:crypto";
import type { OpenAIRequest } from "../types.js";

/** OpenAI finish_reason -> Anthropic stop_reason. */
export function mapStopReason(finish: string | null | undefined, hadToolUse: boolean): string {
    if (hadToolUse) return "tool_use";
    switch (finish) {
        case "stop":
            return "end_turn";
        case "length":
            return "max_tokens";
        case "tool_calls":
            return "tool_use";
        default:
            return "end_turn";
    }
}

/** Anthropic tool_choice -> OpenAI tool_choice. */
export function mapToolChoice(tc: unknown): OpenAIRequest["tool_choice"] | undefined {
    if (!tc) return undefined;
    const obj = tc as { type?: string; name?: string };
    const t = typeof tc === "string" ? tc : obj.type;
    switch (t) {
        case "auto":
            return "auto";
        case "any":
            return "required";
        case "none":
            return "none";
        case "tool":
            return obj.name ? { type: "function", function: { name: obj.name } } : "required";
        default:
            return "auto";
    }
}

export function newId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}