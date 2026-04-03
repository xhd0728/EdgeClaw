import { Type } from "@sinclair/typebox";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const PLUGIN_ID = "openbmb-clawxcontext";
export const DEFAULT_PROTECTED_RECENT_TURNS = 6;
export const DEFAULT_AUTO_COMPACT_RESERVE_TOKENS = 13_000;
export const DEFAULT_REINJECT_RECENT_FILES = 5;
export const DEFAULT_REINJECT_CRITICAL_TOOL_OUTPUTS = 5;

export type PluginRuntimeConfig = {
  dataDir: string;
  protectedRecentTurns: number;
  snipEnabled: boolean;
  microcompactEnabled: boolean;
  autoCompactEnabled: boolean;
  autoCompactReserveTokens: number;
  reinjectSummary: boolean;
  reinjectRecentFiles: number;
  reinjectCriticalToolOutputs: number;
};

export const pluginConfigJsonSchema = Type.Object(
  {
    dataDir: Type.Optional(
      Type.String({
        description: "Base directory used to persist ClawXContext state.",
      }),
    ),
    protectedRecentTurns: Type.Optional(Type.Integer({ default: DEFAULT_PROTECTED_RECENT_TURNS })),
    snipEnabled: Type.Optional(Type.Boolean({ default: true })),
    microcompactEnabled: Type.Optional(Type.Boolean({ default: true })),
    autoCompactEnabled: Type.Optional(Type.Boolean({ default: true })),
    autoCompactReserveTokens: Type.Optional(
      Type.Integer({ default: DEFAULT_AUTO_COMPACT_RESERVE_TOKENS }),
    ),
    reinjectSummary: Type.Optional(Type.Boolean({ default: true })),
    reinjectRecentFiles: Type.Optional(Type.Integer({ default: DEFAULT_REINJECT_RECENT_FILES })),
    reinjectCriticalToolOutputs: Type.Optional(
      Type.Integer({ default: DEFAULT_REINJECT_CRITICAL_TOOL_OUTPUTS }),
    ),
  },
  {
    additionalProperties: false,
  },
);

export const pluginConfigUiHints = {
  dataDir: {
    label: "Data Directory",
    placeholder: "~/.openclaw/clawxcontext",
  },
  protectedRecentTurns: {
    label: "Protected Recent Turns",
    placeholder: String(DEFAULT_PROTECTED_RECENT_TURNS),
  },
  autoCompactReserveTokens: {
    label: "Auto Compact Reserve Tokens",
    placeholder: String(DEFAULT_AUTO_COMPACT_RESERVE_TOKENS),
  },
  reinjectRecentFiles: {
    label: "Reinject Recent Files",
    placeholder: String(DEFAULT_REINJECT_RECENT_FILES),
  },
  reinjectCriticalToolOutputs: {
    label: "Reinject Critical Tool Outputs",
    placeholder: String(DEFAULT_REINJECT_CRITICAL_TOOL_OUTPUTS),
  },
} as const;

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

function readString(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

function readBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

function readInteger(raw: unknown, fallback: number, minimum = 0): number {
  const next =
    typeof raw === "number"
      ? Math.trunc(raw)
      : typeof raw === "string" && raw.trim()
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN;
  if (!Number.isFinite(next)) return fallback;
  return Math.max(minimum, next);
}

export function buildPluginConfig(raw: Record<string, unknown> | undefined): PluginRuntimeConfig {
  const defaultDataDir = resolve(homedir(), ".openclaw/clawxcontext");
  return {
    dataDir: expandHome(readString(raw?.dataDir, defaultDataDir)),
    protectedRecentTurns: readInteger(
      raw?.protectedRecentTurns,
      DEFAULT_PROTECTED_RECENT_TURNS,
      1,
    ),
    snipEnabled: readBoolean(raw?.snipEnabled, true),
    microcompactEnabled: readBoolean(raw?.microcompactEnabled, true),
    autoCompactEnabled: readBoolean(raw?.autoCompactEnabled, true),
    autoCompactReserveTokens: readInteger(
      raw?.autoCompactReserveTokens,
      DEFAULT_AUTO_COMPACT_RESERVE_TOKENS,
      0,
    ),
    reinjectSummary: readBoolean(raw?.reinjectSummary, true),
    reinjectRecentFiles: readInteger(
      raw?.reinjectRecentFiles,
      DEFAULT_REINJECT_RECENT_FILES,
      0,
    ),
    reinjectCriticalToolOutputs: readInteger(
      raw?.reinjectCriticalToolOutputs,
      DEFAULT_REINJECT_CRITICAL_TOOL_OUTPUTS,
      0,
    ),
  };
}
