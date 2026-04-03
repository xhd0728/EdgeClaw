import type { Companion, CompanionBones, Species } from "./types.js";

type SpriteTarget = Companion | CompanionBones;

const FACES: Record<Species, string[]> = {
  cat:      ["(=^・ω・^=)", "(=^・ェ・^=)", "(=^._.^=)"],
  dog:      ["∪・ω・∪",    "▼・ᴥ・▼",    "U・ᴥ・U"],
  dragon:   ["🐉>ω<",      "🐲~ω~",      "🐉^ω^"],
  fox:      ["つ・ω・つ",   "⊂・ω・⊃",   "つ≧▽≦つ"],
  owl:      ["(⊙v⊙)",     "(⊙ω⊙)",     "(◉Θ◉)"],
  bunny:    ["(・x・)",     "(・ⅹ・)",     "(=・x・=)"],
  turtle:   ["(・_・)",     "(._.)",       "(˘ω˘)"],
  axolotl:  [":3",          "(:3 )",       "~(:3 )~"],
};

const BODY_FRAMES: string[][] = [
  ["  ╱|、", "(˚ˎ。7", " |、˜〵", " じしˍ,)ノ"],
  ["  ╱|、", "(˚ˎ。7", " |、˜ /", " じしˍ,)~"],
];

export const spriteFrameCount = BODY_FRAMES.length;

function resolveSpecies(target: SpriteTarget): Species {
  return target.species;
}

export function renderFace(target: SpriteTarget): string {
  const species = resolveSpecies(target);
  const faces = FACES[species] ?? FACES.cat;
  const idx = "name" in target ? target.name.length % faces.length : 0;
  return faces[idx];
}

export function renderSprite(target: SpriteTarget, frame: number): string[] {
  const face = renderFace(target);
  const hat = "hat" in target && target.hat !== "none" ? `   🎩 ${target.hat}` : "";
  const shiny = "shiny" in target && target.shiny ? " ✨" : "";
  const body = BODY_FRAMES[frame % BODY_FRAMES.length];
  return [hat, `  ${face}${shiny}`, ...body].filter(Boolean);
}
