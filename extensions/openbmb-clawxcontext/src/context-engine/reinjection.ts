import type { PluginRuntimeConfig } from "../config.js";
import { getReinjectionModeForStage } from "./pressure.js";
import type { ContextMessage, PressureStage, ReinjectionMode, ReinjectionSnapshot } from "./types.js";

function trimLine(value: string, maxLength = 240): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

export function buildReinjectionSnapshot(params: {
  config: PluginRuntimeConfig;
  summary?: string;
  recentFiles: string[];
  criticalToolOutputs: string[];
  mode?: ReinjectionMode;
  stage?: PressureStage;
}): ReinjectionSnapshot | undefined {
  const mode = params.mode ?? getReinjectionModeForStage(params.stage ?? "normal");
  const summary = params.config.reinjectSummary ? trimLine(params.summary ?? "", 600) : "";
  const recentFiles =
    mode === "summary-only"
      ? []
      : params.recentFiles.slice(0, params.config.reinjectRecentFiles);
  const criticalToolOutputs =
    mode === "summary+recent-files+critical-outputs"
      ? params.criticalToolOutputs.slice(0, params.config.reinjectCriticalToolOutputs)
      : [];

  if (!summary && recentFiles.length === 0 && criticalToolOutputs.length === 0) {
    return undefined;
  }

  const rendered = buildReinjectionText({
    recentFiles,
    criticalToolOutputs,
    ...(summary ? { summary } : {}),
  });

  return {
    mode,
    ...(summary ? { summary } : {}),
    recentFiles,
    criticalToolOutputs,
    rendered,
  };
}

export function buildReinjectionText(snapshot: {
  summary?: string;
  recentFiles: string[];
  criticalToolOutputs: string[];
}): string {
  const sections: string[] = [
    "Context block maintained by ClawXContext. This is short-term context scaffolding, not a user request.",
  ];

  if (snapshot.summary?.trim()) {
    sections.push(`Compact summary:\n${snapshot.summary.trim()}`);
  }
  if (snapshot.recentFiles.length > 0) {
    sections.push(`Recent files:\n- ${snapshot.recentFiles.join("\n- ")}`);
  }
  if (snapshot.criticalToolOutputs.length > 0) {
    sections.push(`Recent critical tool outputs:\n- ${snapshot.criticalToolOutputs.join("\n- ")}`);
  }

  return sections.join("\n\n");
}

export function buildReinjectionMessage(snapshot: ReinjectionSnapshot): ContextMessage {
  return {
    role: "user",
    content: snapshot.rendered ?? buildReinjectionText(snapshot),
    timestamp: Date.now(),
  } as ContextMessage;
}

export function injectReinjectionMessage(
  messages: readonly ContextMessage[],
  snapshot: ReinjectionSnapshot | undefined,
): { messages: ContextMessage[]; insertedIndex?: number } {
  if (!snapshot?.rendered?.trim()) {
    return { messages: [...messages] };
  }

  const reinjectionMessage = buildReinjectionMessage(snapshot);
  const working = [...messages];
  const lastIndex = working.length - 1;
  if (lastIndex >= 0 && working[lastIndex]?.role === "user") {
    working.splice(lastIndex, 0, reinjectionMessage);
    return { messages: working, insertedIndex: lastIndex };
  }
  working.push(reinjectionMessage);
  return { messages: working, insertedIndex: working.length - 1 };
}
