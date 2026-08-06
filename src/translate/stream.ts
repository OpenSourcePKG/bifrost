import { mapStopReason, newId } from "./maps.js";

export interface SSEEvent {
    event: string;
    data: string;
}

function sse(event: string, data: unknown): SSEEvent {
    return { event, data: JSON.stringify(data) };
}

/** Parse an OpenAI-style `data: {...}\n\n` SSE stream into JSON chunks. */
async function* parseOpenAIStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line || !line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") return;
            try {
                yield JSON.parse(payload);
            } catch {
                /* ignore keep-alives / partial fragments */
            }
        }
    }
}

/**
 * Translate an upstream OpenAI streaming response into the Anthropic SSE
 * event sequence Claude Code expects:
 *
 *   message_start
 *   → (content_block_start / content_block_delta / content_block_stop)*
 *   → message_delta → message_stop
 *
 * Text deltas map to `text_delta`; streamed tool-call argument fragments map
 * to `input_json_delta`. Content-block indices are tracked here since OpenAI
 * does not send them.
 */
export async function* anthropicSSE(
    upstream: Response,
    model: string,
    inputTokensEstimate: number,
): AsyncGenerator<SSEEvent> {
    const messageId = newId("msg");

    yield sse("message_start", {
        type: "message_start",
        message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokensEstimate, output_tokens: 0 },
        },
    });
    yield sse("ping", { type: "ping" });

    let nextIndex = 0;
    let activeKind: "text" | "tool" | null = null;
    let activeIndex = -1;
    let anyBlock = false;
    let hadToolUse = false;
    let finish: string | null = null;
    let outputTokens = 0;
    let outChars = 0;

    // OpenAI tool_call array index -> Anthropic content-block index.
    const toolBlock = new Map<number, number>();

    const closeActive = (): SSEEvent | null => {
        if (activeKind === null) return null;
        const e = sse("content_block_stop", { type: "content_block_stop", index: activeIndex });
        activeKind = null;
        activeIndex = -1;
        return e;
    };

    if (upstream.body) {
        for await (const chunk of parseOpenAIStream(upstream.body)) {
            const choice = chunk.choices?.[0] ?? {};
            const delta = choice.delta ?? {};

            if (chunk.usage?.completion_tokens != null) outputTokens = chunk.usage.completion_tokens;

            // ---- text delta ----
            if (typeof delta.content === "string" && delta.content.length) {
                if (activeKind !== "text") {
                    const c = closeActive();
                    if (c) yield c;
                    activeIndex = nextIndex++;
                    activeKind = "text";
                    anyBlock = true;
                    yield sse("content_block_start", {
                        type: "content_block_start",
                        index: activeIndex,
                        content_block: { type: "text", text: "" },
                    });
                }
                outChars += delta.content.length;
                yield sse("content_block_delta", {
                    type: "content_block_delta",
                    index: activeIndex,
                    delta: { type: "text_delta", text: delta.content },
                });
            }

            // ---- tool-call deltas ----
            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    const oaIdx: number = tc.index ?? 0;
                    if (!toolBlock.has(oaIdx)) {
                        const c = closeActive();
                        if (c) yield c;
                        const bi = nextIndex++;
                        toolBlock.set(oaIdx, bi);
                        activeIndex = bi;
                        activeKind = "tool";
                        anyBlock = true;
                        hadToolUse = true;
                        yield sse("content_block_start", {
                            type: "content_block_start",
                            index: bi,
                            content_block: {
                                type: "tool_use",
                                id: tc.id ?? newId("toolu"),
                                name: tc.function?.name ?? "",
                                input: {},
                            },
                        });
                    }
                    const bi = toolBlock.get(oaIdx)!;
                    const args: string | undefined = tc.function?.arguments;
                    if (args) {
                        activeIndex = bi;
                        activeKind = "tool";
                        yield sse("content_block_delta", {
                            type: "content_block_delta",
                            index: bi,
                            delta: { type: "input_json_delta", partial_json: args },
                        });
                    }
                }
            }

            if (choice.finish_reason) finish = choice.finish_reason;
        }
    }

    const c = closeActive();
    if (c) yield c;

    // Guarantee at least one content block so clients that require one are happy.
    if (!anyBlock) {
        yield sse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
        });
        yield sse("content_block_stop", { type: "content_block_stop", index: 0 });
    }

    if (outputTokens === 0) outputTokens = Math.max(1, Math.round(outChars / 4));

    yield sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: mapStopReason(finish, hadToolUse), stop_sequence: null },
        usage: { output_tokens: outputTokens },
    });
    yield sse("message_stop", { type: "message_stop" });
}
