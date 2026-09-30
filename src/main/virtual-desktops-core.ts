// Virtual desktops (Phases 10 and 11): which desktops an overlay window is shown on. Pure logic — the
// desktop list from Windows' registry values, resolving a saved set of desktops against it, where a
// window of a set goes, adopting where Windows really put the window, the desktop picker's
// checkboxes, the menu entries, and which OSes can place a window at all. The native calls live in
// virtual-desktops.ts.
import type { DesktopPickerState } from '../shared/types';
//
// Windows keeps the list in HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops:
// `VirtualDesktopIDs` (REG_BINARY, 16 bytes per desktop in Task View order), `CurrentVirtualDesktop`
// (16 bytes) and `Desktops\{GUID}\Name` (REG_SZ, only for desktops the user renamed). Only
// `VirtualDesktopIDs` counts: the `Desktops\` subkeys can hold leftovers of removed desktops.

/**
 * One desktop of a window's set (`WindowSettings.desktops`, see DesktopSet). Windows: the desktop's
 * GUID and its 1-based number in Task View when last seen — the number is the fallback when the GUIDs
 * are gone (Windows 10 may give desktops new GUIDs after a sign-out). macOS / Linux X11: both null =
 * "only the desktop it is on" (they have no list of desktops).
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
 * A window's desktops (`WindowSettings.desktops`, Phase 11): null = all desktops (the default).
 * Windows: the chosen desktops (one or more). macOS / Linux X11: one entry with neither id nor number
 * = "only the desktop it is on".
 */
export type DesktopSet = DesktopChoice[] | null;

/** At most this many desktops per window in settings.json. */
const MAX_SET_SIZE = 50;

const choiceKey = (c: DesktopChoice) => (c.id !== null ? c.id : `#${c.number ?? ''}`);

/** macOS / Linux's "only the desktop it is on" (no list of desktops to name one). */
export function isThisOnly(set: DesktopSet): boolean {
  return set !== null && set.length > 0 && set.every((c) => c.id === null && c.number === null);
}

/** The choices of desktops, in Task View order. */
const choicesOf = (desktops: readonly VirtualDesktop[]): DesktopChoice[] => desktops.map((d) => ({ id: d.id, number: d.number }));

/**
 * The desktops a saved set stands for, in Task View order: those whose GUID is still there; when none
 * is (Windows 10 may give every desktop a new GUID after a sign-out), those with the same numbers;
 * null when nothing is left — or for all desktops, and for macOS / Linux's "only this one".
 */
export function resolveDesktops(set: DesktopSet, desktops: readonly VirtualDesktop[]): VirtualDesktop[] | null {
  if (!set || set.length === 0) return null;
  const byId = desktops.filter((d) => set.some((c) => c.id === d.id));
  if (byId.length > 0) return byId;
  const byNumber = desktops.filter((d) => set.some((c) => c.number !== null && c.number === d.number));
  return byNumber.length > 0 ? byNumber : null;
}

/**
 * What to save after placing a window: the resolved desktops when their GUIDs or numbers differ from
 * the saved set, null (all desktops) when none is left — the list could be read and has neither their
 * GUIDs nor their numbers — and undefined when nothing changes. An empty list (the registry couldn't
 * be read) never drops a set.
 */
export function setToSave(set: DesktopSet, desktops: readonly VirtualDesktop[]): DesktopSet | undefined {
  if (!set || isThisOnly(set) || desktops.length === 0) return undefined;
  const resolved = resolveDesktops(set, desktops);
  if (!resolved) return null;
  const next = choicesOf(resolved);
  const same = next.length === set.length && next.every((c) => set.some((s) => s.id === c.id && s.number === c.number));
  return same ? undefined : next;
}

/**
 * Where a window of a set goes: the current desktop when it is in the set (it follows the user), else
 * the one of the set it is on (or was last on), else the first of the set.
 */
export function targetDesktop(resolved: readonly VirtualDesktop[], on: string | null): VirtualDesktop | null {
  return resolved.find((d) => d.current) ?? resolved.find((d) => d.id === on) ?? resolved[0] ?? null;
}

