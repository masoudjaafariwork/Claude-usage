// The overlay window: frameless, transparent, always-on-top, sized to its content,
// and kept reachable across monitor changes.
import { BrowserWindow, screen, type Display, type Rectangle } from 'electron';
import { join } from 'node:path';
import type { Settings } from './settings';

/** Initial size before the renderer reports its real content size. */
const INITIAL_SIZE = { width: 344, height: 280 };
/** Gap from the screen edge when placing the overlay in a corner. */
const EDGE_MARGIN = 16;

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

export function createOverlayWindow(settings: Readonly<Settings>): BrowserWindow {
  const { width, height } = INITIAL_SIZE;
  const saved = settings.position;
  const position =
    saved && isReachable({ ...saved, width, height }) ? saved : topRightOf(screen.getPrimaryDisplay(), width);

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
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  applyAlwaysOnTop(win, settings.alwaysOnTop);
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The overlay never navigates or opens other pages.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

export function applyAlwaysOnTop(win: BrowserWindow, on: boolean): void {
  if (on) win.setAlwaysOnTop(true, 'floating');
  else win.setAlwaysOnTop(false);
}

/**
 * Resizes the window to the renderer's content. The edge nearest to the screen border stays put,
 * so an overlay parked in a right/bottom corner grows and shrinks away from that corner.
 */
export function fitToContent(win: BrowserWindow, contentWidth: number, contentHeight: number): void {
  const width = Math.min(800, Math.max(80, Math.ceil(contentWidth)));
  const height = Math.min(1200, Math.max(40, Math.ceil(contentHeight)));
  const current = win.getBounds();
  if (current.width === width && current.height === height) return;

  const area = screen.getDisplayMatching(current).workArea;
  let { x, y } = current;
  if (current.x + current.width / 2 > area.x + area.width / 2) x = current.x + current.width - width;
  if (current.y + current.height / 2 > area.y + area.height / 2) y = current.y + current.height - height;
  x = Math.min(Math.max(x, area.x), area.x + area.width - width);
  y = Math.min(Math.max(y, area.y), area.y + area.height - height);
  win.setBounds({ x, y, width, height });
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
