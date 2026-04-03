import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPluginConfig } from "../src/config.js";
import { buildDiagnosticsToolsForSession } from "../src/diagnostics/tools.js";
import { ContextDiagnosticsStore } from "../src/diagnostics/store.js";

const tempDirs: string[] = [];

async function createStore(rawConfig: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawxcontext-diag-"));
  tempDirs.push(dir);
  const config = buildPluginConfig({ dataDir: dir, ...rawConfig });
  const store = new ContextDiagnosticsStore(config);
  await store.ensureReady();
  return { store };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("context_inspect tool", () => {
  it("returns the current session snapshot and events", async () => {
    const { store } = await createStore();
    await store.updateSessionContext({
      sessionKey: "agent:main:main",
      recentFiles: ["src/index.ts"],
      criticalToolOutputs: ["read src/index.ts: exported createContextEngine"],
    });
    await store.updateProjectContext("agent:main:main", {
      workspaceDir: "/tmp/workspace",
      platform: "darwin arm64",
      branch: "main",
      headSha: "abc1234",
      recentCommits: ["abc123 tighten context"],
      gitStatusSummary: ["Modified: src/index.ts"],
      gitDiffSummary: ["src/index.ts | 8 ++++----"],
      stablePrefixPreview: "User defaults from ~/.openclaw/OPENCLAW.md",
      activeRuleMatches: [
        {
          path: "/tmp/workspace/.openclaw/rules/src/index.ts.md",
          scope: "src/index.ts",
          origin: "workspace",
          specificity: 2,
          matchedBy: ["read"],
          usedForCompaction: false,
        },
      ],
      sources: [
        {
          kind: "userOpenclawMd",
          present: true,
          path: "/tmp/home/.openclaw/OPENCLAW.md",
          usedForPrompt: true,
          usedForCompaction: true,
        },
        {
          kind: "openclawMd",
          present: true,
          path: "/tmp/workspace/OPENCLAW.md",
          usedForPrompt: true,
          usedForCompaction: true,
        },
      ],
      lastLoadedAt: new Date().toISOString(),
    });
    await store.appendEvent("agent:main:main", {
      at: new Date().toISOString(),
      type: "assemble",
      detail: { assembledMessageCount: 3 },
    });
    await store.updateWorkingSet("agent:main:main", {
      messageCount: 1,
      estimatedTokens: 12,
      protectedTailStartIndex: 0,
      protectedTailMessageCount: 1,
      protectedRecentTurns: 1,
      includedCompactionSummary: false,
      reinjected: false,
      trimmedToBudget: false,
      retainedPreview: [
        {
          workingIndex: 0,
          sourceIndex: 0,
          role: "user",
          kind: "source",
          textPreview: "inspect preview",
        },
      ],
      notes: ["preview ready"],
    });
    await store.updatePressureState({
      sessionKey: "agent:main:main",
      pressureStage: "elevated",
      reinjectionMode: "summary+recent-files",
      debtBreakdown: {
        largeToolResultDebt: 0,
        readBloatDebt: 120,
        recentRewriteSavings: 40,
      },
      stabilizationTurnsRemaining: 0,
    });
    await store.recordCacheUsage({
      sessionKey: "agent:main:main",
      provider: "anthropic",
      model: "claude-sonnet",
      cacheWrite: 512,
    });
    await store.recordCacheUsage({
      sessionKey: "agent:main:main",
      provider: "anthropic",
      model: "claude-sonnet",
      cacheRead: 256,
    });
    await store.queueUserNotice("agent:main:main", {
      key: "path-rule:test",
      source: "path-rule",
      priority: 4,
      createdAt: new Date().toISOString(),
      language: "en",
      message: "I applied the project rules for the current file scope and will continue under them.",
    });

    const tool = buildDiagnosticsToolsForSession(store, {
      sessionKey: "agent:main:main",
    })[0];
    const result = await tool.execute("tool-1", {
      includeEvents: true,
    });

    const details = result.details;
    expect(details).toBeTruthy();
    expect((details).session.sessionKey).toBe("agent:main:main");
    expect((details).session.lastWorkingSet.retainedPreview[0].textPreview).toBe("inspect preview");
    expect((details).pressureStage).toBe("elevated");
    expect((details).compactionBias).toBe("normal");
    expect((details).reinjectionMode).toBe("summary+recent-files");
    expect((details).debtBreakdown.readBloatDebt).toBe(120);
    expect(Array.isArray((details).budgetHotspots)).toBe(true);
    expect((details).projectRuleSources).toHaveLength(2);
    expect((details).ruleMatchSources).toHaveLength(1);
    expect((details).stablePrefixPreview).toContain("User defaults");
    expect((details).preflightAction).toBe("snip-pressure-recommended");
    expect((details).overflowRisk).toBe("medium");
    expect((details).overflowRecoveryProfile).toBeUndefined();
    expect((details).cacheHealth.stablePrefixAvailable).toBe(true);
    expect((details).cacheHealth.recentStatuses).toEqual(["write", "hit"]);
    expect((details).cacheHealth.recentTrend).toBe("warming");
    expect((details).pendingUserNotice.source).toBe("path-rule");
    expect((details).userNoticeSource).toBe("path-rule");
    expect(Array.isArray((details).suggestions)).toBe(true);
    expect((details).events).toHaveLength(1);
  });
});

describe("context_suggest tool", () => {
  it("returns actionable context suggestions", async () => {
    const { store } = await createStore({
      autoCompactReserveTokens: 100,
      protectedRecentTurns: 1,
    });
    const sessionFile = path.join(tempDirs[tempDirs.length - 1]!, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 7,
          id: "session-1",
          timestamp: new Date().toISOString(),
          cwd: tempDirs[tempDirs.length - 1],
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: 1,
          message: { role: "user", content: "inspect src/index.ts", timestamp: 1 },
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          parentId: "m1",
          timestamp: 2,
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_read_1", name: "read", arguments: { path: "src/index.ts" } },
            ],
            timestamp: 2,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m3",
          parentId: "m2",
          timestamp: 3,
          message: {
            role: "toolResult",
            toolCallId: "call_read_1",
            toolName: "read",
            content: [{ type: "text", text: "x".repeat(3_000) }],
            timestamp: 3,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m4",
          parentId: "m3",
          timestamp: 4,
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_read_2", name: "read", arguments: { path: "src/index.ts" } },
            ],
            timestamp: 4,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m5",
          parentId: "m4",
          timestamp: 5,
          message: {
            role: "toolResult",
            toolCallId: "call_read_2",
            toolName: "read",
            content: [{ type: "text", text: "y".repeat(2_400) }],
            timestamp: 5,
          },
        }),
        JSON.stringify({
          type: "message",
          id: "m6",
          parentId: "m5",
          timestamp: 6,
          message: { role: "user", content: "continue", timestamp: 6 },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    await store.updateSessionContext({
      sessionKey: "agent:main:main",
      sessionFile,
    });
    await store.updateProjectContext("agent:main:main", {
      workspaceDir: tempDirs[tempDirs.length - 1],
      platform: "darwin arm64",
      branch: "main",
      headSha: "abc1234",
      recentCommits: [],
      gitStatusSummary: [],
      gitDiffSummary: [],
      stablePrefixPreview: "Project instructions from OPENCLAW.md",
      sources: [
        {
          kind: "openclawMd",
          present: true,
          path: path.join(tempDirs[tempDirs.length - 1]!, "OPENCLAW.md"),
          usedForPrompt: true,
          usedForCompaction: true,
        },
      ],
      lastLoadedAt: new Date().toISOString(),
    });
    await store.updateWorkingSet("agent:main:main", {
      messageCount: 5,
      estimatedTokens: 920,
      tokenBudget: 1_000,
      budgetUtilization: 0.92,
      protectedTailStartIndex: 4,
      protectedTailMessageCount: 1,
      protectedRecentTurns: 1,
      includedCompactionSummary: false,
      reinjected: false,
      trimmedToBudget: false,
      retainedPreview: [],
      notes: [],
    });

    const tool = buildDiagnosticsToolsForSession(store, {
      sessionKey: "agent:main:main",
    }).find((entry) => entry.name === "context_suggest");
    const result = await tool?.execute("tool-2", {});

    const details = result?.details as { suggestions?: Array<{ title: string }> };
    expect((result?.details as { pressureStage?: string }).pressureStage).toBeDefined();
    expect((result?.details as { compactionBias?: string }).compactionBias).toBeDefined();
    expect((result?.details as { preflightAction?: string }).preflightAction).toBeDefined();
    expect((result?.details as { cacheHealth?: { stablePrefixAvailable?: boolean } }).cacheHealth?.stablePrefixAvailable).toBe(true);
    expect(Array.isArray((result?.details as { budgetHotspots?: unknown[] }).budgetHotspots)).toBe(true);
    expect(details.suggestions?.some((entry) => entry.title.includes("Working set is near"))).toBe(
      true,
    );
    expect(
      details.suggestions?.some((entry) => entry.title.includes("Repeated file reads")),
    ).toBe(true);
    expect(
      details.suggestions?.some((entry) => entry.title.includes("Compact before the next large turn")),
    ).toBe(true);
  });
});
