// Virtual desktops (Phase 10): which desktop an overlay window is shown on. Pure logic — the desktop
// list from Windows' registry values, resolving a saved choice against it, adopting where Windows
// really put the window, the menu entries, and which OSes can place a window at all. The native
// calls live in virtual-desktops.ts.
//
// Windows keeps the list in HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops:
// `VirtualDesktopIDs` (REG_BINARY, 16 bytes per desktop in Task View order), `CurrentVirtualDesktop`
// (16 bytes) and `Desktops\{GUID}\Name` (REG_SZ, only for desktops the user renamed). Only
// `VirtualDesktopIDs` counts: the `Desktops\` subkeys can hold leftovers of removed desktops.

/**
 * A window's desktop setting (`WindowSettings.desktop`; null there = all desktops, the default).
 * Windows: the chosen desktop's GUID and its 1-based number in Task View when last seen — the number
 * is the fallback when the GUID is gone (Windows 10 may give desktops new GUIDs after a sign-out).
 * macOS / Linux X11: both null = "only the desktop it is on" (they have no list of desktops).
 */
export interface DesktopChoice {
  id: string | null;
  number: number | null;
}

/** One Windows desktop, in Task View order. */
export interface VirtualDesktop {
  /** Lowercase GUID without braces, e.g. "8e1d428c-0192-4625-8893-b3586bb3fc01". */
  id: string;
  /** 1-based place in Task View. */
  number: number;
  /** The name the user gave it, else "Desktop N" (what Task View shows). */
  name: string;
  /** The desktop the user is on. */
  current: boolean;
}

/** What `GetWindowDesktopId` says for a window that belongs to no desktop (shown on all of them). */
export const GUID_NULL = '00000000-0000-0000-0000-000000000000';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DESKTOP_NUMBER = 999;

const hex = (value: number, width: number) => value.toString(16).padStart(width, '0');

/** A GUID from its 16 bytes in Windows' `GUID` layout (Data1–Data3 little-endian, Data4 as is). */
export function guidFromBytes(bytes: Uint8Array, offset = 0): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
  const data4 = Array.from(bytes.subarray(offset + 8, offset + 16), (b) => hex(b, 2)).join('');
  return `${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-${hex(view.getUint16(6, true), 4)}-${data4.slice(0, 4)}-${data4.slice(4)}`;
}

/** The 16 bytes of a GUID in Windows' layout (the reverse of guidFromBytes). */
export function guidToBytes(id: string): Uint8Array {
  const h = normalizeGuid(id)?.replace(/-/g, '');
  if (!h) throw new Error('Not a GUID');
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Number.parseInt(h.slice(0, 8), 16), true);
  view.setUint16(4, Number.parseInt(h.slice(8, 12), 16), true);
  view.setUint16(6, Number.parseInt(h.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) bytes[8 + i] = Number.parseInt(h.slice(16 + 2 * i, 18 + 2 * i), 16);
  return bytes;
}

/** Lowercase, without braces; null when it isn't a GUID. */
export function normalizeGuid(value: string): string | null {
  const id = value.trim().replace(/^\{(.*)\}$/, '$1').toLowerCase();
  return GUID_PATTERN.test(id) ? id : null;
}

/** The registry subkey of a desktop's own values (its name): `Desktops\{GUID}`, upper case like Windows writes it. */
export function desktopKeyName(id: string): string {
  return `{${id.toUpperCase()}}`;
}

