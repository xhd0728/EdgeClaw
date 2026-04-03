import type {
  Companion,
  CompanionBones,
  Hat,
  Rarity,
  Species,
  StatName,
  StoredCompanion,
  STAT_NAMES as StatNamesConst,
} from "./types.js";
import { STAT_NAMES } from "./types.js";

const SPECIES_LIST: Species[] = ["cat", "dog", "dragon", "fox", "owl", "bunny", "turtle", "axolotl"];
const RARITY_TABLE: Rarity[] = ["common", "common", "common", "uncommon", "uncommon", "rare", "rare", "epic", "legendary"];
const HAT_LIST: Hat[] = ["none", "none", "none", "tophat", "crown", "beanie", "wizard", "bow", "cap"];

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function seededRand(seed: number, index: number): number {
  let s = seed + index * 2654435761;
  s = ((s >>> 16) ^ s) * 0x45d9f3b;
  s = ((s >>> 16) ^ s) * 0x45d9f3b;
  s = (s >>> 16) ^ s;
  return Math.abs(s);
}

function generateBones(seed: string): CompanionBones {
  const h = hashSeed(seed);
  const species = SPECIES_LIST[seededRand(h, 0) % SPECIES_LIST.length];
  const rarity = RARITY_TABLE[seededRand(h, 1) % RARITY_TABLE.length];
  const shiny = seededRand(h, 2) % 100 < 5;
  const hat = HAT_LIST[seededRand(h, 3) % HAT_LIST.length];

  const stats = {} as Record<StatName, number>;
  for (let i = 0; i < STAT_NAMES.length; i++) {
    stats[STAT_NAMES[i]] = 10 + (seededRand(h, 10 + i) % 91);
  }

  return { species, rarity, shiny, hat, stats };
}

export function roll(seed: string): { bones: CompanionBones; inspirationSeed: number } {
  const bones = generateBones(seed);
  return { bones, inspirationSeed: hashSeed(seed) };
}

export function rollWithSeed(seed: string): { bones: CompanionBones; inspirationSeed: number } {
  return roll(seed);
}

export function getCompanion(
  stored: StoredCompanion | undefined,
  userId: string,
): Companion | undefined {
  if (!stored) return undefined;
  const bones = generateBones(userId);
  return { ...bones, name: stored.name, personality: stored.personality, hatchedAt: stored.hatchedAt };
}
