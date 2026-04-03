import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLUGIN_ID, type PluginRuntimeConfig } from "../config.js";
import type {
  BudgetHotspot,
  CacheUsageSnapshot,
  CompactionBias,
  CompactionSnapshot,
  CompactionLifecycleSnapshot,
  DebtBreakdown,
  DiagnosticEventRecord,
  DiagnosticsOverview,
  FailSoftRecord,
  PressureStage,
  ProjectContextSnapshot,
  PendingUserNotice,
  ReinjectionMode,
  ReinjectionSnapshot,
  RewriteStatsSnapshot,
  SessionDiagnosticsSnapshot,
  UserNoticeLanguage,
  WorkingSetSnapshot,
} from "../context-engine/types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeSessionKey(sessionKey: string): string {
  return sessionKey.replace(/[^A-Za-z0-9._-]+/g, "_");
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

function withDefaults(
  sessionKey: string,
  config: PluginRuntimeConfig,
  existing?: Partial<SessionDiagnosticsSnapshot>,
): SessionDiagnosticsSnapshot {
  return {
    sessionKey,
    bootstrapped: existing?.bootstrapped ?? false,
    protectedRecentTurns: existing?.protectedRecentTurns ?? config.protectedRecentTurns,
    autoCompactReserveTokens:
      existing?.autoCompactReserveTokens ?? config.autoCompactReserveTokens,
    recentFiles: existing?.recentFiles ?? [],
    criticalToolOutputs: existing?.criticalToolOutputs ?? [],
    ...(existing?.latestSummarySnapshot
      ? { latestSummarySnapshot: existing.latestSummarySnapshot }
      : {}),
    ...(existing?.lastCompaction ? { lastCompaction: existing.lastCompaction } : {}),
    ...(existing?.lastWorkingSet ? { lastWorkingSet: existing.lastWorkingSet } : {}),
    ...(existing?.reinjection ? { reinjection: existing.reinjection } : {}),
    ...(existing?.projectContext ? { projectContext: existing.projectContext } : {}),
    pressureStage: existing?.pressureStage ?? "normal",
    compactionBias: existing?.compactionBias ?? "normal",
    reinjectionMode:
      existing?.reinjectionMode ??
      existing?.reinjection?.mode ??
      "summary+recent-files+critical-outputs",
    debtBreakdown: existing?.debtBreakdown ?? {
      largeToolResultDebt: 0,
      readBloatDebt: 0,
      searchToolResultDebt: 0,
      commandToolResultDebt: 0,
      webToolResultDebt: 0,
      collapseCandidateDebt: 0,
      recentRewriteSavings: 0,
    },
    budgetHotspots: existing?.budgetHotspots ?? [],
    stabilizationTurnsRemaining: existing?.stabilizationTurnsRemaining ?? 0,
    cacheUsage: withCacheUsageDefaults(existing?.cacheUsage),
    compactionLifecycle: withCompactionLifecycleDefaults(existing),
    rewrites: existing?.rewrites ?? {
      snipHits: 0,
      microcompactHits: 0,
      rewrittenEntries: 0,
      bytesFreed: 0,
    },
    ...(existing?.pendingUserNotice ? { pendingUserNotice: existing.pendingUserNotice } : {}),
    ...(existing?.lastDeliveredUserNotice
      ? { lastDeliveredUserNotice: existing.lastDeliveredUserNotice }
      : {}),
    ...(existing?.userNoticeSource
      ? { userNoticeSource: existing.userNoticeSource }
      : existing?.pendingUserNotice?.source
        ? { userNoticeSource: existing.pendingUserNotice.source }
        : existing?.lastDeliveredUserNotice?.source
          ? { userNoticeSource: existing.lastDeliveredUserNotice.source }
          : {}),
    failSoft: existing?.failSoft ?? [],
    lastUpdatedAt: existing?.lastUpdatedAt ?? nowIso(),
    ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
    ...(existing?.sessionFile ? { sessionFile: existing.sessionFile } : {}),
  };
}

