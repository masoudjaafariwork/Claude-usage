// Virtual desktops (Phase 10): puts an overlay window on one desktop or on all of them (D78, D79).
//
// Windows has no Electron API for this. A window belongs to a desktop through its taskbar button:
// the overlay has none (`skipTaskbar`), so it is on every desktop. For one desktop it gets a button
// (`setSkipTaskbar(false)`) and is moved with the public, documented `IVirtualDesktopManager`
// (`MoveWindowToDesktop`, which works only for the calling process's own windows — hence in-process,
// through koffi). A hidden window loses its desktop, so the move follows every show. The desktop list
// comes from the registry, read-only. Never the undocumented interfaces (their IIDs change with
// Windows builds). koffi is loaded on first use; if anything fails, the feature says "not available"
// and the overlay stays on all desktops.
//
// macOS (Spaces) and Linux X11 (workspaces) have no public list: `setVisibleOnAllWorkspaces` gives
// "all" or "only the one it is on". Wayland: the compositor decides.
import type { BrowserWindow } from 'electron';
import { describeError, type LogFn } from './log';
import {
  adoptDesktop,
  choiceToSave,
  desktopKeyName,
  guidFromBytes,
  guidToBytes,
  isWaylandSession,
  listDesktops,
  resolveDesktop,
  type DesktopChoice,
  type DesktopRegistry,
  type DesktopSupport,
  type VirtualDesktop,
} from './virtual-desktops-core';

type Koffi = typeof import('koffi');

const VD_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops';
const SESSION_KEY = (session: number) => `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SessionInfo\\${session}\\VirtualDesktops`;
/** (HKEY)(LONG)0x80000001, sign-extended as the `intptr_t` it is passed as. */
const HKEY_CURRENT_USER = -2147483647;
const RRF_RT_REG_SZ = 0x2;
const RRF_RT_REG_BINARY = 0x8;
const CLSCTX_ALL = 0x17;
const CLSID_VIRTUAL_DESKTOP_MANAGER = 'aa509086-5ca9-4c25-8f95-589d3c07b48a';
const IID_IVIRTUAL_DESKTOP_MANAGER = 'a5cd92ff-29be-454c-8d04-d82879fb3f1b';
/** `GetWindowDesktopId` of a hidden window: it has no desktop (not an error worth a log line). */
const TYPE_E_ELEMENTNOTFOUND = 0x8002802b;

interface GuidStruct {
  Data1: number;
  Data2: number;
  Data3: number;
  Data4: ArrayLike<number>;
}

function guidStruct(id: string): GuidStruct {
  const b = Buffer.from(guidToBytes(id));
  return { Data1: b.readUInt32LE(0), Data2: b.readUInt16LE(4), Data3: b.readUInt16LE(6), Data4: [...b.subarray(8, 16)] };
}

function guidOfStruct(g: GuidStruct): string {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(g.Data1 >>> 0, 0);
  b.writeUInt16LE(g.Data2, 4);
  b.writeUInt16LE(g.Data3, 6);
  Buffer.from(Array.from(g.Data4)).copy(b, 8);
  return guidFromBytes(b);
}

/** An HRESULT that isn't S_OK. */
class HResultError extends Error {
  constructor(
    what: string,
    readonly hr: number,
  ) {
    super(`${what} failed (0x${(hr >>> 0).toString(16).padStart(8, '0')})`);
  }
}

/** A window's HWND as the number koffi passes as `intptr_t` (handles use the low 32 bits). */
function hwndOf(win: BrowserWindow): number {
  return Number(win.getNativeWindowHandle().readBigUInt64LE(0));
}

/**
 * Windows' own calls through koffi: the registry values of the desktop list and the three methods of
 * `IVirtualDesktopManager` (vtable after IUnknown: 3 IsWindowOnCurrentVirtualDesktop, 4
 * GetWindowDesktopId, 5 MoveWindowToDesktop). One COM object for the app, released on quit.
 */
class WindowsDesktopApi {
  private constructor(
    private readonly koffi: Koffi,
    private readonly regGetValue: (...args: unknown[]) => number,
    private readonly user32: {
      getForegroundWindow(): unknown;
      findWindow(cls: string, title: null): unknown;
      setForegroundWindow(hwnd: unknown): unknown;
      flashWindowEx(info: unknown): unknown;
    },
    private readonly sessionId: number | null,
    private readonly manager: unknown,
    private readonly protos: { isOnCurrent: unknown; desktopOf: unknown; move: unknown; release: unknown },
  ) {}

