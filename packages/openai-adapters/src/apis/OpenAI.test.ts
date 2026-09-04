import { ChatCompletionChunk } from "openai/resources/index";
import { describe, expect, test, vi } from "vitest";
import { OpenAIApi } from "./OpenAI.js";

// Build a chunk the way a given backend would emit it.
function chunk(
  delta: Record<string, unknown>,
  opts: { usage?: boolean; finish?: string } = {},
): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: (opts.finish ?? null) as any,
        logprobs: null,
      },
    ],
    ...(opts.usage
      ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
      : {}),
  } as ChatCompletionChunk;
}

const usageOnlyChunk = {
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  created: 0,
  model: "test-model",
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
} as unknown as ChatCompletionChunk;

function apiYielding(chunks: ChatCompletionChunk[]) {
  const api = new OpenAIApi({
    provider: "openai",
    apiKey: "test",
    apiBase: "http://127.0.0.1:0/v1",
  } as any);
  vi.spyOn((api as any).openai.chat.completions, "create").mockResolvedValue(
    (async function* () {
      for (const c of chunks) yield c;
    })() as any,
  );
  return api;
}

async function collect(api: OpenAIApi) {
  const out: ChatCompletionChunk[] = [];
  for await (const c of api.chatCompletionStream(
    { model: "test-model", messages: [], stream: true },
    new AbortController().signal,
  )) {
    out.push(c);
  }
  return out;
}

function textOf(chunks: ChatCompletionChunk[]) {
  return chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
}

describe("chatCompletionStream usage handling", () => {
  // vLLM (and the Haven relay in front of it) attaches usage to every chunk.
  // Deferring on `usage` alone swallowed the entire completion.
  test("keeps content when every chunk carries usage", async () => {
    const api = apiYielding([
      chunk({ role: "assistant", content: "" }, { usage: true }),
      chunk({ content: "Hi" }, { usage: true }),
      chunk({ content: " there" }, { usage: true }),
      chunk({}, { usage: true, finish: "stop" }),
    ]);

    const out = await collect(api);

    expect(textOf(out)).toBe("Hi there");
    expect(out.at(-1)?.choices?.[0]?.finish_reason).toBe("stop");
  });

  test("still defers an OpenAI-style usage-only chunk to the end", async () => {
    const api = apiYielding([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hi" }),
      usageOnlyChunk,
      chunk({}, { finish: "stop" }),
    ]);

    const out = await collect(api);

    expect(textOf(out)).toBe("Hi");
    expect(out.at(-1)?.usage?.completion_tokens).toBe(2);
    // The usage-only chunk must not interrupt the content chunks.
    expect(out.at(-1)?.choices?.length).toBe(0);
  });

  test("passes through a stream with no usage at all", async () => {
    const api = apiYielding([
      chunk({ content: "a" }),
      chunk({ content: "b" }),
      chunk({}, { finish: "stop" }),
    ]);

    expect(textOf(await collect(api))).toBe("ab");
  });
});
