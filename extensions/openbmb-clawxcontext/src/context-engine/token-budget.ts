import type { ContextMessage } from "./types.js";

export function estimateMessageTokens(message: ContextMessage): number {
  const serialized = JSON.stringify(message);
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export function estimateMessagesTokens(messages: readonly ContextMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

export function trimMessagesToBudget(params: {
  messages: ContextMessage[];
  tokenBudget: number | undefined;
  pinnedIndexes?: Set<number>;
  atomicUnits?: number[][];
}) {
  const tokenBudget = params.tokenBudget;
  const pinnedIndexes = params.pinnedIndexes ?? new Set<number>();
  const working = [...params.messages];
  let estimatedTokens = estimateMessagesTokens(working);
  let trimmed = false;
  const allIndexes = working.map((_, index) => index);

  if (!tokenBudget || tokenBudget <= 0 || estimatedTokens <= tokenBudget) {
    return {
      messages: working,
      estimatedTokens,
      trimmed,
      retainedIndexes: allIndexes,
    };
  }

  const units = normalizeAtomicUnits(working.length, params.atomicUnits);
  const droppedUnitIndexes = new Set<number>();
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    const indexes = units[unitIndex]!;
    const unitPinned = indexes.some((index) => pinnedIndexes.has(index));
    if (unitPinned || estimatedTokens <= tokenBudget) {
      continue;
    }
    droppedUnitIndexes.add(unitIndex);
    trimmed = true;
    estimatedTokens -= indexes.reduce((total, index) => total + estimateMessageTokens(working[index]!), 0);
  }

  const retainedIndexes = units
    .flatMap((indexes, unitIndex) => (droppedUnitIndexes.has(unitIndex) ? [] : indexes))
    .sort((left, right) => left - right);
  const nextMessages = retainedIndexes.map((index) => working[index]!);
  estimatedTokens = estimateMessagesTokens(nextMessages);

  return {
    messages: nextMessages,
    estimatedTokens,
    trimmed,
    retainedIndexes,
  };
}

function normalizeAtomicUnits(totalMessages: number, atomicUnits: number[][] | undefined): number[][] {
  if (!atomicUnits?.length) {
    return Array.from({ length: totalMessages }, (_, index) => [index]);
  }

  const normalized: number[][] = [];
  const covered = new Set<number>();

  for (const candidate of atomicUnits) {
    const indexes = [...new Set(candidate)]
      .filter((index) => Number.isInteger(index) && index >= 0 && index < totalMessages)
      .sort((left, right) => left - right)
      .filter((index) => {
        if (covered.has(index)) return false;
        covered.add(index);
        return true;
      });
    if (indexes.length > 0) {
      normalized.push(indexes);
    }
  }

  for (let index = 0; index < totalMessages; index++) {
    if (!covered.has(index)) {
      normalized.push([index]);
    }
  }

  normalized.sort((left, right) => left[0]! - right[0]!);
  return normalized;
}
