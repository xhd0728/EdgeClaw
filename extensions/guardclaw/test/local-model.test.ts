import { afterEach, describe, expect, it, vi } from "vitest";
import { desensitizeWithLocalModel, detectByLocalModel } from "../src/local-model.js";
import type { DetectionContext, PrivacyConfig } from "../src/types.js";

function parseRequestJson(fetchSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const init = fetchSpy.mock.calls[0]?.[1];
  const rawBody = init?.body;
  expect(typeof rawBody).toBe("string");
  return JSON.parse(rawBody as string) as Record<string, unknown>;
}

describe("GuardClaw local-model request body", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects disable-thinking params for detection requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"level":"S1","reason":"safe","confidence":0.9}',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const context: DetectionContext = {
      checkpoint: "onUserMessage",
      message: "hello world",
      sessionKey: "session-1",
    };
    const config: PrivacyConfig = {
      localModel: {
        enabled: true,
        type: "openai-compatible",
        endpoint: "http://localhost:11434",
        model: "Qwen/Qwen3.5-35B-A3B",
      },
    };

    const result = await detectByLocalModel(context, config);
    expect(result.level).toBe("S1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const requestBody = parseRequestJson(fetchSpy);
    expect(requestBody.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("injects disable-thinking params for PII extraction requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const config: PrivacyConfig = {
      localModel: {
        enabled: true,
        type: "openai-compatible",
        endpoint: "http://localhost:11434",
        model: "Qwen/Qwen3.5-35B-A3B",
      },
    };

    const output = await desensitizeWithLocalModel("name: Alice, phone: 123", config);
    expect(output.wasModelUsed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const requestBody = parseRequestJson(fetchSpy);
    expect(requestBody.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
