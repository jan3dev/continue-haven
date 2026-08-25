import { LLMOptions } from "../../index.js";
import { LlmApiRequestType } from "../openaiTypeConverters.js";

import type { SecureRelay } from "haven-proxy/relay";

import OpenAI from "./OpenAI.js";

const HAVEN_API_ROOT = "https://ankara.aquabtc.com/api/v1/haven";

// Context windows from haven-proxy's builtin catalog (defaults.js). The live
// list is GET {root}/pricing/; these only refresh with extension releases.
const MODEL_CONTEXT_LENGTHS: Record<string, number> = {
  "glm-5-2": 200_000,
  "kimi-k3": 200_000,
};
const DEFAULT_HAVEN_CONTEXT_LENGTH = 131_072;

/**
 * Haven is JAN3's private AI chat API: request bodies are HPKE-encrypted
 * end-to-end to a Tinfoil enclave (EHBP), so the server operator never sees
 * prompts or completions. The encryption happens here, in-process, via the
 * haven-proxy package's relay core — no localhost proxy needed.
 *
 * Auth is the plaintext outer header `X-Api-Key: hvn1_…`, injected by the
 * relay itself and sent only to the Haven origin over HTTPS. The key is
 * resolved from Continue config -> HAVEN_API_KEY env -> ~/.haven-proxy/config.json,
 * so it never has to live in a shareable config file.
 *
 * Known tradeoff, accepted for v1: haven-proxy's relay lazily wraps
 * `globalThis.fetch` process-wide (AsyncLocalStorage-scoped; a pure
 * passthrough for non-relay URLs) to capture enclave error bodies and honor
 * abort signals. Same behavior OpenCode users already run.
 */
class Haven extends OpenAI {
  static providerName = "haven";

  static defaultOptions: Partial<LLMOptions> = {
    // Trailing slash matters: _getEndpoint does new URL(endpoint, apiBase).
    apiBase: `${HAVEN_API_ROOT}/`,
    model: "gpt-oss-120b",
  };

  // Force every request through this.fetch instead of the openai SDK adapter.
  protected useOpenAIAdapterFor: (LlmApiRequestType | "*")[] = [];

  private havenApiRoot: string;
  private relayPromise?: Promise<SecureRelay>;

  constructor(options: LLMOptions) {
    super(options);
    this.havenApiRoot = (this.apiBase ?? `${HAVEN_API_ROOT}/`).replace(
      /\/+$/,
      "",
    );
    if (!options.contextLength) {
      this._contextLength =
        MODEL_CONTEXT_LENGTHS[options.model] ?? DEFAULT_HAVEN_CONTEXT_LENGTH;
    }
  }

  // The hvn1_ key must never ride in plaintext auth headers; the relay sends
  // X-Api-Key itself, and only to the Haven origin.
  protected _getHeaders() {
    return { "Content-Type": "application/json" } as any;
  }

  private getRelay(): Promise<SecureRelay> {
    if (!this.relayPromise) {
      this.relayPromise = this.createRelay();
      // A failure (e.g. missing key) must not be cached, so that fixing the
      // env var or config works without reloading the extension.
      this.relayPromise.catch(() => {
        this.relayPromise = undefined;
      });
    }
    return this.relayPromise;
  }

  private async createRelay(): Promise<SecureRelay> {
    const { createSecureRelay } = await import("haven-proxy/relay");

    let apiKey = this.apiKey;
    if (!apiKey) {
      // loadConfig applies the HAVEN_API_KEY env override before the file.
      const { loadConfig } = await import("haven-proxy/config");
      try {
        apiKey = loadConfig().cfg.apiKey;
      } catch {}
    }
    if (!apiKey) {
      throw new Error(
        "Haven API key not found. Set `apiKey` in your Continue config, " +
          "set the HAVEN_API_KEY environment variable, or run " +
          "`npx github:jan3dev/haven-proxy login`.",
      );
    }

    const relay = createSecureRelay({
      havenApiRoot: this.havenApiRoot,
      apiKey,
    });

    // Fire-and-forget: pre-warm the enclave attestation and learn which
    // models the backend can actually serve (precise "unknown model" errors).
    relay.ready().catch(() => {});
    import("haven-proxy/catalog")
      .then(({ resolveCatalog }) => resolveCatalog(this.havenApiRoot))
      .then(({ servableIds }) => relay.setServableModels(servableIds))
      .catch(() => {});

    return relay;
  }

  fetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const urlStr = typeof url === "string" ? url : url.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (
      method !== "POST" ||
      !urlStr.startsWith(this.havenApiRoot) ||
      !urlStr.includes("/chat/completions")
    ) {
      // Non-chat endpoints go over plain HTTPS; headers are already key-free.
      return super.fetch(url, init);
    }
    return this.havenChatFetch(init);
  }

  private async havenChatFetch(init?: RequestInit): Promise<Response> {
    const relay = await this.getRelay();
    const body: Record<string, unknown> =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const result = await relay.relay(body, {
      signal: init?.signal ?? undefined,
    });

    if (result.aborted) {
      throw new DOMException("The request was aborted.", "AbortError");
    }
    if (!result.ok) {
      const { status, message, type, code } = result.error ?? {
        status: 502,
        message: "Unknown Haven relay error",
      };
      // The relay already classified the error and retried a stale
      // attestation key once, so throw instead of returning a non-ok
      // Response — no second pass through Continue's backoff/parseError.
      throw new Error(
        `HTTP ${status} ${type ?? "haven_error"} from Haven${
          code ? ` (${code})` : ""
        }\n\n${message}`,
      );
    }

    const sseHeaders = { "Content-Type": "text/event-stream" };
    if (result.stream) {
      return new Response(result.stream, { status: 200, headers: sseHeaders });
    }

    if (result.wantStream) {
      // The deployment answered stream:true with buffered JSON — synthesize
      // the SSE frames the caller is already set up to consume.
      const { sseLinesFor } = await import("haven-proxy/relay");
      const lines = sseLinesFor(result.completion, result.includeUsage);
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) {
            controller.enqueue(encoder.encode(line));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: sseHeaders });
    }

    return new Response(JSON.stringify(result.completion), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export default Haven;
