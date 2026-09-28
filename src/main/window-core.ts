// Window placement math without Electron, so it can be unit-tested. All values are DIPs.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the window goes when its size changes to `width` × `height`. With `keepNearestEdge` the edge
 * nearest to the display border stays put, so an overlay parked in a right/bottom corner grows and
 * shrinks away from that corner; without it the top-left corner stays put.
 *
 * `area` is the work area of the display the window is on. The result stays on it, but is never
 * pulled further in than `current` already was: an overlay the user parked across two displays
 * stays there instead of snapping to one display's edge (D44). If the window is bigger than the
 * display (large size on a small screen), its top-left part with the header stays visible.
 */
export function resizedBounds(current: Rect, area: Rect, width: number, height: number, keepNearestEdge: boolean): Rect {
  let { x, y } = current;
  if (keepNearestEdge && current.x + current.width / 2 > area.x + area.width / 2) x = current.x + current.width - width;
  if (keepNearestEdge && current.y + current.height / 2 > area.y + area.height / 2) y = current.y + current.height - height;
  const right = Math.max(area.x + area.width, current.x + current.width);
  const bottom = Math.max(area.y + area.height, current.y + current.height);
  x = Math.max(Math.min(area.x, current.x), Math.min(x, right - width));
  y = Math.max(Math.min(area.y, current.y), Math.min(y, bottom - height));
  return { x, y, width, height };
}

/** Gap from the display edge for a window placed in a corner. */
export const EDGE_MARGIN = 16;
/** Gap between overlay windows placed side by side. */
export const WINDOW_GAP = 8;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Where a window of `size` goes on a display with work area `area` (Phase 7): its top-right corner,
 * or — when other overlay windows are in the way — the first spot to their left along the top edge
 * that none of them covers. When the top row is full, the top-right corner after all.
 */
export function freeSpot(area: Rect, size: { width: number; height: number }, others: readonly Rect[]): { x: number; y: number } {
  const y = area.y + EDGE_MARGIN;
  const corner = area.x + area.width - size.width - EDGE_MARGIN;
  let x = corner;
  while (x >= area.x) {
    const spot = { x, y, ...size };
    const blocking = others.filter((other) => overlaps(spot, other));
    if (blocking.length === 0) return { x, y };
    x = Math.min(...blocking.map((other) => other.x)) - WINDOW_GAP - size.width;
  }
  return { x: corner, y };
}
