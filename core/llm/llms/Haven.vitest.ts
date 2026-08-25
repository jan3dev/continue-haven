import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import Haven from "./Haven.js";

// test/vitest.setup.ts swaps global Response for node-fetch's, which cannot
// carry a web ReadableStream body (it stringifies it, so streamSse sees
// garbage). Haven builds Responses from web streams like the runtime
// (undici) supports, so restore the native Response for this suite.
const NativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = NativeResponse;
});

// Mutable state the haven-proxy mocks read on each call.
const mockState: {
  relayResult: any;
  relayCalls: { body: any; opts: any }[];
  createSecureRelayCalls: any[];
  loadConfigResult: any;
} = {
  relayResult: undefined,
  relayCalls: [],
  createSecureRelayCalls: [],
  loadConfigResult: { cfg: { apiKey: "hvn1_from_config" }, path: "/mock" },
};

const mockRelay = {
  relay: vi.fn(async (body: any, opts: any) => {
    mockState.relayCalls.push({ body, opts });
    return mockState.relayResult;
  }),
  setServableModels: vi.fn(),
  ready: vi.fn(async () => {}),
  validate: vi.fn(async () => ({ ok: true })),
};

vi.mock("haven-proxy/relay", () => ({
  createSecureRelay: vi.fn((opts: any) => {
    mockState.createSecureRelayCalls.push(opts);
    return mockRelay;
  }),
  sseLinesFor: (completion: any, includeUsage?: boolean) => {
    const chunk = {
      id: completion.id,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: completion.choices[0].message.content,
          },
          finish_reason: "stop",
        },
      ],
      ...(includeUsage ? { usage: completion.usage } : {}),
    };
    return [`data: ${JSON.stringify(chunk)}\n\n`, "data: [DONE]\n\n"];
  },
  INSUFFICIENT_BALANCE_MSG: "Your Haven balance is empty.",
}));

vi.mock("haven-proxy/config", () => ({
  loadConfig: vi.fn(() => mockState.loadConfigResult),
}));

vi.mock("haven-proxy/catalog", () => ({
  resolveCatalog: vi.fn(async () => ({
    models: [],
    servableIds: ["gpt-oss-120b", "glm-5-2"],
    source: "builtin",
  })),
}));