  /** Throws when koffi can't be loaded or Windows has no virtual desktop manager (e.g. Windows Server without Explorer). */
  static load(): WindowsDesktopApi {
    // Loaded here, not at startup: macOS and Linux never load it, and a failure only turns this feature off.
    const koffi = require('koffi') as Koffi;
    koffi.struct('GUID', { Data1: 'uint32_t', Data2: 'uint16_t', Data3: 'uint16_t', Data4: koffi.array('uint8_t', 8) });
    koffi.struct('FLASHWINFO', { cbSize: 'uint32_t', hwnd: 'intptr_t', dwFlags: 'uint32_t', uCount: 'uint32_t', dwTimeout: 'uint32_t' });
    const ole32 = koffi.load('ole32.dll');
    const advapi32 = koffi.load('advapi32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const user32 = koffi.load('user32.dll');
    const coCreateInstance = ole32.func('long __stdcall CoCreateInstance(const GUID *rclsid, void *outer, uint32_t ctx, const GUID *riid, _Out_ void **ppv)');
    const regGetValue = advapi32.func(
      'long __stdcall RegGetValueW(intptr_t hkey, const char16_t *subKey, const char16_t *value, uint32_t flags, _Out_ uint32_t *type, void *data, _Inout_ uint32_t *cb)',
    );
    const processIdToSessionId = kernel32.func('int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t *session)');
    const windows = {
      getForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      findWindow: user32.func('intptr_t __stdcall FindWindowW(const char16_t *className, const char16_t *title)'),
      setForegroundWindow: user32.func('int __stdcall SetForegroundWindow(intptr_t hwnd)'),
      flashWindowEx: user32.func('int __stdcall FlashWindowEx(const FLASHWINFO *info)'),
    };
    const protos = {
      isOnCurrent: koffi.proto('long __stdcall IsWindowOnCurrentVirtualDesktopFn(void *self, intptr_t hwnd, _Out_ int *onCurrent)'),
      desktopOf: koffi.proto('long __stdcall GetWindowDesktopIdFn(void *self, intptr_t hwnd, _Out_ GUID *desktopId)'),
      move: koffi.proto('long __stdcall MoveWindowToDesktopFn(void *self, intptr_t hwnd, const GUID *desktopId)'),
      release: koffi.proto('uint32_t __stdcall ReleaseFn(void *self)'),
    };
    const ppv: unknown[] = [null];
    // Electron's main thread has COM initialized already (checked in Electron 44).
    const hr = coCreateInstance(guidStruct(CLSID_VIRTUAL_DESKTOP_MANAGER), null, CLSCTX_ALL, guidStruct(IID_IVIRTUAL_DESKTOP_MANAGER), ppv) as number;
    if (hr !== 0 || !ppv[0]) throw new HResultError('CoCreateInstance(VirtualDesktopManager)', hr);
    const session: number[] = [0];
    const sessionId = processIdToSessionId(process.pid, session) ? (session[0] ?? null) : null;
    return new WindowsDesktopApi(koffi, regGetValue as (...args: unknown[]) => number, windows, sessionId, ppv[0], protos);
  }

  isForeground(hwnd: number): boolean {
    return Number(this.user32.getForegroundWindow()) === hwnd;
  }

  /** Makes the taskbar (on every desktop) the foreground window, as a click on it would. */
  focusTaskbar(): boolean {
    const taskbar = this.user32.findWindow('Shell_TrayWnd', null);
    return Boolean(taskbar) && Boolean(this.user32.setForegroundWindow(taskbar));
  }

  /** Stops the flashing Windows starts on a taskbar button when it refuses a window the foreground. */
  stopFlashing(hwnd: number): void {
    this.user32.flashWindowEx({ cbSize: this.koffi.sizeof('FLASHWINFO'), hwnd, dwFlags: 0 /* FLASHW_STOP */, uCount: 0, dwTimeout: 0 });
  }

  private method(slot: number): unknown {
    const vtable = this.koffi.decode(this.manager, 'void *');
    return this.koffi.decode(vtable, slot * 8, 'void *');
  }

  private call(slot: number, proto: unknown, ...args: unknown[]): number {
    return (this.koffi.call as (...a: unknown[]) => number)(this.method(slot), proto, this.manager, ...args);
  }

  isOnCurrent(hwnd: number): boolean {
    const on: number[] = [1];
    const hr = this.call(3, this.protos.isOnCurrent, hwnd, on);
    if (hr !== 0) throw new HResultError('IsWindowOnCurrentVirtualDesktop', hr);
    return on[0] !== 0;
  }

  desktopOf(hwnd: number): string {
    const id = {} as GuidStruct;
    const hr = this.call(4, this.protos.desktopOf, hwnd, id);
    if (hr !== 0) throw new HResultError('GetWindowDesktopId', hr);
    return guidOfStruct(id);
  }

  move(hwnd: number, desktopId: string): void {
    const hr = this.call(5, this.protos.move, hwnd, guidStruct(desktopId));
    if (hr !== 0) throw new HResultError('MoveWindowToDesktop', hr);
  }

  release(): void {
    this.call(2, this.protos.release);
  }

  /** A registry value's bytes; null when it doesn't exist (or can't be read). */
  private regValue(key: string, value: string, type: number): Buffer | null {
    const cb: number[] = [0];
    if (this.regGetValue(HKEY_CURRENT_USER, key, value, type, [0], null, cb) !== 0 || !cb[0]) return null;
    const data = Buffer.alloc(cb[0]);
    if (this.regGetValue(HKEY_CURRENT_USER, key, value, type, [0], data, cb) !== 0) return null;
    return data.subarray(0, cb[0]);
  }

  /** The desktop list's values, read-only (about 1 ms). */
  readRegistry(): DesktopRegistry {
    const current =
      this.regValue(VD_KEY, 'CurrentVirtualDesktop', RRF_RT_REG_BINARY) ??
      (this.sessionId === null ? null : this.regValue(SESSION_KEY(this.sessionId), 'CurrentVirtualDesktop', RRF_RT_REG_BINARY));
    return {
      ids: this.regValue(VD_KEY, 'VirtualDesktopIDs', RRF_RT_REG_BINARY),
      current,
      name: (id) => {
        const text = this.regValue(`${VD_KEY}\\Desktops\\${desktopKeyName(id)}`, 'Name', RRF_RT_REG_SZ)?.toString('utf16le');
        return text ? text.replace(/\0+$/, '') : null;
      },
    };
  }
}

/** What a window got last (a rebuilt window is a new BrowserWindow and starts over). */
interface WindowPlacement {
  /** Windows: it has a taskbar button, i.e. it belongs to one desktop. */
  button: boolean;
  /** macOS / Linux: 'all' or 'this' as last set. */
  applied: 'all' | 'this' | null;
}

export interface VirtualDesktopsOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Chromium's `--ozone-platform` / `--ozone-platform-hint` switches (Linux: X11 or Wayland). */
  ozonePlatform: string;
  ozoneHint: string;
  log: LogFn;
}

