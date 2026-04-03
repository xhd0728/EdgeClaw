#!/usr/bin/env npx tsx
/**
 * Gallery: shows companions for multiple seeds.
 * Run: npx tsx extensions/edgeclaw-buddy/demo-gallery.ts
 */
import { roll } from "./src/core/companion.js";
import { renderFace, renderSprite } from "./src/core/sprites.js";
import { RARITY_STARS } from "./src/core/types.js";

const seeds = [
  "alice",
  "bob",
  "miwi",
  "dragon-fan",
  "lucky7",
  "edgeclaw",
  "test123",
  "hello-world",
];

for (const seed of seeds) {
  const { bones } = roll(seed);
  const sprite = renderSprite(bones, 0);
  const face = renderFace(bones);
  const stars = RARITY_STARS[bones.rarity];
  const hatInfo = bones.hat !== "none" ? ` hat:${bones.hat}` : "";
  const shinyInfo = bones.shiny ? " ✨SHINY✨" : "";

  console.log(`  ┌─ ${seed} ${"─".repeat(Math.max(0, 30 - seed.length))}┐`);
  for (const line of sprite) {
    console.log(`  │ ${line} │`);
  }
  console.log(`  │ ${face} ${bones.species} ${bones.rarity} ${stars}${hatInfo}${shinyInfo}`);
  console.log(`  └${"─".repeat(34)}┘`);
  console.log();
}
