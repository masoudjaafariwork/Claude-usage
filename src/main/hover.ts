// "Opaque on hover": a see-through overlay (Opacity < 100 %) turns fully opaque while the cursor is
// over it (D57). The page can't see the cursor itself — on Windows the drag region swallows mouse
// events, so neither :hover nor mouseenter fire over the card — so the main process polls the cursor
// position against the window's bounds while it matters (see-through, visible, not locked).
import type { Rect } from './window-core';

export interface Point {
  x: number;
  y: number;
}

/** Poll interval: quick enough to feel instant, a negligible cost (one cursor read per tick). */
export const HOVER_POLL_MS = 100;

export function containsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

export interface HoverWatchDeps {
  /** Cursor position, in the same coordinates as `bounds()`. */
  cursor(): Point;
  bounds(): Rect;
  /** Called on every change of the hover state (not on every poll). */
  onChange(hovered: boolean): void;
}

export class HoverWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private hovered = false;
  /** After an Opacity change the cursor counts as away until it leaves once, so the new value shows. */
  private held = false;

  constructor(private readonly deps: HoverWatchDeps) {}

  /** Polls while `on`; switching off reports "not hovered" and forgets a hold. */
  setActive(on: boolean): void {
    if (on) {
      if (this.timer) return;
      this.timer = setInterval(() => this.check(), HOVER_POLL_MS);
      this.check();
    } else {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.held = false;
      this.set(false);
    }
  }

  /**
   * The Opacity setting was just changed (the menu opens over the overlay, so the cursor is usually
   * on it): show the new value until the cursor has left the overlay once.
   */
  holdUntilLeave(): void {
    this.held = true;
    this.set(false);
  }

  check(): void {
    const inside = containsPoint(this.deps.bounds(), this.deps.cursor());
    if (!inside) this.held = false;
    this.set(inside && !this.held);
  }

  private set(hovered: boolean): void {
    if (hovered === this.hovered) return;
    this.hovered = hovered;
    this.deps.onChange(hovered);
  }
}
