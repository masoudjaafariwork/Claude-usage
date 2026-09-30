// The desktop picker (Windows, Phase 11): which virtual desktops each overlay window is shown on, as a
// small window with a grid of checkboxes — a row per window (its account), a column for "All desktops"
// and one per desktop. A native menu closes on every click, so ticking three desktops would mean
// opening it three times; the picker stays open until Esc, ✕ or a click elsewhere (it loses the focus).
// It opens at the cursor (above it when there is no room below, e.g. from the tray), in the overlay's
// look and at its Size, above everything, on every desktop (no taskbar button).
import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import type { DesktopPickerState } from '../shared/types';
import { applyAlwaysOnTop } from './window';
import { popupBounds } from './window-core';

export interface DesktopPickerHost {
  /** What the picker shows now: the desktop list read fresh, every window's desktops. */
  state(focus: string | null): DesktopPickerState;
  /** A click on a checkbox: window \`row\` (its key), column 'all' or a desktop's GUID. */
  pick(row: string, column: string): void;
  /** The Size setting (zoom factor), as for the overlay. */
  scale(): number;
}

export class DesktopPicker {
  private win: BrowserWindow | null = null;
  private focus: string | null = null;
  private anchor = { x: 0, y: 0 };
  /** Placed at the cursor already (later size changes keep its top-left corner). */
  private placed = false;

  constructor(private readonly host: DesktopPickerHost) {
    ipcMain.on('picker:pick', (event, row: unknown, column: unknown) => {
      if (!this.from(event) || typeof row !== 'string' || typeof column !== 'string') return;
      this.host.pick(row, column);
      this.refresh();
    });
    ipcMain.on('picker:resize', (event, width: unknown, height: unknown) => {
      if (!this.from(event) || typeof width !== 'number' || typeof height !== 'number' || !(width > 0 && height > 0)) return;
      this.fit(width, height);
    });
    ipcMain.on('picker:close', (event) => {
      if (this.from(event)) this.close();
    });
  }

  /**
   * Opens the picker at the cursor, or brings the open one there. \`focus\`: the key of the window whose
   * menu it was (its row is marked); null from the tray menu with several windows.
   */
  open(focus: string | null): void {
    this.focus = focus;
    this.anchor = screen.getCursorScreenPoint();
    this.placed = false;
    if (this.win && !this.win.isDestroyed()) {
      this.refresh();
      this.win.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 320,
      height: 140,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true, // on every desktop, like a menu
      title: 'Show on desktops',
      webPreferences: {
        preload: join(__dirname, '../preload/picker-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        zoomFactor: this.host.scale(),
      },
    });
    this.win = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    // Chromium's remembered zoom level would win over zoomFactor (D38).
    win.webContents.on('did-navigate', () => win.webContents.setZoomFactor(this.host.scale()));
    win.webContents.on('did-finish-load', () => this.refresh());
    win.on('blur', () => this.close()); // a click elsewhere, as with a menu
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    void win.loadFile(join(__dirname, '../renderer/picker.html'));
  }

  /** Sends the current state to an open picker (after a click, a desktop switch, a window opened or closed). */
  refresh(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('picker:state', this.host.state(this.focus));
  }

  close(): void {
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
  }

  private from(event: IpcMainEvent): boolean {
    return this.win !== null && !this.win.isDestroyed() && event.sender === this.win.webContents;
  }

  /** The page's size (CSS pixels) × Size: placed at the cursor the first time, then shown and focused. */
  private fit(cssWidth: number, cssHeight: number): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const scale = this.host.scale();
    const size = { width: Math.ceil(cssWidth * scale - 0.01), height: Math.ceil(cssHeight * scale - 0.01) };
    const from = this.placed ? win.getBounds() : this.anchor;
    const area = screen.getDisplayNearestPoint(from).workArea;
    win.setBounds(popupBounds(from, size, area));
    this.placed = true;
    if (!win.isVisible()) {
      win.show();
      applyAlwaysOnTop(win, true); // above the overlay windows
      win.focus();
    }
  }
}