function withCacheUsageDefaults(existing?: Partial<CacheUsageSnapshot>): CacheUsageSnapshot {
  return {
    runsObserved: existing?.runsObserved ?? 0,
    totalCacheReadTokens: existing?.totalCacheReadTokens ?? 0,
    totalCacheWriteTokens: existing?.totalCacheWriteTokens ?? 0,
    recentStatuses: existing?.recentStatuses ?? [],
    ...(typeof existing?.lastCacheReadTokens === "number"
      ? { lastCacheReadTokens: existing.lastCacheReadTokens }
      : {}),
    ...(typeof existing?.lastCacheWriteTokens === "number"
      ? { lastCacheWriteTokens: existing.lastCacheWriteTokens }
      : {}),
    ...(existing?.lastProvider ? { lastProvider: existing.lastProvider } : {}),
    ...(existing?.lastModel ? { lastModel: existing.lastModel } : {}),
    ...(existing?.lastObservedAt ? { lastObservedAt: existing.lastObservedAt } : {}),
  };
}

function withCompactionLifecycleDefaults(
  existing?: Partial<SessionDiagnosticsSnapshot>,
): CompactionLifecycleSnapshot {
  const lifecycle = existing?.compactionLifecycle;
  const hasCompaction =
    lifecycle?.compactionCount && lifecycle.compactionCount > 0
      ? true
      : Boolean(existing?.lastCompaction?.ok && existing.lastCompaction.compacted);
  return {
    turnCounter: lifecycle?.turnCounter ?? 0,
    compactionCount: lifecycle?.compactionCount ?? (hasCompaction ? 1 : 0),
    ...(typeof lifecycle?.turnsSinceCompaction === "number"
      ? { turnsSinceCompaction: lifecycle.turnsSinceCompaction }
      : hasCompaction
        ? { turnsSinceCompaction: 0 }
        : {}),
    ...(lifecycle?.firstPostCompactionTurnAt
      ? { firstPostCompactionTurnAt: lifecycle.firstPostCompactionTurnAt }
      : lifecycle?.firstPostCompactionTurnAt === null
        ? { firstPostCompactionTurnAt: null }
      : {}),
    ...(lifecycle?.lastTrigger ? { lastTrigger: lifecycle.lastTrigger } : {}),
    ...(typeof lifecycle?.lastTokensBefore === "number"
      ? { lastTokensBefore: lifecycle.lastTokensBefore }
      : typeof existing?.lastCompaction?.tokensBefore === "number"
        ? { lastTokensBefore: existing.lastCompaction.tokensBefore }
        : {}),
    ...(typeof lifecycle?.lastTokensAfter === "number"
      ? { lastTokensAfter: lifecycle.lastTokensAfter }
      : typeof existing?.lastCompaction?.tokensAfter === "number"
        ? { lastTokensAfter: existing.lastCompaction.tokensAfter }
        : {}),
    ...(typeof lifecycle?.cacheMissAfterCompaction === "boolean"
      ? { cacheMissAfterCompaction: lifecycle.cacheMissAfterCompaction }
      : {}),
    ...(typeof lifecycle?.lastOverflowRecoveryAttempt === "number"
      ? { lastOverflowRecoveryAttempt: lifecycle.lastOverflowRecoveryAttempt }
      : {}),
    ...(typeof lifecycle?.lastOverflowRecoveryMaxAttempts === "number"
      ? { lastOverflowRecoveryMaxAttempts: lifecycle.lastOverflowRecoveryMaxAttempts }
      : {}),
    ...(lifecycle?.lastOverflowRecoveryMode
      ? { lastOverflowRecoveryMode: lifecycle.lastOverflowRecoveryMode }
      : {}),
    ...(lifecycle?.overflowRecoveryProfile
      ? { overflowRecoveryProfile: lifecycle.overflowRecoveryProfile }
      : {}),
    ...(lifecycle?.currentBias ? { currentBias: lifecycle.currentBias } : {}),
    ...(!lifecycle?.currentBias && existing?.compactionBias
      ? { currentBias: existing.compactionBias }
      : {}),
    ...(lifecycle?.rapidReentryStage
      ? { rapidReentryStage: lifecycle.rapidReentryStage }
      : {}),
    ...(typeof lifecycle?.postCompactionRepeatedReads === "number"
      ? { postCompactionRepeatedReads: lifecycle.postCompactionRepeatedReads }
      : {}),
  };
}

export class ContextDiagnosticsStore {
  readonly engineId = PLUGIN_ID;
  readonly config: PluginRuntimeConfig;
  readonly baseDir: string;
  readonly sessionsDir: string;
  readonly eventsDir: string;
  private readonly sessions = new Map<string, SessionDiagnosticsSnapshot>();
  private readonly events = new Map<string, DiagnosticEventRecord[]>();