export class VirtualDesktops {
  private api: WindowsDesktopApi | null = null;
  private loaded = false;
  private readonly placements = new WeakMap<BrowserWindow, WindowPlacement>();
  private readonly loggedOnce = new Set<string>();

  constructor(private readonly options: VirtualDesktopsOptions) {}

  /** How the overlay can choose its desktop here. Windows loads koffi on the first call. */
  get support(): DesktopSupport {
    const { platform, env, ozonePlatform, ozoneHint } = this.options;
    if (platform === 'win32') return this.windowsApi() ? 'list' : 'unavailable';
    if (platform === 'darwin') return 'this-only';
    if (platform === 'linux') return isWaylandSession(env, ozonePlatform, ozoneHint) ? 'wayland' : 'this-only';
    return 'unavailable';
  }

  /** Windows: the desktops in Task View order, read fresh (empty when they can't be read, or elsewhere). */
  list(): VirtualDesktop[] {
    const api = this.windowsApi();
    if (!api) return [];
    try {
      return listDesktops(api.readRegistry());
    } catch (err) {
      this.logOnce('list', 'warn', `Virtual desktops: could not read the list: ${describeError(err)}`);
      return [];
    }
  }

  /**
   * Puts the window where `choice` says (null = all desktops) — call it after every show, since a
   * hidden window loses its desktop on Windows. Returns the choice to save when it changed (the GUID
   * was found by its number, or the desktop is gone: null), undefined when nothing changes.
   */
  place(win: BrowserWindow, choice: DesktopChoice | null): DesktopChoice | null | undefined {
    if (win.isDestroyed()) return undefined;
    const { platform } = this.options;
    const state = this.placement(win);
    if (platform === 'win32') return this.placeOnWindows(win, choice, state);
    const wanted = choice ? 'this' : 'all';
    if (state.applied === wanted) return undefined;
    if (platform === 'darwin') {
      // Leaving "all" must not transform the process type: Electron would show a Dock icon for the
      // agent (LSUIElement) app and hide the window for a moment.
      if (choice) win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true, skipTransformProcessType: true });
      else win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } else if (platform === 'linux') {
      if (this.support === 'wayland') return undefined;
      // X11: sticky + _NET_WM_DESKTOP = all, or the current workspace for "only this one". It is a
      // message to the window manager about a mapped window, so it waits for the first show.
      if (!win.isVisible()) return undefined;
      win.setVisibleOnAllWorkspaces(!choice);
    }
    state.applied = wanted;
    return undefined;
  }

  private placeOnWindows(win: BrowserWindow, choice: DesktopChoice | null, state: WindowPlacement): DesktopChoice | null | undefined {
    const api = choice ? this.windowsApi() : null;
    const desktops = api ? this.list() : [];
    const target = resolveDesktop(choice, desktops);
    if (!api || !target) {
      // All desktops: no taskbar button, as before Phase 10.
      if (state.button) win.setSkipTaskbar(true);
      state.button = false;
      return api ? choiceToSave(choice, desktops) : undefined;
    }
    // One desktop: a window belongs to a desktop through its taskbar button; with one it joins the
    // current desktop, then it is moved (cloaked here at once when that is another desktop).
    if (!state.button) win.setSkipTaskbar(false);
    state.button = true;
    if (win.isVisible()) {
      try {
        api.move(hwndOf(win), target.id);
      } catch (err) {
        // Stays where it is (on the current desktop); tried again at the next show.
        const code = err instanceof HResultError ? err.hr : 0;
        this.logOnce(`move:${code}`, 'warn', `Virtual desktops: could not move the overlay to desktop ${target.number}: ${describeError(err)}`);
      }
    }
    return choiceToSave(choice, desktops);
  }

  /**
   * Windows: whether the window can be seen on the desktop the user is on. True for a window on
   * every desktop, and whenever it can't be told (other OSes, errors).
   */
  isOnCurrentDesktop(win: BrowserWindow): boolean {
    if (this.options.platform !== 'win32' || win.isDestroyed() || !this.placement(win).button || !win.isVisible()) return true;
    try {
      return this.api?.isOnCurrent(hwndOf(win)) ?? true;
    } catch (err) {
      this.logOnce('current', 'warn', `Virtual desktops: ${describeError(err)}`);
      return true;
    }
  }

  /**
   * Activates a shown window: Windows switches to the desktop of a window that becomes the foreground
   * window. A window that already is the foreground window — it was active when it was sent to
   * another desktop — wouldn't change anything, so it first hands the foreground to the taskbar.
   * Windows may refuse the foreground (the user was just busy in another app): then it flashes the
   * window's taskbar button on the other desktop instead, which is stopped — nothing changes.
   */
  activate(win: BrowserWindow): { viaTaskbar: boolean; refused: boolean } {
    const result = { viaTaskbar: false, refused: false };
    if (win.isDestroyed()) return result;
    const api = this.options.platform === 'win32' ? this.api : null;
    try {
      if (api?.isForeground(hwndOf(win))) result.viaTaskbar = api.focusTaskbar();
    } catch (err) {
      this.logOnce('foreground', 'warn', `Virtual desktops: ${describeError(err)}`);
    }
    win.focus();
    try {
      if (api && !api.isForeground(hwndOf(win))) {
        result.refused = true;
        api.stopFlashing(hwndOf(win));
      }
    } catch (err) {
      this.logOnce('flash', 'warn', `Virtual desktops: ${describeError(err)}`);
    }
    return result;
  }

  /**
   * Windows: the desktop a shown window is really on, when it differs from `choice` — the user moved
   * it in Task View, or its desktop was removed and Windows moved it to a neighbour (adoptDesktop).
   */
  actualDesktop(win: BrowserWindow, choice: DesktopChoice | null): DesktopChoice | undefined {
    if (this.options.platform !== 'win32' || !choice || win.isDestroyed() || !win.isVisible() || !this.placement(win).button || !this.api) return undefined;
    let actual: string;
    try {
      actual = this.api.desktopOf(hwndOf(win));
    } catch (err) {
      if (!(err instanceof HResultError && err.hr >>> 0 === TYPE_E_ELEMENTNOTFOUND)) this.logOnce('actual', 'warn', `Virtual desktops: ${describeError(err)}`);
      return undefined;
    }
    return adoptDesktop(choice, actual, this.list());
  }

  /** Releases the COM object (quit). */
  dispose(): void {
    try {
      this.api?.release();
    } catch {
      // quitting anyway
    }
    this.api = null;
  }

  private placement(win: BrowserWindow): WindowPlacement {
    let state = this.placements.get(win);
    if (!state) {
      state = { button: false, applied: null }; // created with skipTaskbar: true (window.ts)
      this.placements.set(win, state);
    }
    return state;
  }

  private windowsApi(): WindowsDesktopApi | null {
    if (this.options.platform !== 'win32') return null;
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.api = WindowsDesktopApi.load();
      } catch (err) {
        this.options.log('warn', `Virtual desktops not available (the overlay stays on all desktops): ${describeError(err)}`);
      }
    }
    return this.api;
  }

  private logOnce(key: string, level: 'info' | 'warn', line: string): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    this.options.log(level, line);
  }
}