/**
 * "Where the window really is wins": the user dragged the overlay to another desktop in Task View, or
 * removed its desktop (Windows moves its windows to a neighbour). `actual` is `GetWindowDesktopId` of
 * the shown window, `placedOn` the desktop the app put it on. On a desktop of its set nothing changes;
 * elsewhere that desktop takes the place of the one it was on. Undefined when there is nothing to
 * adopt (no answer, GUID_NULL — not on one desktop —, all desktops, macOS / Linux).
 */
export function adoptDesktops(set: DesktopSet, actual: string | null, placedOn: string | null, desktops: readonly VirtualDesktop[]): DesktopSet | undefined {
  if (!set || isThisOnly(set) || !actual || actual === GUID_NULL) return undefined;
  if (set.some((c) => c.id === actual)) return undefined;
  let rest = set.filter((c) => placedOn === null || c.id !== placedOn);
  if (rest.length === set.length && set.length === 1) rest = []; // its only desktop: it moved away from it
  const next = [...rest, { id: actual, number: desktops.find((d) => d.id === actual)?.number ?? null }];
  return next.sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER));
}

/**
 * A click on a desktop in the menu: ticks or unticks it. While the window is on all desktops (or its
 * desktops are gone), every desktop counts as ticked. Ticking the last missing one gives all desktops
 * (null); unticking the last ticked one changes nothing (the menu greys it out).
 */
export function toggleDesktop(set: DesktopSet, desktop: VirtualDesktop, desktops: readonly VirtualDesktop[]): DesktopSet {
  const resolved = resolveDesktops(set, desktops) ?? [...desktops];
  const ticked = resolved.some((d) => d.id === desktop.id);
  const next = ticked ? resolved.filter((d) => d.id !== desktop.id) : desktops.filter((d) => d.id === desktop.id || resolved.some((r) => r.id === d.id));
  if (next.length === 0) return set;
  if (desktops.every((d) => next.some((n) => n.id === d.id))) return null;
  return choicesOf(next);
}

/** One desktop of a set read from settings.json: a GUID and / or a number, or both null (macOS / Linux); null when invalid. */
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

