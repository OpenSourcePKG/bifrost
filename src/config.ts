export interface Config {
    port: number;
    /** Upstream MimirMind OpenAI-compatible base URL, including the /v1 suffix. */
    upstreamBaseUrl: string;
    /** Bearer token forwarded to MimirMind. */
    upstreamApiKey?: string;
    /** If set, incoming clients must present this key (x-api-key / Bearer). */
    clientApiKey?: string;
    /** If set, every request is routed onto this upstream model id. */
    forceModel?: string;
    defaultMaxTokens: number;
    logLevel: "debug" | "info" | "silent";
}

function env(name: string, fallback?: string): string | undefined {
    const v = process.env[name];
    return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(): Config {
    const base = env("UPSTREAM_BASE_URL", "http://localhost:8080/v1") as string;
    return {
        port: Number(env("PORT", "8787")),
        upstreamBaseUrl: base.replace(/\/+$/, ""),
        upstreamApiKey: env("UPSTREAM_API_KEY"),
        clientApiKey: env("CLIENT_API_KEY"),
        forceModel: env("UPSTREAM_MODEL"),
        defaultMaxTokens: Number(env("DEFAULT_MAX_TOKENS", "1024")),
        logLevel: env("LOG_LEVEL", "info") as Config["logLevel"],
    };
}