  constructor(config: PluginRuntimeConfig) {
    this.config = config;
    this.baseDir = config.dataDir;
    this.sessionsDir = join(this.baseDir, "sessions");
    this.eventsDir = join(this.baseDir, "events");
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await fs.mkdir(this.eventsDir, { recursive: true });
  }

  private sessionPath(sessionKey: string): string {
    return join(this.sessionsDir, `${sanitizeSessionKey(sessionKey)}.json`);
  }

  private eventsPath(sessionKey: string): string {
    return join(this.eventsDir, `${sanitizeSessionKey(sessionKey)}.json`);
  }

  async getSession(sessionKey: string): Promise<SessionDiagnosticsSnapshot> {
    const cached = this.sessions.get(sessionKey);
    if (cached) return cached;
    const loaded = await readJsonFile<SessionDiagnosticsSnapshot>(this.sessionPath(sessionKey));
    const session = withDefaults(sessionKey, this.config, loaded);
    this.sessions.set(sessionKey, session);
    return session;
  }

  async setSession(
    sessionKey: string,
    updater:
      | Partial<SessionDiagnosticsSnapshot>
      | ((current: SessionDiagnosticsSnapshot) => Partial<SessionDiagnosticsSnapshot>),
  ): Promise<SessionDiagnosticsSnapshot> {
    const current = await this.getSession(sessionKey);
    const patch = typeof updater === "function" ? updater(current) : updater;
    const next = withDefaults(sessionKey, this.config, {
      ...current,
      ...patch,
      lastUpdatedAt: nowIso(),
    });
    this.sessions.set(sessionKey, next);
    await writeJsonFile(this.sessionPath(sessionKey), next);
    return next;
  }

  async listEvents(sessionKey: string): Promise<DiagnosticEventRecord[]> {
    const cached = this.events.get(sessionKey);
    if (cached) return cached;
    const loaded = await readJsonFile<DiagnosticEventRecord[]>(this.eventsPath(sessionKey));
    const events = Array.isArray(loaded) ? loaded : [];
    this.events.set(sessionKey, events);
    return events;
  }

  async appendEvent(sessionKey: string, event: DiagnosticEventRecord): Promise<void> {
    const events = [...(await this.listEvents(sessionKey)), event];
    this.events.set(sessionKey, events);
    await writeJsonFile(this.eventsPath(sessionKey), events);
  }

  async noteFailSoft(sessionKey: string, record: FailSoftRecord): Promise<void> {
    await this.setSession(sessionKey, (current) => ({
      failSoft: [...current.failSoft, record].slice(-20),
    }));
    await this.appendEvent(sessionKey, {
      at: record.at,
      type: "fail-soft",
      detail: {
        phase: record.phase,
        message: record.message,
      },
    });
  }

  async updateWorkingSet(
    sessionKey: string,
    workingSet: WorkingSetSnapshot,
    extra?: { sessionFile?: string; sessionId?: string },
  ): Promise<void> {
    await this.setSession(sessionKey, {
      lastWorkingSet: workingSet,
      ...(extra?.sessionFile ? { sessionFile: extra.sessionFile } : {}),
      ...(extra?.sessionId ? { sessionId: extra.sessionId } : {}),
    });
  }