/** A desktop set read from settings.json (1.5.0 saved one desktop as `desktop`: a set of one). Empty or invalid = all desktops. */
export function sanitizeDesktopSet(value: unknown): DesktopSet {
  if (!Array.isArray(value)) return null;
  const choices: DesktopChoice[] = [];
  for (const item of value) {
    if (item === null || item === undefined) continue;
    const choice = sanitizeDesktopChoice(item);
    if (choice && !choices.some((c) => choiceKey(c) === choiceKey(choice))) choices.push(choice);
  }
  // "Only this one" (macOS / Linux) means nothing next to named desktops.
  const named = choices.filter((c) => c.id !== null || c.number !== null);
  const set = (named.length > 0 ? named : choices).slice(0, MAX_SET_SIZE);
  return set.length > 0 ? set : null;
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

/** A menu item: its label, and the window's desktops after a click on it. */
export type DesktopMenuEntry =
  | { kind: 'item'; label: string; type: 'checkbox' | 'radio'; checked: boolean; enabled: boolean; value: DesktopSet }
  | { kind: 'note'; label: string }
  | { kind: 'separator' };

export interface DesktopMenuInput {
  support: DesktopSupport;
  platform: NodeJS.Platform;
  /** Windows: the desktops (listDesktops). */
  desktops: readonly VirtualDesktop[];
  /** The window's saved desktops. */
  selected: DesktopSet;
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
 * *Show on desktop* ▸ for macOS / Linux X11: radio items *All desktops* / *Only this desktop*
 * (workspaces on Linux); Wayland and a failed Windows setup: one disabled line. Windows with its list
 * of desktops has the desktop picker instead (Phase 11: a menu closes on every click, the picker
 * doesn't), so nothing here.
 */
export function desktopMenuEntries(input: DesktopMenuInput): DesktopMenuEntry[] {
  const { support, platform, selected } = input;
  const word = platform === 'linux' ? 'workspace' : 'desktop';
  if (support === 'wayland') return [{ kind: 'note', label: 'Not available on Wayland' }];
  if (support === 'unavailable') return [{ kind: 'note', label: 'Not available on this computer' }];
  if (support === 'list') return [];
  const only = selected !== null;
  return [
    { kind: 'item', label: `All ${word}s`, type: 'radio', checked: !only, enabled: true, value: null },
    { kind: 'item', label: `Only this ${word}`, type: 'radio', checked: only, enabled: true, value: [{ id: null, number: null }] },
  ];
}

/** A checkbox of the desktop picker, and the window's desktops after a click on it. */
export interface DesktopCell {
  checked: boolean;
  enabled: boolean;
  value: DesktopSet;
}

/**
 * One window's checkboxes in the desktop picker (Windows, Phase 11): *All desktops*, then one per
 * desktop in Task View order. While *All desktops* is ticked every desktop is too (unticking one keeps
 * the others); ticking the last missing one gives *All desktops*; the last ticked desktop is greyed (a
 * window is on at least one); unticking *All desktops* keeps only the current desktop.
 */
export function desktopCells(selected: DesktopSet, desktops: readonly VirtualDesktop[]): DesktopCell[] {
  const resolved = resolveDesktops(selected, desktops);
  // Desktops that are all gone put the overlay on all desktops (setToSave); an unreadable list leaves it where it is.
  const all = selected === null || (!resolved && desktops.length > 0);
  const ticked = all ? desktops : (resolved ?? []);
  const current = desktops.find((d) => d.current);
  return [
    { checked: all, enabled: !all || current !== undefined, value: all && current ? [{ id: current.id, number: current.number }] : null },
    ...desktops.map((d): DesktopCell => {
      const checked = ticked.some((t) => t.id === d.id);
      return { checked, enabled: !(checked && ticked.length === 1), value: toggleDesktop(all ? null : selected, d, desktops) };
    }),
  ];
}

/** A column of the desktop picker: 'all' or a desktop's GUID. */
export const ALL_DESKTOPS = 'all';

/**
 * What the desktop picker shows (Phase 11): a row per overlay window (its account), a column for
 * *All desktops* and one per desktop, and a hint how to add a desktop while there is only one.
 */
export function desktopPickerState(
  windows: ReadonlyArray<{ key: string; label: string; set: DesktopSet }>,
  desktops: readonly VirtualDesktop[],
  focus: string | null,
): DesktopPickerState {
  return {
    columns: [
      { key: ALL_DESKTOPS, label: 'All desktops', current: false },
      ...desktops.map((d) => ({ key: d.id, label: d.name, current: d.current })),
    ],
    rows: windows.map((w) => ({ key: w.key, label: w.label, cells: desktopCells(w.set, desktops).map(({ checked, enabled }) => ({ checked, enabled })) })),
    hint: desktops.length <= 1 ? 'Add a desktop with Win+Ctrl+D' : null,
    focus: windows.some((w) => w.key === focus) ? focus : null,
  };
}

/** The desktops after a click in the picker: the window's set and the column clicked; undefined when that cell can't be clicked. */
export function pickDesktop(selected: DesktopSet, column: string, desktops: readonly VirtualDesktop[]): DesktopSet | undefined {
  const found = desktops.findIndex((d) => d.id === column);
  const index = column === ALL_DESKTOPS ? 0 : found >= 0 ? found + 1 : -1; // a desktop removed meanwhile: nothing
  const cell = index >= 0 ? desktopCells(selected, desktops)[index] : undefined;
  return cell?.enabled ? cell.value : undefined;
}

/** Desktops for the log: numbers, never names (users name desktops after clients or projects). */
export function desktopLogName(set: DesktopSet): string {
  if (!set) return 'all desktops';
  if (isThisOnly(set)) return 'only the desktop it is on';
  const numbers = set.map((c) => c.number).filter((n): n is number => n !== null);
  if (numbers.length === 0) return set.length === 1 ? 'a desktop' : `${set.length} desktops`;
  return `${numbers.length === 1 && set.length === 1 ? 'desktop' : 'desktops'} ${numbers.join(', ')}${numbers.length < set.length ? ' and more' : ''}`;
}
