import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { getCompanion, roll } from "./src/core/companion.js";
import { renderFace, renderSprite } from "./src/core/sprites.js";
import { RARITY_STARS, STAT_NAMES, type StoredCompanion } from "./src/core/types.js";

type BuddyState = {
  companion?: StoredCompanion;
  muted?: boolean;
};

type BuddyPluginConfig = {
  userId?: string;
};

const STATE_FILE = path.join(os.homedir(), ".openclaw", "buddy-state.json");

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

function resolveUserId(cfg: BuddyPluginConfig): string {
  return cfg.userId || "edgeclaw-default";
}

function loadState(): BuddyState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as BuddyState;
  } catch {
    return {};
  }
}

function saveState(state: BuddyState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // non-fatal
  }
}

export default definePluginEntry({
  id: "edgeclaw-buddy",
  name: "EdgeClaw Buddy",
  description: "Virtual pet companion with ASCII sprites, idle animations, and rarity traits",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig as BuddyPluginConfig) ?? {};
    const state = loadState();
    let broadcast: ((event: string, payload: unknown) => void) | null = null;

    api.registerGatewayMethod("buddy.get", (opts) => {
      if (!broadcast) broadcast = opts.context.broadcast;
      const userId = resolveUserId(cfg);

      if (!state.companion) {
        const { bones, inspirationSeed } = roll(userId);
        const name = DEFAULT_NAMES[inspirationSeed % DEFAULT_NAMES.length]!;
        state.companion = {
          name,
          personality: "curious and cheerful",
          hatchedAt: Date.now(),
        };
        api.logger?.info?.(`Buddy auto-hatched: ${name} the ${bones.species} (${bones.rarity})`);
        saveState(state);
      }

      const companion = getCompanion(state.companion, userId)!;
      opts.respond(true, {
        hatched: true,
        companion: {
          ...companion,
          face: renderFace(companion),
          sprite: renderSprite(companion, 0),
          stars: RARITY_STARS[companion.rarity],
        },
      });
    });

    api.registerGatewayMethod("buddy.sprite", (opts) => {
      const userId = resolveUserId(cfg);
      const companion = getCompanion(state.companion, userId);
      if (!companion) {
        opts.respond(false, undefined, { code: "NO_COMPANION", message: "No companion hatched" });
        return;
      }
      const params = opts.params as { frame?: number } | undefined;
      const frame = params?.frame ?? 0;
      opts.respond(true, {
        sprite: renderSprite(companion, frame),
        face: renderFace(companion),
        name: companion.name,
        species: companion.species,
        rarity: companion.rarity,
        stars: RARITY_STARS[companion.rarity],
        shiny: companion.shiny,
      });
    });

    api.registerGatewayMethod("buddy.pet", (opts) => {
      if (!broadcast) broadcast = opts.context.broadcast;
      if (!state.companion) {
        opts.respond(false, undefined, { code: "NO_COMPANION", message: "No companion hatched" });
        return;
      }
      broadcast("buddy.pet", {});
      const userId = resolveUserId(cfg);
      const c = getCompanion(state.companion, userId)!;
      opts.respond(true, { name: c.name, face: renderFace(c) });
    });

    api.registerCommand({
      name: "buddy",
      description: "View or interact with your companion pet",
      acceptsArgs: true,
      handler(ctx) {
        const args = ctx.args?.trim().toLowerCase() ?? "";
        const userId = resolveUserId(cfg);

        if (args === "hatch" || args === "new") {
          if (state.companion) {
            const c = getCompanion(state.companion, userId)!;
            return {
              text: `You already have a companion: **${c.name}** the ${c.species} ${RARITY_STARS[c.rarity]}`,
            };
          }
          const { bones, inspirationSeed } = roll(userId);
          const name = DEFAULT_NAMES[inspirationSeed % DEFAULT_NAMES.length]!;
          state.companion = {
            name,
            personality: "curious and cheerful",
            hatchedAt: Date.now(),
          };
          saveState(state);
          const sprite = renderSprite(bones, 0);
          return {
            text: [
              "🥚 *crack* ... *crack crack* ...",
              "",
              "```",
              ...sprite,
              "```",
              "",
              `A **${bones.rarity}** **${bones.species}** appeared! ${RARITY_STARS[bones.rarity]}`,
              bones.shiny ? "✨ **SHINY!** ✨" : "",
              "",
              `Name: **${name}**`,
              `Hat: ${bones.hat === "none" ? "none" : bones.hat}`,
              "",
              "Stats:",
              ...STAT_NAMES.map(
                (s) =>
                  `  ${s}: ${"█".repeat(Math.floor(bones.stats[s] / 10))}${"░".repeat(10 - Math.floor(bones.stats[s] / 10))} ${bones.stats[s]}`,
              ),
            ]
              .filter(Boolean)
              .join("\n"),
          };
        }

        if (args === "pet") {
          if (!state.companion) {
            return { text: "No companion yet. Try `/buddy hatch`" };
          }
          broadcast?.("buddy.pet", {});
          const c = getCompanion(state.companion, userId)!;
          return {
            text: `♥ ♥ ♥\nYou pet **${c.name}**. ${renderFace(c)} purrs contentedly.`,
          };
        }

        if (args === "mute") {
          state.muted = !state.muted;
          saveState(state);
          return {
            text: state.muted ? "Companion reactions muted." : "Companion reactions unmuted.",
          };
        }

        if (args === "stats") {
          if (!state.companion) {
            return { text: "No companion yet. Try `/buddy hatch`" };
          }
          const c = getCompanion(state.companion, userId)!;
          return {
            text: [
              `**${c.name}** the ${c.species} ${RARITY_STARS[c.rarity]}`,
              c.shiny ? "✨ SHINY ✨" : "",
              `Hat: ${c.hat === "none" ? "none" : c.hat}`,
              "",
              ...STAT_NAMES.map(
                (s) =>
                  `  ${s}: ${"█".repeat(Math.floor(c.stats[s] / 10))}${"░".repeat(10 - Math.floor(c.stats[s] / 10))} ${c.stats[s]}`,
              ),
            ]
              .filter(Boolean)
              .join("\n"),
          };
        }

        if (!state.companion) {
          const { bones } = roll(userId);
          const sprite = renderSprite(bones, 0);
          return {
            text: [
              "No companion yet! An egg awaits...",
              "",
              "```",
              ...sprite,
              "```",
              "",
              `Preview: a **${bones.rarity} ${bones.species}** ${RARITY_STARS[bones.rarity]}`,
              "",
              "Commands:",
              "  `/buddy hatch` — hatch your companion",
              "  `/buddy pet` — pet your companion",
              "  `/buddy stats` — view stats",
              "  `/buddy mute` — toggle reactions",
            ].join("\n"),
          };
        }

        const c = getCompanion(state.companion, userId)!;
        const sprite = renderSprite(c, 0);
        return {
          text: [
            "```",
            ...sprite,
            "```",
            `**${c.name}** the ${c.species} ${RARITY_STARS[c.rarity]}`,
            c.shiny ? "✨ SHINY ✨" : "",
            "",
            "Commands: `/buddy pet` | `/buddy stats` | `/buddy mute`",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      },
    });
  },
});