  async updateCompaction(
    sessionKey: string,
    compaction: CompactionSnapshot,
    extra?: {
      summary?: string;
      reinjection?: ReinjectionSnapshot;
      trigger?: CompactionLifecycleSnapshot["lastTrigger"];
      enterStabilization?: boolean;
      compactionBias?: CompactionBias;
      overflowRecoveryAttempt?: number;
      overflowRecoveryMaxAttempts?: number;
      overflowRecoveryMode?: CompactionLifecycleSnapshot["lastOverflowRecoveryMode"];
      overflowRecoveryProfile?: CompactionLifecycleSnapshot["overflowRecoveryProfile"];
    },
  ): Promise<void> {
    await this.setSession(sessionKey, (current) => {
      let compactionLifecycle: CompactionLifecycleSnapshot = {
        ...current.compactionLifecycle,
        compactionCount:
          current.compactionLifecycle.compactionCount +
          (compaction.ok && compaction.compacted ? 1 : 0),
        ...(compaction.ok && compaction.compacted ? { turnsSinceCompaction: 0 } : {}),
        ...(compaction.ok && compaction.compacted
          ? { firstPostCompactionTurnAt: null }
          : {}),
        ...(typeof compaction.tokensBefore === "number"
          ? { lastTokensBefore: compaction.tokensBefore }
          : {}),
        ...(typeof compaction.tokensAfter === "number"
          ? { lastTokensAfter: compaction.tokensAfter }
          : {}),
        ...(extra?.trigger ? { lastTrigger: extra.trigger } : {}),
        ...(compaction.ok && compaction.compacted ? { cacheMissAfterCompaction: false } : {}),
        ...(typeof extra?.overflowRecoveryAttempt === "number"
          ? { lastOverflowRecoveryAttempt: extra.overflowRecoveryAttempt }
          : {}),
        ...(typeof extra?.overflowRecoveryMaxAttempts === "number"
          ? { lastOverflowRecoveryMaxAttempts: extra.overflowRecoveryMaxAttempts }
          : {}),
        ...(extra?.overflowRecoveryMode
          ? { lastOverflowRecoveryMode: extra.overflowRecoveryMode }
          : {}),
        ...(extra?.overflowRecoveryProfile
          ? { overflowRecoveryProfile: extra.overflowRecoveryProfile }
          : {}),
        ...(extra?.compactionBias
          ? { currentBias: extra.compactionBias }
          : {}),
      };
      if (compaction.ok && compaction.compacted) {
        const { rapidReentryStage, postCompactionRepeatedReads, ...rest } = compactionLifecycle;
        void rapidReentryStage;
        void postCompactionRepeatedReads;
        compactionLifecycle = {
          ...rest,
          postCompactionRepeatedReads: 0,
        };
      }
      return {
        lastCompaction: compaction,
        ...(extra?.summary !== undefined ? { latestSummarySnapshot: extra.summary } : {}),
        ...(extra?.reinjection !== undefined ? { reinjection: extra.reinjection } : {}),
        ...(extra?.compactionBias ? { compactionBias: extra.compactionBias } : {}),
        ...(extra?.reinjection?.mode ? { reinjectionMode: extra.reinjection.mode } : {}),
        compactionLifecycle,
        ...(extra?.enterStabilization
          ? {
              pressureStage: "stabilizing" as const,
              reinjectionMode: "summary-only" as const,
              stabilizationTurnsRemaining: 2,
            }
          : {}),
        recentFiles: current.recentFiles,
        criticalToolOutputs: current.criticalToolOutputs,
      };
    });
  }

  async updateRewriteStats(
    sessionKey: string,
    stats: Partial<RewriteStatsSnapshot> & {
      addSnipHits?: number;
      addMicrocompactHits?: number;
      addRewrittenEntries?: number;
      addBytesFreed?: number;
    },
  ): Promise<void> {
    await this.setSession(sessionKey, (current) => ({
      rewrites: {
        snipHits: current.rewrites.snipHits + (stats.addSnipHits ?? 0),
        microcompactHits: current.rewrites.microcompactHits + (stats.addMicrocompactHits ?? 0),
        rewrittenEntries: current.rewrites.rewrittenEntries + (stats.addRewrittenEntries ?? 0),
        bytesFreed: current.rewrites.bytesFreed + (stats.addBytesFreed ?? 0),
        ...(stats.lastRewrittenAt ? { lastRewrittenAt: stats.lastRewrittenAt } : {}),
      },
    }));
  }

  async updateSessionContext(params: {
    sessionKey: string;
    sessionId?: string;
    sessionFile?: string;
    bootstrapped?: boolean;
    recentFiles?: string[];
    criticalToolOutputs?: string[];
    latestSummarySnapshot?: string;
    reinjection?: ReinjectionSnapshot;
  }): Promise<void> {
    await this.setSession(params.sessionKey, (current) => ({
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
      ...(params.bootstrapped !== undefined ? { bootstrapped: params.bootstrapped } : {}),
      ...(params.recentFiles ? { recentFiles: params.recentFiles } : {}),
      ...(params.criticalToolOutputs
        ? { criticalToolOutputs: params.criticalToolOutputs }
        : {}),
      ...(params.latestSummarySnapshot !== undefined
        ? { latestSummarySnapshot: params.latestSummarySnapshot }
        : {}),
      ...(params.reinjection !== undefined ? { reinjection: params.reinjection } : {}),
      ...(params.reinjection?.mode ? { reinjectionMode: params.reinjection.mode } : {}),
      protectedRecentTurns: current.protectedRecentTurns,
      autoCompactReserveTokens: current.autoCompactReserveTokens,
      cacheUsage: current.cacheUsage,
      compactionLifecycle: current.compactionLifecycle,
      budgetHotspots: current.budgetHotspots,
    }));
  }

