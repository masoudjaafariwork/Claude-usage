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