function sseStreamOf(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

function makeHaven(options: Record<string, any> = {}) {
  return new Haven({ model: "gpt-oss-120b", ...options } as any);
}

async function collectChat(llm: Haven, signal?: AbortSignal) {
  const chunks: any[] = [];
  for await (const msg of llm.streamChat(
    [{ role: "user", content: "hi" }],
    signal ?? new AbortController().signal,
  )) {
    chunks.push(msg);
  }
  return chunks;
}

beforeEach(() => {
  mockState.relayResult = undefined;
  mockState.relayCalls = [];
  mockState.createSecureRelayCalls = [];
  mockState.loadConfigResult = {
    cfg: { apiKey: "hvn1_from_config" },
    path: "/mock",
  };
  vi.clearAllMocks();
});

describe("Haven provider", () => {
  test("streams chat through the relay (SSE passthrough)", async () => {
    mockState.relayResult = {
      ok: true,
      wantStream: true,
      stream: sseStreamOf([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    };
    const llm = makeHaven({ apiKey: "hvn1_direct" });
    const chunks = await collectChat(llm);

    const text = chunks
      .map((c) => (typeof c.content === "string" ? c.content : ""))
      .join("");
    expect(text).toBe("Hello world");

    // The relay got the parsed OpenAI body and the abort signal.
    expect(mockState.relayCalls).toHaveLength(1);
    expect(mockState.relayCalls[0].body.model).toBe("gpt-oss-120b");
    expect(mockState.relayCalls[0].body.stream).toBe(true);
    expect(mockState.relayCalls[0].opts.signal).toBeInstanceOf(AbortSignal);
  });

  test("synthesizes SSE when the relay buffered a stream request", async () => {
    mockState.relayResult = {
      ok: true,
      wantStream: true,
      includeUsage: true,
      completion: {
        id: "cmpl-1",
        choices: [
          { index: 0, message: { role: "assistant", content: "Buffered" } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      },
    };
    const llm = makeHaven({ apiKey: "hvn1_direct" });
    const chunks = await collectChat(llm);
    const text = chunks
      .map((c) => (typeof c.content === "string" ? c.content : ""))
      .join("");
    expect(text).toBe("Buffered");
  });

  test("returns JSON for non-stream requests", async () => {
    mockState.relayResult = {
      ok: true,
      wantStream: false,
      completion: { id: "cmpl-2", choices: [{ message: { content: "ok" } }] },
    };
    const llm = makeHaven({ apiKey: "hvn1_direct" });
    const resp = await llm.fetch(
      "https://ankara.aquabtc.com/api/v1/haven/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({ model: "gpt-oss-120b", stream: false }),
      },
    );
    expect(resp.headers.get("Content-Type")).toBe("application/json");
    const json: any = await resp.json();
    expect(json.choices[0].message.content).toBe("ok");
  });

  test("throws a parseError-shaped error on relay failure", async () => {
    mockState.relayResult = {
      ok: false,
      error: {
        status: 402,
        message: "Your Haven balance is empty.",
        type: "insufficient_balance",
      },
    };
    const llm = makeHaven({ apiKey: "hvn1_direct" });
    await expect(collectChat(llm)).rejects.toThrow(
      /HTTP 402 insufficient_balance from Haven[\s\S]*balance is empty/,
    );
  });

  test("maps relay abort to an AbortError DOMException", async () => {
    mockState.relayResult = {
      ok: false,
      aborted: true,
      error: { status: 499 },
    };
    const llm = makeHaven({ apiKey: "hvn1_direct" });
    await expect(collectChat(llm)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  test("prefers the config-file apiKey over nothing, and options.apiKey over that", async () => {
    mockState.relayResult = {
      ok: true,
      wantStream: false,
      completion: { choices: [] },
    };

    const fromOptions = makeHaven({ apiKey: "hvn1_direct" });
    await fromOptions.fetch(
      "https://ankara.aquabtc.com/api/v1/haven/chat/completions",
      { method: "POST", body: "{}" },
    );
    expect(mockState.createSecureRelayCalls[0].apiKey).toBe("hvn1_direct");

    const fromConfig = makeHaven();
    await fromConfig.fetch(
      "https://ankara.aquabtc.com/api/v1/haven/chat/completions",
      { method: "POST", body: "{}" },
    );
    expect(mockState.createSecureRelayCalls[1].apiKey).toBe("hvn1_from_config");
  });

  test("throws an actionable error without a key, and recovers once one exists", async () => {
    mockState.loadConfigResult = { cfg: {}, path: "/mock" };
    mockState.relayResult = {
      ok: true,
      wantStream: false,
      completion: { choices: [] },
    };
    const llm = makeHaven();
    const url = "https://ankara.aquabtc.com/api/v1/haven/chat/completions";

    await expect(
      llm.fetch(url, { method: "POST", body: "{}" }),
    ).rejects.toThrow(/HAVEN_API_KEY/);

    // The failed relay promise must not be cached.
    mockState.loadConfigResult = {
      cfg: { apiKey: "hvn1_late" },
      path: "/mock",
    };
    const resp = await llm.fetch(url, { method: "POST", body: "{}" });
    expect(resp.status).toBe(200);
    expect(
      mockState.createSecureRelayCalls[
        mockState.createSecureRelayCalls.length - 1
      ].apiKey,
    ).toBe("hvn1_late");
  });

  test("never puts the key in plaintext auth headers", () => {
    const llm = makeHaven({ apiKey: "hvn1_secret" });
    const headers = (llm as any)._getHeaders();
    expect(headers.Authorization).toBeUndefined();
    expect(headers["api-key"]).toBeUndefined();
  });

  test("resolves the chat endpoint under the Haven API root", () => {
    const llm = makeHaven({ apiKey: "hvn1_direct" });
    const endpoint = (llm as any)._getEndpoint("chat/completions").toString();
    expect(endpoint).toBe(
      "https://ankara.aquabtc.com/api/v1/haven/chat/completions",
    );
  });

  test("sets context lengths from the builtin catalog, config wins", () => {
    expect(makeHaven().contextLength).toBe(131072);
    expect(makeHaven({ model: "glm-5-2" }).contextLength).toBe(200000);
    expect(makeHaven({ model: "kimi-k3" }).contextLength).toBe(200000);
    expect(
      makeHaven({ model: "glm-5-2", contextLength: 12345 }).contextLength,
    ).toBe(12345);
  });
});