  async updateProjectContext(
    sessionKey: string,
    projectContext: ProjectContextSnapshot | undefined,
  ): Promise<void> {
    await this.setSession(sessionKey, {
      ...(projectContext ? { projectContext } : {}),
    });
  }

  async recordTurn(sessionKey: string, at = nowIso()): Promise<void> {
    await this.setSession(sessionKey, (current) => {
      const priorTurnsSince = current.compactionLifecycle.turnsSinceCompaction;
      const hadCompaction = current.compactionLifecycle.compactionCount > 0;
      return {
        compactionLifecycle: {
          ...current.compactionLifecycle,
          turnCounter: current.compactionLifecycle.turnCounter + 1,
          ...(hadCompaction
            ? {
                turnsSinceCompaction:
                  typeof priorTurnsSince === "number" ? priorTurnsSince + 1 : 1,
              }
            : {}),
          ...(hadCompaction && priorTurnsSince === 0
            ? { firstPostCompactionTurnAt: at }
            : {}),
        },
      };
    });
  }

  async updatePressureState(params: {
    sessionKey: string;
    pressureStage: PressureStage;
    reinjectionMode: ReinjectionMode;
    debtBreakdown: DebtBreakdown;
    budgetHotspots?: BudgetHotspot[];
    compactionBias?: CompactionBias;
    stabilizationTurnsRemaining?: number;
  }): Promise<void> {
    await this.setSession(params.sessionKey, (current) => ({
      pressureStage: params.pressureStage,
      ...(params.compactionBias ? { compactionBias: params.compactionBias } : {}),
      reinjectionMode: params.reinjectionMode,
      debtBreakdown: {
        ...current.debtBreakdown,
        ...params.debtBreakdown,
      },
      ...(params.budgetHotspots ? { budgetHotspots: params.budgetHotspots } : {}),
      ...(typeof params.stabilizationTurnsRemaining === "number"
        ? { stabilizationTurnsRemaining: Math.max(0, params.stabilizationTurnsRemaining) }
        : { stabilizationTurnsRemaining: current.stabilizationTurnsRemaining }),
      compactionLifecycle: {
        ...current.compactionLifecycle,
        ...(params.compactionBias ? { currentBias: params.compactionBias } : {}),
      },
    }));
  }

  async recordCompactionQuality(params: {
    sessionKey: string;
    rapidReentryStage?: CompactionLifecycleSnapshot["rapidReentryStage"] | null;
    postCompactionRepeatedReads?: number;
    clear?: boolean;
  }): Promise<void> {
    await this.setSession(params.sessionKey, (current) => {
      let compactionLifecycle: CompactionLifecycleSnapshot = {
        ...current.compactionLifecycle,
        ...(typeof params.postCompactionRepeatedReads === "number"
          ? { postCompactionRepeatedReads: params.postCompactionRepeatedReads }
          : {}),
      };
      if (params.clear || params.rapidReentryStage === null) {
        const { rapidReentryStage, ...rest } = compactionLifecycle;
        void rapidReentryStage;
        compactionLifecycle = rest;
      } else if (params.rapidReentryStage) {
        compactionLifecycle = {
          ...compactionLifecycle,
          rapidReentryStage: params.rapidReentryStage,
        };
      }
      if (params.clear && typeof params.postCompactionRepeatedReads !== "number") {
        compactionLifecycle = {
          ...compactionLifecycle,
          postCompactionRepeatedReads: 0,
        };
      }
      return {
        compactionLifecycle,
      };
    });
  }

