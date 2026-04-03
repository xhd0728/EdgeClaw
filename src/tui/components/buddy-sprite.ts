import { Container, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";

// Matches Claude Code CompanionSprite exactly.
// -1 means "blink on frame 0" (eyes replaced with '-').
const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0];

const TICK_MS = 150;
const BUBBLE_SHOW_TICKS = 67; // ~10s at 150ms
const FADE_TICKS = 20; // last ~3s the bubble dims
const PET_BURST_MS = 2_500;

const H = "♥";
const PET_HEARTS = [
  `   ${H}    ${H}   `,
  `  ${H}  ${H}   ${H}  `,
  ` ${H}   ${H}  ${H}   `,
  `${H}  ${H}      ${H} `,
  `·    ·   ·  `,
];

export type BuddySpriteState = {
  name: string;
  species: string;
  rarity: string;
  stars: string;
  shiny: boolean;
  eye: string;
  spriteFrames: string[][];
  face: string;
};

type SpeechBubble = {
  text: string;
  startedAt: number;
  startTick: number;
};

export class BuddySpriteComponent extends Container {
  private state: BuddySpriteState | null = null;
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bubble: SpeechBubble | null = null;
  private petAt: number | null = null;
  private petStartTick = 0;
  private onRequestRender: (() => void) | null = null;
  private visible = true;
  private narrowMode = false;
  private termColumns = 120;

  setRenderCallback(cb: () => void) {
    this.onRequestRender = cb;
  }

  setTermColumns(cols: number) {
    this.termColumns = cols;
    this.narrowMode = cols < 100;
  }

  setCompanion(state: BuddySpriteState) {
    this.state = state;
    this.redraw();
  }

  setVisible(v: boolean) {
    if (this.visible === v) {
      return;
    }
    this.visible = v;
    if (v) {
      this.startAnimation();
      this.redraw();
    } else {
      this.stopAnimation();
      this.clear();
    }
  }

  showReaction(text: string) {
    this.bubble = { text, startedAt: Date.now(), startTick: this.tick };
    this.redraw();
  }

  triggerPet() {
    this.petAt = Date.now();
    this.petStartTick = this.tick;
    this.redraw();
  }

  startAnimation() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.tick++;

      if (this.bubble && this.tick - this.bubble.startTick >= BUBBLE_SHOW_TICKS) {
        this.bubble = null;
      }
      if (this.petAt && Date.now() - this.petAt > PET_BURST_MS) {
        this.petAt = null;
      }

      this.redraw();
      this.onRequestRender?.();
    }, TICK_MS);
  }

  stopAnimation() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private redraw() {
    this.clear();
    if (!this.state || !this.visible) {
      return;
    }

    const { name, stars, shiny, eye } = this.state;
    const frameCount = this.state.spriteFrames.length;
    const petting = this.petAt !== null;
    const reacting = this.bubble !== null;

    let spriteFrame: number;
    let blink = false;

    if (reacting || petting) {
      spriteFrame = this.tick % frameCount;
    } else {
      const step = IDLE_SEQUENCE[this.tick % IDLE_SEQUENCE.length];
      if (step === -1) {
        spriteFrame = 0;
        blink = true;
      } else {
        spriteFrame = step % frameCount;
      }
    }

    let spriteLines = this.state.spriteFrames[spriteFrame % frameCount];
    if (blink) {
      spriteLines = spriteLines.map((line) => line.replaceAll(eye, "-"));
    }

    if (this.narrowMode) {
      this.renderNarrow(name, stars, shiny, petting);
      return;
    }

    if (petting) {
      const petAge = this.tick - this.petStartTick;
      const heartLine = PET_HEARTS[petAge % PET_HEARTS.length];
      this.addChild(new Text(theme.error(heartLine), 0, 0));
    }

    // Sprite lines + optional speech bubble beside it
    const bubbleLines = this.bubble
      ? this.wrapBubble(this.bubble.text, reacting && !this.isBubbleFading())
      : [];
    const maxLines = Math.max(spriteLines.length, bubbleLines.length);
    const spriteOffset = maxLines - spriteLines.length;
    const bubbleOffset = maxLines - bubbleLines.length;

    for (let i = 0; i < maxLines; i++) {
      const si = i - spriteOffset;
      const bi = i - bubbleOffset;
      const spritePart = si >= 0 && si < spriteLines.length ? spriteLines[si] : "            ";
      const bubblePart = bi >= 0 && bi < bubbleLines.length ? `  ${bubbleLines[bi]}` : "";
      const line = theme.dim(spritePart) + (bubblePart ? theme.system(bubblePart) : "");
      this.addChild(new Text(line, 0, 0));
    }

    // Name + rarity below
    const nameLabel = shiny ? `✨ ${name} ${stars} ✨` : `    ${name} ${stars}`;
    this.addChild(new Text(theme.accent(nameLabel), 0, 0));
  }

  private isBubbleFading(): boolean {
    if (!this.bubble) {
      return false;
    }
    return this.tick - this.bubble.startTick >= BUBBLE_SHOW_TICKS - FADE_TICKS;
  }

  private renderNarrow(name: string, stars: string, shiny: boolean, petting: boolean) {
    const face = this.state!.face;
    const quip = this.bubble
      ? this.bubble.text.length > 24
        ? `"${this.bubble.text.slice(0, 23)}…"`
        : `"${this.bubble.text}"`
      : "";
    const petText = petting ? `${H} ` : "";
    const label = quip || `${name} ${stars}`;
    const line = shiny ? `✨${face} ${label}` : `${petText}${face} ${label}`;
    this.addChild(new Text(theme.dim(`  ${line}`), 0, 0));
  }

  private wrapBubble(text: string, bright: boolean): string[] {
    const maxWidth = Math.min(30, Math.max(10, this.termColumns - 20));
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = "";

    for (const word of words) {
      if (current.length + word.length + 1 > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) {
      lines.push(current);
    }

    if (lines.length === 0) {
      return [];
    }

    const width = Math.max(...lines.map((l) => l.length));
    const border = bright ? "╭╮│╰╯─" : "╭╮│╰╯─";
    const top = `${border[0]}${border[5].repeat(width + 2)}${border[1]}`;
    const bottom = `${border[3]}${border[5].repeat(width + 2)}${border[4]}`;
    const body = lines.map((l) => `${border[2]} ${l.padEnd(width)} ${border[2]}`);
    const tail = ["  ╲ ", "  ╲"];
    return [top, ...body, bottom, ...tail];
  }

  destroy() {
    this.stopAnimation();
  }
}
