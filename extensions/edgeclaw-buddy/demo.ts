#!/usr/bin/env npx tsx
/**
 * Quick demo: renders a random buddy companion in the terminal.
 * Run:  npx tsx extensions/edgeclaw-buddy/demo.ts
 *   or: npx tsx extensions/edgeclaw-buddy/demo.ts <seed>
 */
import { roll, rollWithSeed } from "./src/core/companion.js";
import { renderFace, renderSprite, spriteFrameCount } from "./src/core/sprites.js";
import { RARITY_STARS, STAT_NAMES } from "./src/core/types.js";

const seed = process.argv[2] || `demo-${Date.now()}`;
const { bones, inspirationSeed } = seed.startsWith("demo-") ? rollWithSeed(seed) : roll(seed);

const DEFAULT_NAMES = [
  "Pip",
  "Mochi",
  "Bloop",
  "Nyx",
  "Quill",
  "Dusk",
  "Sprout",
  "Fern",
  "Zap",
  "Twig",
];
const name = DEFAULT_NAMES[inspirationSeed % DEFAULT_NAMES.length]!;

console.log();
console.log("  🥚 *crack* ... *crack crack* ...");
console.log();

// Show all 3 animation frames
const frameCount = spriteFrameCount(bones.species);
for (let f = 0; f < frameCount; f++) {
  const sprite = renderSprite(bones, f);
  if (f === 0) {
    console.log("  Frame 0 (idle):");
  } else {
    console.log(`  Frame ${f} (fidget):`);
  }
  for (const line of sprite) {
    console.log(`    ${line}`);
  }
  console.log();
}

console.log(`  Name:    ${name}`);
console.log(`  Species: ${bones.species}`);
console.log(`  Rarity:  ${bones.rarity} ${RARITY_STARS[bones.rarity]}`);
console.log(`  Eyes:    ${bones.eye}`);
console.log(`  Hat:     ${bones.hat}`);
console.log(`  Shiny:   ${bones.shiny ? "✨ YES ✨" : "no"}`);
console.log(`  Face:    ${renderFace(bones)}`);
console.log();
console.log("  Stats:");
for (const s of STAT_NAMES) {
  const val = bones.stats[s];
  const bar = "█".repeat(Math.floor(val / 10)) + "░".repeat(10 - Math.floor(val / 10));
  console.log(`    ${s.padEnd(10)} ${bar} ${val}`);
}
console.log();

// Animated idle demo
console.log("  --- Idle animation (press Ctrl+C to stop) ---");
console.log();

const IDLE_SEQUENCE = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0,
  0, 0, 1, 0, 0, 0, 0,
];

let idx = 0;
const spriteHeight = renderSprite(bones, 0).length + 2; // +2 for name line + blank

function renderFrame() {
  const frame = IDLE_SEQUENCE[idx % IDLE_SEQUENCE.length]!;
  const sprite = renderSprite(bones, frame);

  // Move cursor up to overwrite previous frame
  if (idx > 0) {
    process.stdout.write(`\x1b[${spriteHeight}A`);
  }

  for (const line of sprite) {
    process.stdout.write(`    ${line}\n`);
  }
  const label = bones.shiny
    ? `    ✨ ${name} ${RARITY_STARS[bones.rarity]} ✨`
    : `    ${name} ${RARITY_STARS[bones.rarity]}`;
  process.stdout.write(`${label}\n`);
  process.stdout.write("\n");

  idx++;
}

renderFrame();
const timer = setInterval(renderFrame, 500);

process.on("SIGINT", () => {
  clearInterval(timer);
  console.log("\n  Bye bye! 👋\n");
  process.exit(0);
});
