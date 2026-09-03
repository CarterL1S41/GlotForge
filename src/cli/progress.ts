/**
 * Single-line progress bar, redrawn in place (translation-harness style
 * upgraded from incremental [n/total] lines). Falls back to occasional plain
 * lines when stdout isn't a TTY (CI logs).
 */

const BAR_WIDTH = 24;
const FILLED = "█";
const EMPTY = "░";

export class ProgressBar {
  private lastLength = 0;
  private lastLoggedPercent = -10;

  constructor(private readonly total: number) {}

  update(done: number, detail: string): void {
    if (this.total === 0) return;
    const ratio = Math.min(1, done / this.total);
    if (process.stdout.isTTY) {
      const filled = Math.round(ratio * BAR_WIDTH);
      const bar = FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled);
      const line = `${bar} ${done}/${this.total}  ${detail}`;
      const padded = line.padEnd(this.lastLength);
      this.lastLength = line.length;
      process.stdout.write("\r" + padded);
    } else {
      const percent = Math.floor(ratio * 100);
      if (percent >= this.lastLoggedPercent + 10 || done === this.total) {
        this.lastLoggedPercent = percent;
        console.log(`[${percent}%] ${done}/${this.total}  ${detail}`);
      }
    }
  }

  finish(): void {
    if (process.stdout.isTTY && this.lastLength > 0) {
      process.stdout.write("\n");
    }
    this.lastLength = 0;
  }
}
