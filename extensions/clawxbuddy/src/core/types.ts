export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export type Species = "cat" | "dog" | "dragon" | "fox" | "owl" | "bunny" | "turtle" | "axolotl";
export type Hat = "none" | "tophat" | "crown" | "beanie" | "wizard" | "bow" | "cap";

export const STAT_NAMES = ["vigor", "charm", "wit", "luck", "speed"] as const;
export type StatName = (typeof STAT_NAMES)[number];

export const RARITY_STARS: Record<Rarity, string> = {
  common: "☆",
  uncommon: "★",
  rare: "★★",
  epic: "★★★",
  legendary: "★★★★★",
};

export interface CompanionBones {
  species: Species;
  rarity: Rarity;
  shiny: boolean;
  hat: Hat;
  stats: Record<StatName, number>;
}

export interface StoredCompanion {
  name: string;
  personality: string;
  hatchedAt: number;
}

export interface Companion extends CompanionBones {
  name: string;
  personality: string;
  hatchedAt: number;
}