/** `VirtualDesktopIDs`: one GUID per 16 bytes, in Task View order (a trailing partial entry is ignored). */
export function parseDesktopIds(bytes: Uint8Array | null): string[] {
  if (!bytes) return [];
  const ids: string[] = [];
  for (let offset = 0; offset + 16 <= bytes.length; offset += 16) {
    const id = guidFromBytes(bytes, offset);
    if (id !== GUID_NULL && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface DesktopRegistry {
  /** `VirtualDesktopIDs`; null when the value is missing (a single desktop that never had company). */
  ids: Uint8Array | null;
  /** `CurrentVirtualDesktop`, else the session's copy under `SessionInfo\<id>\VirtualDesktops` (Windows 10); null when neither exists. */
  current: Uint8Array | null;
  /** `Desktops\{GUID}\Name` of a desktop, null when it has none. */
  name(id: string): string | null;
}

/**
 * The desktops as Task View shows them. The current one is `CurrentVirtualDesktop` when it is in the
 * list, else the first (the value can be missing before the first switch of a session). Without
 * `VirtualDesktopIDs` there is one desktop: the current one, when Windows says which it is.
 */
export function listDesktops(registry: DesktopRegistry): VirtualDesktop[] {
  const current = registry.current && registry.current.length >= 16 ? guidFromBytes(registry.current) : null;
  let ids = parseDesktopIds(registry.ids);
  if (ids.length === 0 && current && current !== GUID_NULL) ids = [current];
  const currentId = current && ids.includes(current) ? current : ids[0];
  return ids.map((id, i) => {
    const name = registry.name(id)?.trim();
    return { id, number: i + 1, name: name || `Desktop ${i + 1}`, current: id === currentId };
  });
}

/**
 * The desktop a saved choice stands for: the same GUID, else the desktop with the same number, else
 * none (null = all desktops). A choice without an id or number (macOS / Linux) has no desktop here.
 */
export function resolveDesktop(choice: DesktopChoice | null, desktops: readonly VirtualDesktop[]): VirtualDesktop | null {
  if (!choice) return null;
  return desktops.find((d) => d.id === choice.id) ?? desktops.find((d) => d.number === choice.number) ?? null;
}

/**
 * What to save after placing a window: the resolved desktop when its GUID or number differs from the
 * saved choice, null (all desktops) when the desktop is really gone — the list could be read and has
 * neither its GUID nor its number — and undefined when nothing changes. An empty list (the registry
 * couldn't be read) never drops a choice.
 */
export function choiceToSave(choice: DesktopChoice | null, desktops: readonly VirtualDesktop[]): DesktopChoice | null | undefined {
  if (!choice || (choice.id === null && choice.number === null)) return undefined;
  const target = resolveDesktop(choice, desktops);
  if (!target) return desktops.length > 0 ? null : undefined;
  return target.id === choice.id && target.number === choice.number ? undefined : { id: target.id, number: target.number };
}

/**
 * "Where the window really is wins": the user dragged the overlay to another desktop in Task View, or
 * removed its desktop (Windows moves its windows to a neighbour). `actual` is `GetWindowDesktopId` of
 * the shown window; the new choice to save, or undefined when there is nothing to adopt (same desktop
 * and number, no answer, or GUID_NULL — not on one desktop).
 */
export function adoptDesktop(choice: DesktopChoice | null, actual: string | null, desktops: readonly VirtualDesktop[]): DesktopChoice | undefined {
  if (!choice || choice.id === null || !actual || actual === GUID_NULL) return undefined;
  const number = desktops.find((d) => d.id === actual)?.number ?? (actual === choice.id ? choice.number : null);
  return actual === choice.id && number === choice.number ? undefined : { id: actual, number };
}

/** A desktop setting read from settings.json: a GUID and / or a number, both null (macOS / Linux), or null (all desktops). */
export function sanitizeDesktopChoice(value: unknown): DesktopChoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === 'string' ? (normalizeGuid(v.id) ?? undefined) : v.id === null || v.id === undefined ? null : undefined;
  const number =
    typeof v.number === 'number' && Number.isInteger(v.number) && v.number >= 1 && v.number <= MAX_DESKTOP_NUMBER
      ? v.number
      : v.number === null || v.number === undefined
        ? null
        : undefined;
  if (id === undefined || number === undefined) return null;
  return { id, number };
}

/**
 * How the OS lets the overlay choose its desktop.
 * - 'list': Windows — every desktop listed, a window can be moved to any of them.
 * - 'this-only': macOS Spaces, Linux X11 workspaces — all of them, or only the one it is on.
 * - 'wayland': the compositor decides; nothing to set.
 * - 'unavailable': Windows, but the native calls failed (see the log).
 */
export type DesktopSupport = 'list' | 'this-only' | 'wayland' | 'unavailable';

/**
 * Linux runs natively on Wayland unless Electron is forced to X11 (Electron 38+ picks Wayland in a
 * Wayland session). There `setVisibleOnAllWorkspaces` does nothing.
 */
export function isWaylandSession(env: NodeJS.ProcessEnv, ozonePlatform: string, ozoneHint: string): boolean {
  const forcedX11 = [ozonePlatform, ozoneHint, env.ELECTRON_OZONE_PLATFORM_HINT ?? ''].some((v) => v.trim().toLowerCase() === 'x11');
  const wayland = env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
  return wayland && !forcedX11;
}

/** The desktop setting of one window, or of every window in the tray menu (undefined when they differ). */
export type DesktopSelection = DesktopChoice | null | undefined;

/** The same setting of several windows, or undefined when they differ. */
export function commonSelection(choices: ReadonlyArray<DesktopChoice | null>): DesktopSelection {
  const [first, ...rest] = choices;
  if (first === undefined) return undefined;
  const key = (c: DesktopChoice | null) => (c ? (c.id ?? `#${c.number ?? ''}`) : 'all');
  return rest.every((c) => key(c) === key(first)) ? first : undefined;
}

export type DesktopMenuEntry =
  | { kind: 'item'; label: string; checked: boolean; choice: DesktopChoice | null }
  | { kind: 'note'; label: string }
  | { kind: 'separator' };

export interface DesktopMenuInput {
  support: DesktopSupport;
  platform: NodeJS.Platform;
  /** Windows: the desktops (listDesktops). */
  desktops: readonly VirtualDesktop[];
  /** The window's resolved setting (all windows' in the tray menu: undefined when they differ). */
  selected: DesktopSelection;
}

/** A menu label as text: on Windows `&` marks a mnemonic, so a desktop named "R&D" needs "R&&D". */
export function menuText(text: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? text.replace(/&/g, '&&') : text;
}

/** The submenu's title: Linux calls them workspaces. */
export function desktopMenuTitle(platform: NodeJS.Platform): string {
  return platform === 'linux' ? 'Show on workspace' : 'Show on desktop';
}

/**
 * *Show on desktop* ▸ — Windows: *All desktops*, a separator, one radio per desktop in Task View
 * order with its name and "(current)" on the one the user is on; with a single desktop a hint how to
 * add one. macOS / Linux X11: *All desktops* / *Only this desktop* (workspaces on Linux). Wayland and
 * a failed Windows setup: one disabled line.
 */
export function desktopMenuEntries(input: DesktopMenuInput): DesktopMenuEntry[] {
  const { support, platform, desktops, selected } = input;
  const word = platform === 'linux' ? 'workspace' : 'desktop';
  if (support === 'wayland') return [{ kind: 'note', label: 'Not available on Wayland' }];
  if (support === 'unavailable') return [{ kind: 'note', label: 'Not available on this computer' }];
  const all: DesktopMenuEntry = { kind: 'item', label: `All ${word}s`, checked: selected === null, choice: null };
  if (support === 'this-only') {
    const only = selected !== null && selected !== undefined;
    return [all, { kind: 'item', label: `Only this ${word}`, checked: only, choice: { id: null, number: null } }];
  }
  const chosen = selected ? resolveDesktop(selected, desktops) : null;
  const entries: DesktopMenuEntry[] = [
    // A choice that no desktop matches any more (the list couldn't be read) leaves the overlay where it is.
    { ...all, checked: selected === null || (selected !== undefined && !chosen && desktops.length > 0) },
    { kind: 'separator' },
    ...desktops.map(
      (d): DesktopMenuEntry => ({
        kind: 'item',
        label: menuText(d.current ? `${d.name} (current)` : d.name, platform),
        checked: chosen?.id === d.id,
        choice: { id: d.id, number: d.number },
      }),
    ),
  ];
  if (desktops.length <= 1) entries.push({ kind: 'note', label: 'Add a desktop: Win+Ctrl+D' });
  return entries;
}

/** A desktop for the log: its number, never its name (users name desktops after clients or projects). */
export function desktopLogName(choice: DesktopChoice | null): string {
  if (!choice) return 'all desktops';
  if (choice.id === null && choice.number === null) return 'only the desktop it is on';
  return choice.number !== null ? `desktop ${choice.number}` : 'a desktop';
}