  async recordCacheUsage(params: {
    sessionKey: string;
    provider?: string;
    model?: string;
    cacheRead?: number;
    cacheWrite?: number;
    observedAt?: string;
  }): Promise<void> {
    await this.setSession(params.sessionKey, (current) => {
      const observedAt = params.observedAt ?? nowIso();
      const hasCacheRead = typeof params.cacheRead === "number";
      const lastStatus: "hit" | "write" | "miss" =
        Math.max(0, params.cacheRead ?? 0) > 0
          ? "hit"
          : Math.max(0, params.cacheWrite ?? 0) > 0
            ? "write"
            : "miss";
      const recentCompaction =
        typeof current.compactionLifecycle.turnsSinceCompaction === "number" &&
        current.compactionLifecycle.turnsSinceCompaction <= 1;
      return {
        cacheUsage: {
          runsObserved: current.cacheUsage.runsObserved + 1,
          totalCacheReadTokens:
            current.cacheUsage.totalCacheReadTokens + Math.max(0, params.cacheRead ?? 0),
          totalCacheWriteTokens:
            current.cacheUsage.totalCacheWriteTokens + Math.max(0, params.cacheWrite ?? 0),
          recentStatuses: [...(current.cacheUsage.recentStatuses ?? []), lastStatus].slice(-8),
          ...(hasCacheRead ? { lastCacheReadTokens: Math.max(0, params.cacheRead ?? 0) } : {}),
          ...(typeof params.cacheWrite === "number"
            ? { lastCacheWriteTokens: Math.max(0, params.cacheWrite) }
            : {}),
          ...(params.provider ? { lastProvider: params.provider } : {}),
          ...(params.model ? { lastModel: params.model } : {}),
          lastObservedAt: observedAt,
        },
        compactionLifecycle: {
          ...current.compactionLifecycle,
          ...(recentCompaction && hasCacheRead
            ? { cacheMissAfterCompaction: Math.max(0, params.cacheRead ?? 0) === 0 }
            : {}),
        },
      };
    });
  }

  async queueUserNotice(
    sessionKey: string,
    notice: PendingUserNotice,
  ): Promise<SessionDiagnosticsSnapshot> {
    return await this.setSession(sessionKey, (current) => {
      if (current.lastDeliveredUserNotice?.key === notice.key) {
        return {};
      }
      if (current.pendingUserNotice?.key === notice.key) {
        return {
          userNoticeSource: current.pendingUserNotice.source,
        };
      }
      if (current.pendingUserNotice) {
        if (current.pendingUserNotice.priority < notice.priority) {
          return {
            userNoticeSource: current.pendingUserNotice.source,
          };
        }
        if (
          current.pendingUserNotice.priority === notice.priority &&
          current.pendingUserNotice.createdAt >= notice.createdAt
        ) {
          return {
            userNoticeSource: current.pendingUserNotice.source,
          };
        }
      }
      return {
        pendingUserNotice: notice,
        userNoticeSource: notice.source,
      };
    });
  }

  async markUserNoticeDelivered(params: {
    sessionKey: string;
    language?: UserNoticeLanguage;
    message?: string;
  }): Promise<SessionDiagnosticsSnapshot> {
    return await this.setSession(params.sessionKey, (current) => {
      if (!current.pendingUserNotice) {
        return {};
      }
      const language = params.language ?? current.pendingUserNotice.language;
      const message = params.message ?? current.pendingUserNotice.message;
      if (!language || !message) {
        return {};
      }
      return {
        pendingUserNotice: undefined,
        lastDeliveredUserNotice: {
          ...current.pendingUserNotice,
          deliveredAt: nowIso(),
          language,
          message,
        },
        userNoticeSource: current.pendingUserNotice.source,
      };
    });
  }

  async getOverview(): Promise<DiagnosticsOverview> {
    await this.ensureReady();
    const snapshots = existsSync(this.sessionsDir)
      ? (
          await Promise.all(
            (await fs.readdir(this.sessionsDir))
              .filter((name) => name.endsWith(".json"))
              .map((name) => readJsonFile<SessionDiagnosticsSnapshot>(join(this.sessionsDir, name))),
          )
        ).filter(Boolean) as SessionDiagnosticsSnapshot[]
      : [];

    const lastCompaction = snapshots
      .filter((snapshot) => snapshot.lastCompaction)
      .sort((left, right) =>
        (right.lastCompaction?.at ?? "").localeCompare(left.lastCompaction?.at ?? ""),
      )[0];
    const recentFailures = snapshots
      .flatMap((snapshot) =>
        snapshot.failSoft.map((item) => ({ ...item, sessionKey: snapshot.sessionKey })),
      )
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 10);

    return {
      engineId: this.engineId,
      trackedSessions: snapshots.length,
      ...(lastCompaction?.lastCompaction
        ? {
            lastCompaction: {
              ...lastCompaction.lastCompaction,
              sessionKey: lastCompaction.sessionKey,
            },
          }
        : {}),
      recentFailures,
    };
  }
}
