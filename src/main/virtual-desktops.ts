// Virtual desktops (Phases 10, 11): puts an overlay window on some desktops or on all of them (D78, D79).
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
// Windows has no "some desktops": a window is on one desktop or on all. A window on several desktops
// (Phase 11) therefore follows the user among them — a watch of the registry key tells about desktop
// switches (`RegNotifyChangeKeyValue`, no polling), and the window is moved to the new current desktop
// when that is one of its own. It is never moved to a desktop outside its set.
//
// macOS (Spaces) and Linux X11 (workspaces) have no public list: `setVisibleOnAllWorkspaces` gives
// "all" or "only the one it is on". Wayland: the compositor decides.
import type { BrowserWindow } from 'electron';
import { describeError, type LogFn } from './log';
import {
  GUID_NULL,
  adoptDesktops,
  desktopKeyName,
  guidFromBytes,
  guidToBytes,
  isWaylandSession,
  listDesktops,
  resolveDesktops,
  setToSave,
  targetDesktop,
  type DesktopRegistry,
  type DesktopSet,
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
const KEY_QUERY_VALUE = 0x1;
const KEY_NOTIFY = 0x10;
const REG_NOTIFY_CHANGE_LAST_SET = 0x4;
const INFINITE = 0xffffffff;
const WAIT_OBJECT_0 = 0;
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

/** A Win32 call that returned an error code (LSTATUS) or a null handle. */
class Win32Error extends Error {
  constructor(what: string, code = 0) {
    super(`${what} failed${code ? ` (${code})` : ''}`);
  }
}

/** A koffi function that can also run on a worker thread (`.async`, the callback comes on the main thread). */
type AsyncFn = ((...args: unknown[]) => unknown) & { async(...args: unknown[]): void };

/** The native calls of the registry watch (RegistryWatch). */
interface WatchCalls {
  regOpenKeyEx(hkey: number, subKey: string, options: number, sam: number, result: unknown[]): number;
  regNotifyChangeKeyValue(hkey: unknown, watchSubtree: number, filter: number, event: unknown, asynchronous: number): number;
  regCloseKey(hkey: unknown): unknown;
  createEvent(attributes: null, manualReset: number, initialState: number, name: null): unknown;
  setEvent(event: unknown): unknown;
  closeHandle(handle: unknown): unknown;
  waitForSingleObject: AsyncFn;
}

/**
 * Tells about every change of the values in the VirtualDesktops key — the current desktop (a switch)
 * and the desktop list — without polling (Phase 11). The notification is registered on the main
 * thread, which lives as long as the app (Windows ties it to the calling thread), and waited for on a
 * koffi worker thread; the callback comes back on the main thread, arms the next notification first
 * (so a change in between isn't lost) and then reports. `stop()` wakes the wait; the key and the
 * event are closed when it returns.
 */
class RegistryWatch {
  private stopped = false;
  private closed = false;

  private constructor(
    private readonly calls: WatchCalls,
    private readonly key: unknown,
    private readonly event: unknown,
    private readonly onChange: () => void,
    private readonly onFail: (err: unknown) => void,
  ) {}

  static start(calls: WatchCalls, onChange: () => void, onFail: (err: unknown) => void): RegistryWatch {
    const key: unknown[] = [0];
    const status = calls.regOpenKeyEx(HKEY_CURRENT_USER, VD_KEY, 0, KEY_NOTIFY | KEY_QUERY_VALUE, key);
    if (status !== 0 || !key[0]) throw new Win32Error('RegOpenKeyExW(VirtualDesktops)', status);
    const event = calls.createEvent(null, 0, 0, null);
    if (!event) {
      calls.regCloseKey(key[0]);
      throw new Win32Error('CreateEventW');
    }
    const watch = new RegistryWatch(calls, key[0], event, onChange, onFail);
    try {
      watch.arm();
    } catch (err) {
      watch.close();
      throw err;
    }
    return watch;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.calls.setEvent(this.event); // the wait returns and closes the handles
  }

  private arm(): void {
    const status = this.calls.regNotifyChangeKeyValue(this.key, 0, REG_NOTIFY_CHANGE_LAST_SET, this.event, 1);
    if (status !== 0) throw new Win32Error('RegNotifyChangeKeyValue', status);
    this.calls.waitForSingleObject.async(this.event, INFINITE, (err: unknown, result: unknown) => {
      if (this.stopped) return this.close();
      if (err || result !== WAIT_OBJECT_0) return this.fail(err ?? new Win32Error('WaitForSingleObject', Number(result)));
      try {
        this.arm();
      } catch (armErr) {
        return this.fail(armErr);
      }
      this.onChange();
    });
  }

  private fail(err: unknown): void {
    this.stopped = true;
    this.close();
    this.onFail(err);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.calls.closeHandle(this.event);
    this.calls.regCloseKey(this.key);
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
    private readonly watchCalls: WatchCalls,
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
    const watchCalls = {
      regOpenKeyEx: advapi32.func('long __stdcall RegOpenKeyExW(intptr_t hkey, const char16_t *subKey, uint32_t options, uint32_t sam, _Out_ intptr_t *result)'),
      regNotifyChangeKeyValue: advapi32.func('long __stdcall RegNotifyChangeKeyValue(intptr_t hkey, int watchSubtree, uint32_t filter, intptr_t event, int asynchronous)'),
      regCloseKey: advapi32.func('long __stdcall RegCloseKey(intptr_t hkey)'),
      createEvent: kernel32.func('intptr_t __stdcall CreateEventW(void *attributes, int manualReset, int initialState, const char16_t *name)'),
      setEvent: kernel32.func('int __stdcall SetEvent(intptr_t event)'),
      closeHandle: kernel32.func('int __stdcall CloseHandle(intptr_t handle)'),
      waitForSingleObject: kernel32.func('uint32_t __stdcall WaitForSingleObject(intptr_t handle, uint32_t ms)'),
    } as unknown as WatchCalls;
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
    return new WindowsDesktopApi(koffi, regGetValue as (...args: unknown[]) => number, windows, sessionId, ppv[0], protos, watchCalls);
  }

  /** Reports every change of the desktop list and of the current desktop (RegistryWatch). */
  watch(onChange: () => void, onFail: (err: unknown) => void): RegistryWatch {
    return RegistryWatch.start(this.watchCalls, onChange, onFail);
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
  /** Windows: the desktop the app put it on, or found it on — a window of several desktops stays there while the user is elsewhere. */
  desktop: string | null;
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
  private watcher: RegistryWatch | null = null;
  private watchFailed = false;

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
   * Puts the window where `set` says (null = all desktops): on Windows on the current desktop when
   * that is one of its own, else on the one of its set it was on (targetDesktop). Call it after every
   * show, since a hidden window loses its desktop on Windows, and after every desktop switch for a
   * window of several desktops. Returns the set to save when it changed (GUIDs found by their numbers,
   * desktops gone: null), undefined when nothing changes.
   */
  place(win: BrowserWindow, set: DesktopSet): DesktopSet | undefined {
    if (win.isDestroyed()) return undefined;
    const { platform } = this.options;
    const state = this.placement(win);
    if (platform === 'win32') return this.placeOnWindows(win, set, state);
    const choice = set !== null;
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

  private placeOnWindows(win: BrowserWindow, set: DesktopSet, state: WindowPlacement): DesktopSet | undefined {
    const api = set ? this.windowsApi() : null;
    const desktops = api ? this.list() : [];
    const resolved = resolveDesktops(set, desktops);
    const target = resolved ? targetDesktop(resolved, state.desktop) : null;
    if (!api || !target) {
      // All desktops: no taskbar button, as before Phase 10.
      if (state.button) win.setSkipTaskbar(true);
      state.button = false;
      state.desktop = null;
      return api ? setToSave(set, desktops) : undefined;
    }
    // Some desktops: a window belongs to a desktop through its taskbar button; with one it joins the
    // current desktop, then it is moved (cloaked here at once when that is another desktop).
    if (!state.button) win.setSkipTaskbar(false);
    state.button = true;
    if (win.isVisible()) {
      try {
        const hwnd = hwndOf(win);
        if (this.desktopOf(api, hwnd) !== target.id) api.move(hwnd, target.id);
        state.desktop = target.id;
      } catch (err) {
        // Stays where it is (on the current desktop); tried again at the next show or switch.
        const code = err instanceof HResultError ? err.hr : 0;
        this.logOnce(`move:${code}`, 'warn', `Virtual desktops: could not move the overlay to desktop ${target.number}: ${describeError(err)}`);
      }
    }
    return setToSave(set, desktops);
  }

  /** The desktop a shown window is on; null when Windows can't say (e.g. just hidden). */
  private desktopOf(api: WindowsDesktopApi, hwnd: number): string | null {
    try {
      const id = api.desktopOf(hwnd);
      return id === GUID_NULL ? null : id;
    } catch {
      return null;
    }
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
   * Windows: the new set when a shown window is on a desktop outside its set — the user moved it in
   * Task View, or its desktop was removed and Windows moved it to a neighbour (adoptDesktops). Also
   * remembers the desktop it is on.
   */
  actualDesktop(win: BrowserWindow, set: DesktopSet): DesktopSet | undefined {
    const state = this.placement(win);
    if (this.options.platform !== 'win32' || !set || win.isDestroyed() || !win.isVisible() || !state.button || !this.api) return undefined;
    let actual: string;
    try {
      actual = this.api.desktopOf(hwndOf(win));
    } catch (err) {
      if (!(err instanceof HResultError && err.hr >>> 0 === TYPE_E_ELEMENTNOTFOUND)) this.logOnce('actual', 'warn', `Virtual desktops: ${describeError(err)}`);
      return undefined;
    }
    const adopted = adoptDesktops(set, actual, state.desktop, this.list());
    if (actual !== GUID_NULL) state.desktop = actual;
    return adopted;
  }

  /**
   * Windows (Phase 11): while `on`, calls `onChange` after every desktop switch and every change of
   * the desktop list — for windows of several desktops, which follow the user. Nothing to watch
   * elsewhere. A watch that failed isn't tried again (one log line).
   */
  watch(on: boolean, onChange: () => void): void {
    if (!on) {
      if (!this.watcher) return;
      this.watcher.stop();
      this.watcher = null;
      this.options.log('info', 'Virtual desktops: no longer following desktop switches');
      return;
    }
    if (this.watcher || this.watchFailed) return;
    const api = this.windowsApi();
    if (!api) return;
    const failed = (err: unknown) => {
      this.watcher = null;
      this.watchFailed = true;
      this.options.log('warn', `Virtual desktops: can't follow desktop switches (a window of several desktops stays where it is): ${describeError(err)}`);
    };
    try {
      this.watcher = api.watch(onChange, failed);
      this.options.log('info', 'Virtual desktops: following desktop switches (a window is on several desktops)');
    } catch (err) {
      failed(err);
    }
  }

  /** A rebuilt window (D60) stays on the desktop of its set the old one was on. */
  carryOver(from: BrowserWindow, to: BrowserWindow): void {
    this.placement(to).desktop = this.placement(from).desktop;
  }

  /** Stops the watch and releases the COM object (quit). */
  dispose(): void {
    this.watcher?.stop();
    this.watcher = null;
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
      state = { button: false, desktop: null, applied: null }; // created with skipTaskbar: true (window.ts)
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
