// The overlay window: frameless, transparent, always-on-top, sized to its content,
// and kept reachable across monitor changes.
import { BrowserWindow, screen, type Display, type Rectangle } from 'electron';
import { join } from 'node:path';
import type { Settings } from './settings';
import { resizedBounds } from './window-core';

/** Initial size before the renderer reports its real content size (the card; no margin around it). */
const INITIAL_SIZE = { width: 312, height: 248 };
/** Gap from the screen edge when placing the overlay in a corner. */
const EDGE_MARGIN = 16;
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

function topRightOf(display: Display, width: number): { x: number; y: number } {
  const area = display.workArea;
  return { x: area.x + area.width - width - EDGE_MARGIN, y: area.y + EDGE_MARGIN };
}

export interface OverlayWindow {
  win: BrowserWindow;
  /** True when the window starts at the saved position (false: default corner). */
  restoredPosition: boolean;
}

export function createOverlayWindow(settings: Readonly<Settings>): OverlayWindow {
  const width = Math.round(INITIAL_SIZE.width * settings.scale);
  const height = Math.round(INITIAL_SIZE.height * settings.scale);
  const saved = settings.position;
  const restoredPosition = saved !== null && isReachable({ ...saved, width, height });
  const position = restoredPosition ? saved : topRightOf(screen.getPrimaryDisplay(), width);

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

export function applyAlwaysOnTop(win: BrowserWindow, on: boolean): void {
  if (on) win.setAlwaysOnTop(true, 'floating');
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

export function moveToDisplay(win: BrowserWindow, display: Display): void {
  const { x, y } = topRightOf(display, win.getBounds().width);
  win.setPosition(x, y);
}

export function resetPosition(win: BrowserWindow): void {
  moveToDisplay(win, screen.getPrimaryDisplay());
}

/** Brings the window back if its display was unplugged or rearranged. */
export function ensureOnScreen(win: BrowserWindow): void {
  if (!isReachable(win.getBounds())) resetPosition(win);
}
