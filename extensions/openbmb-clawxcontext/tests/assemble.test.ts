import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const delegateCompactionToRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    delegateCompactionToRuntime: delegateCompactionToRuntimeMock,
  };
});
import { buildPluginConfig } from "../src/config.js";
import { assembleWorkingSet } from "../src/context-engine/assemble.js";
import { buildReinjectionText } from "../src/context-engine/reinjection.js";
import { ContextDiagnosticsStore } from "../src/diagnostics/store.js";

const tempDirs: string[] = [];

async function createStore(rawConfig = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawxcontext-assemble-"));
  tempDirs.push(dir);
  const config = buildPluginConfig({
    dataDir: dir,
    protectedRecentTurns: 1,
    ...rawConfig,
  });
  const store = new ContextDiagnosticsStore(config);
  await store.ensureReady();
  return { config, store };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  delegateCompactionToRuntimeMock.mockReset();
});

describe("assembleWorkingSet", () => {
  it("keeps full pre-compaction history when budget allows", async () => {
    const { config, store } = await createStore();

    const result = await assembleWorkingSet({
      config,
      store,
      sessionId: "session-pre-compact",
      sessionKey: "agent:main:main",
      tokenBudget: 4_000,
      messages: [
        { role: "user", content: "first", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "reply one" }], timestamp: 2 },
        { role: "user", content: "second", timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "reply two" }], timestamp: 4 },
      ],
    });

    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toMatchObject({ role: "user", content: "first" });
    expect(result.messages[3]).toMatchObject({ role: "assistant" });
  });

  it("does not enter collapsed-history mode for ordinary low-pressure text turns", async () => {
    const { config, store } = await createStore();

    const result = await assembleWorkingSet({
      config,
      store,
      sessionId: "session-low-pressure",
      sessionKey: "agent:main:main",
      tokenBudget: 8_000,
      messages: [
        { role: "user", content: "first", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "reply one" }], timestamp: 2 },
        { role: "user", content: "second", timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "reply two" }], timestamp: 4 },
        { role: "user", content: "third", timestamp: 5 },
      ],
    });

    expect(result.messages).toHaveLength(5);
    const session = await store.getSession("agent:main:main");
    expect(session.lastWorkingSet?.collapsedHistory).toBeUndefined();
    expect(session.lastWorkingSet?.retainedPreview.some((entry) => entry.kind === "collapsed")).toBe(false);
  });

  it("keeps the latest compaction summary and injects reinjection before the trailing user turn", async () => {
    const { config, store } = await createStore();
    const sessionKey = "agent:main:main";
    await store.updateSessionContext({
      sessionKey,
      reinjection: {
        mode: "summary+recent-files+critical-outputs",
        summary: "Older compact summary",
        recentFiles: ["src/index.ts"],
        criticalToolOutputs: ["read src/index.ts: exported createContextEngine"],
        rendered: buildReinjectionText({
          summary: "Older compact summary",
          recentFiles: ["src/index.ts"],
          criticalToolOutputs: ["read src/index.ts: exported createContextEngine"],
        }),
      },
    });

    const result = await assembleWorkingSet({
      config,
      store,
      sessionId: "session-1",
      sessionKey,
      tokenBudget: 4_000,
      messages: [
        { role: "user", content: "old question", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
        {
          role: "compactionSummary",
          summary: "Summary of older history.",
          tokensBefore: 1_500,
          timestamp: 3,
        },
        { role: "user", content: "current task", timestamp: 4 },
      ],
    });

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toMatchObject({ role: "compactionSummary" });
    expect(result.messages[1]).toMatchObject({ role: "user" });
    expect(JSON.stringify(result.messages[1])).toContain("Context block maintained by ClawXContext");
    expect(result.messages[2]).toMatchObject({ role: "user", content: "current task" });

    const session = await store.getSession(sessionKey);
    expect(session.lastWorkingSet?.includedCompactionSummary).toBe(true);
    expect(session.lastWorkingSet?.reinjected).toBe(true);
    expect(session.lastWorkingSet?.retainedPreview[0]).toMatchObject({
      workingIndex: 0,
      sourceIndex: 2,
      role: "compactionSummary",
      kind: "source",
    });
    expect(session.lastWorkingSet?.retainedPreview[1]).toMatchObject({
      workingIndex: 1,
      sourceIndex: null,
      role: "user",
      kind: "reinjection",
    });
  });

  it("does not split assistant tool-call and tool-result pairs when trimming", async () => {
    const { config, store } = await createStore();

    const result = await assembleWorkingSet({
      config,
      store,
      sessionId: "session-atomic-trim",
      sessionKey: "agent:main:main",
      tokenBudget: 100,
      messages: [
        { role: "user", content: "old task", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/legacy.ts" } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_read",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(3_000) }],
          timestamp: 3,
        },
        { role: "assistant", content: [{ type: "text", text: "old analysis" }], timestamp: 4 },
        { role: "user", content: "current turn", timestamp: 5 },
      ],
    });

    const hasToolCallMessage = result.messages.some((message) =>
      JSON.stringify(message).includes("\"call_read\""),
    );
    const hasToolResultMessage = result.messages.some(
      (message) =>
        (message as { role?: string }).role === "toolResult" &&
        JSON.stringify(message).includes("\"call_read\""),
    );

    expect(hasToolCallMessage).toBe(false);
    expect(hasToolResultMessage).toBe(false);

    const session = await store.getSession("agent:main:main");
    expect(session.lastWorkingSet?.trimmedToBudget).toBe(true);
    expect(session.lastWorkingSet?.retainedPreview.some((entry) => entry.toolCallId === "call_read")).toBe(false);
  });

  it("records truncated retained preview for large tool outputs", async () => {
    const { config, store } = await createStore();

    await assembleWorkingSet({
      config,
      store,
      sessionId: "session-preview",
      sessionKey: "agent:main:main",
      tokenBudget: 4_000,
      messages: [
        { role: "user", content: "inspect file", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/index.ts" } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_read",
          toolName: "read",
          content: [{ type: "text", text: "y".repeat(1_500) }],
          timestamp: 3,
        },
        { role: "user", content: "continue", timestamp: 4 },
      ],
    });

    const session = await store.getSession("agent:main:main");
    const preview = session.lastWorkingSet?.retainedPreview.find((entry) => entry.role === "toolResult");

    expect(preview).toMatchObject({
      kind: "source",
      toolName: "read",
      toolCallId: "call_read",
    });
    expect(preview?.textPreview.length).toBeLessThanOrEqual(220);
  });

  it("can preflight compact during assemble and synthesize a summary-first working set", async () => {
    const { config, store } = await createStore({
      autoCompactReserveTokens: 100,
    });
    const sessionKey = "agent:main:main";
    const sessionFile = path.join(tempDirs[tempDirs.length - 1]!, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 7,
          id: "session-preflight",
          timestamp: new Date().toISOString(),
          cwd: tempDirs[tempDirs.length - 1],
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: 1,
          message: { role: "user", content: "old task", timestamp: 1 },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    await store.updateSessionContext({
      sessionKey,
      sessionId: "session-preflight",
      sessionFile,
    });
    delegateCompactionToRuntimeMock.mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "preflight compact summary",
        tokensBefore: 1400,
        tokensAfter: 220,
      },
    });

    const result = await assembleWorkingSet({
      config,
      store,
      sessionId: "session-preflight",
      sessionKey,
      tokenBudget: 1_200,
      messages: [
        { role: "user", content: "old task", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/index.ts" } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_read",
          toolName: "read",
          content: [{ type: "text", text: "z".repeat(5_000) }],
          timestamp: 3,
        },
        { role: "user", content: "current turn", timestamp: 4 },
      ],
    });

    expect(delegateCompactionToRuntimeMock).toHaveBeenCalledTimes(1);
    expect(result.messages[0]).toMatchObject({
      role: "compactionSummary",
      summary: "preflight compact summary",
    });
    expect(result.messages[1]).toMatchObject({ role: "user", content: "current turn" });

    const session = await store.getSession(sessionKey);
    expect(session.lastWorkingSet?.includedCompactionSummary).toBe(true);
    expect(session.lastWorkingSet?.notes.some((entry) => entry.includes("preflight compaction triggered during assemble"))).toBe(true);
  });

  it("builds collapsed history before full compaction when pressure is elevated", async () => {
    const { config, store } = await createStore({
      autoCompactReserveTokens: 100,
    });

    const result = await assembleWorkingSet({
      config,
      store,
      sessionId: "session-collapsed",
      sessionKey: "agent:main:main",
      tokenBudget: 1_500,
      messages: [
        { role: "user", content: "legacy task " + "a".repeat(900), timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "analysis " + "b".repeat(900) }], timestamp: 2 },
        { role: "user", content: "mid task " + "c".repeat(900), timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "mid reply " + "d".repeat(900) }], timestamp: 4 },
        { role: "assistant", content: [{ type: "text", text: "tail bridge " + "e".repeat(900) }], timestamp: 5 },
        { role: "user", content: "current task", timestamp: 6 },
      ],
    });

    expect(result.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(result.messages[0])).toContain(
      "Collapsed handoff layer maintained by ClawXContext",
    );

    const session = await store.getSession("agent:main:main");
    expect(session.lastWorkingSet?.collapsedHistory).toMatchObject({
      stage: "elevated",
    });
    expect(session.lastWorkingSet?.collapsedHistory?.layers).toHaveLength(1);
    expect(session.lastWorkingSet?.collapsedHistory?.layers[0]?.label).toBe("handoff");
    expect(
      session.lastWorkingSet?.retainedPreview.some((entry) => entry.kind === "collapsed"),
    ).toBe(true);
    expect(
      session.lastWorkingSet?.notes.some((entry) => entry.includes("older history collapsed")),
    ).toBe(true);
  });

  it("uses live tool-result debt to trigger collapsed history before full compaction", async () => {
    const { config, store } = await createStore({
      autoCompactReserveTokens: 100,
    });

    const result = await assembleWorkingSet({
      config,
      store,
      sessionId: "session-live-debt",
      sessionKey: "agent:main:main",
      tokenBudget: 10_000,
      messages: [
        { role: "user", content: "find routes", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_grep", name: "grep", arguments: { pattern: "route", path: "src/api" } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_grep",
          toolName: "grep",
          content: [{ type: "text", text: "match\n".repeat(600) }],
          timestamp: 3,
        },
        { role: "user", content: "continue", timestamp: 4 },
      ],
    });

    expect(JSON.stringify(result.messages[0])).toContain(
      "Collapsed handoff layer maintained by ClawXContext",
    );
    const session = await store.getSession("agent:main:main");
    expect(session.lastWorkingSet?.collapsedHistory?.stage).not.toBe("normal");
  });

  it("builds archive and handoff layers when collapse pressure is critical", async () => {
    const { config, store } = await createStore({
      autoCompactReserveTokens: 100,
    });
    await store.setSession("agent:main:main", {
      compactionBias: "rescue",
    });

    const result = await assembleWorkingSet({
      config,
      store,
      sessionId: "session-layered-collapse",
      sessionKey: "agent:main:main",
      tokenBudget: 10_000,
      messages: [
        { role: "user", content: "legacy task " + "a".repeat(900), timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "legacy reply " + "b".repeat(900) }], timestamp: 2 },
        { role: "user", content: "second legacy task " + "c".repeat(900), timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "second legacy reply " + "d".repeat(900) }], timestamp: 4 },
        { role: "user", content: "third legacy task " + "e".repeat(900), timestamp: 5 },
        { role: "assistant", content: [{ type: "text", text: "third legacy reply " + "f".repeat(900) }], timestamp: 6 },
        { role: "user", content: "current task", timestamp: 7 },
      ],
    });

    expect(result.messages.slice(0, 2).every((message) => (message as { role?: string }).role === "user")).toBe(true);
    expect(JSON.stringify(result.messages[0])).toContain("Collapsed archive layer maintained by ClawXContext");
    expect(JSON.stringify(result.messages[1])).toContain("Collapsed handoff layer maintained by ClawXContext");

    const session = await store.getSession("agent:main:main");
    expect(session.lastWorkingSet?.collapsedHistory?.layers.map((layer) => layer.label)).toEqual([
      "archive",
      "handoff",
    ]);
  });
});
