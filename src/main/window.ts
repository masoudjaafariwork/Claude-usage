// The overlay window: frameless, transparent, always-on-top, sized to its content,
// and kept reachable across monitor changes.
import { BrowserWindow, screen, type Display, type Rectangle } from 'electron';
import { join } from 'node:path';
import type { Settings } from './settings';
import { freeSpot, resizedBounds } from './window-core';

/** Initial size before the renderer reports its real content size (the card; no margin around it). */
const INITIAL_SIZE = { width: 312, height: 248 };
/** App icon copied to dist/ by scripts/build.mjs (Windows/macOS take theirs from the packaged app). */
export const APP_ICON_PATH = join(__dirname, '../icon.png');

function intersect(a: Rectangle, b: Rectangle): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

/** True when enough of the window's top strip is on some display to grab and drag it. */
function isReachable(bounds: Rectangle): boolean {
  const topStrip = { x: bounds.x, y: bounds.y, width: bounds.width, height: 36 };
  return screen.getAllDisplays().some((d) => {
    const overlap = intersect(topStrip, d.workArea);
    return overlap.width >= 48 && overlap.height >= 24;
  });
}

/** The display's top-right corner, or the first free spot left of the other overlay windows there. */
function spotOn(display: Display, size: { width: number; height: number }, others: readonly Rectangle[]): { x: number; y: number } {
  return freeSpot(display.workArea, size, others);
}

export interface OverlayWindow {
  win: BrowserWindow;
  /** True when the window starts at the saved position (false: default corner). */
  restoredPosition: boolean;
}

/**
 * Creates an overlay window. With `previous` (the bounds of a window that is being rebuilt, see
 * overlay.ts) it takes exactly that place; otherwise its saved position, or the primary display's
 * top-right corner — left of the `others` (the other overlay windows) when they are there — at the
 * initial size until the renderer reports the content size.
 */
export function createOverlayWindow(
  settings: Readonly<Settings>,
  savedPosition: { x: number; y: number } | null,
  others: readonly Rectangle[],
  previous?: Rectangle,
): OverlayWindow {
  const width = previous?.width ?? Math.round(INITIAL_SIZE.width * settings.scale);
  const height = previous?.height ?? Math.round(INITIAL_SIZE.height * settings.scale);
  const saved = previous ? { x: previous.x, y: previous.y } : savedPosition;
  const restoredPosition = saved !== null && isReachable({ ...saved, width, height });
  const position = restoredPosition ? saved : spotOn(screen.getPrimaryDisplay(), { width, height }, others);

  const win = new BrowserWindow({
    ...position,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    title: 'Claude Usage',
    ...(process.platform === 'linux' ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Size setting (menu → Size). Changed later with webContents.setZoomFactor.
      zoomFactor: settings.scale,
    },
  });

  applyAlwaysOnTop(win, settings.alwaysOnTop);
  applyLocked(win, settings.locked);
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The overlay never navigates or opens other pages.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  void win.loadFile(join(__dirname, '../renderer/index.html'));
  return { win, restoredPosition };
}

/**
 * Windows: Electron puts a window of level 'floating' … 'status' right behind the taskbar
 * (`SetWindowPos(hwnd, taskbar)`) on every `setAlwaysOnTop` and every activation. When the taskbar
 * itself isn't topmost at that moment (seen on Windows 11: the primary taskbar wasn't, the
 * secondary ones were), a window placed behind it loses its topmost status, and the next click on
 * another window covers the overlay (D61). 'pop-up-menu' and higher are plain HWND_TOPMOST.
 * macOS keeps 'floating' (below the Dock and menus); Linux ignores the level.
 */
const ON_TOP_LEVEL = process.platform === 'win32' ? 'pop-up-menu' : 'floating';

export function applyAlwaysOnTop(win: BrowserWindow, on: boolean): void {
  if (on) win.setAlwaysOnTop(true, ON_TOP_LEVEL);
  else win.setAlwaysOnTop(false);
}

/**
 * Lock = click-through: mouse clicks go to the windows underneath. `forward` keeps mouse-move events
 * coming (Windows, macOS; Linux ignores it). The overlay can't be clicked or dragged until unlocked
 * from the tray menu or the lock shortcut.
 */
export function applyLocked(win: BrowserWindow, locked: boolean): void {
  if (locked) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
}

/**
 * Resizes the window to the renderer's content (in DIPs: CSS size × zoom factor). With `keepNearestEdge` the edge nearest to the screen
 * border stays put, so an overlay parked in a right/bottom corner grows and shrinks away from that
 * corner. Without it the top-left corner stays put — used for the first fit at a restored position,
 * which was saved at the real size (anchoring there would shift the overlay on every start).
 */
export function fitToContent(win: BrowserWindow, contentWidth: number, contentHeight: number, keepNearestEdge = true): void {
  // Round up once; the tolerance keeps float noise (312.00003) from adding a whole empty DIP.
  const width = Math.min(800, Math.max(80, Math.ceil(contentWidth - 0.01)));
  const height = Math.min(1200, Math.max(40, Math.ceil(contentHeight - 0.01)));
  const current = win.getBounds();
  if (current.width === width && current.height === height) return;

  const area = screen.getDisplayMatching(current).workArea;
  win.setBounds(resizedBounds(current, area, width, height, keepNearestEdge));
}

/** Puts the window at the top of `display`: its top-right corner, or next to the other overlay windows there. */
export function moveToDisplay(win: BrowserWindow, display: Display, others: readonly Rectangle[] = []): void {
  const { x, y } = spotOn(display, win.getBounds(), others);
  win.setPosition(x, y);
}

export function resetPosition(win: BrowserWindow, others: readonly Rectangle[] = []): void {
  moveToDisplay(win, screen.getPrimaryDisplay(), others);
}

/** Several overlay windows side by side along the top of `display`, from its top-right corner. */
export function arrangeOnDisplay(wins: readonly BrowserWindow[], display: Display): void {
  const placed: Rectangle[] = [];
  for (const win of wins) {
    const { width, height } = win.getBounds();
    const { x, y } = spotOn(display, { width, height }, placed);
    win.setPosition(x, y);
    placed.push({ x, y, width, height });
  }
}

/** Brings the window back if its display was unplugged or rearranged. */
export function ensureOnScreen(win: BrowserWindow, others: readonly Rectangle[] = []): void {
  if (!isReachable(win.getBounds())) resetPosition(win, others);
}
