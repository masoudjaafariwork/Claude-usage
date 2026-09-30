import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALL_DESKTOPS,
  GUID_NULL,
  adoptDesktops,
  desktopCells,
  desktopKeyName,
  desktopLogName,
  desktopMenuEntries,
  desktopMenuTitle,
  desktopPickerState,
  guidFromBytes,
  guidToBytes,
  isThisOnly,
  isWaylandSession,
  listDesktops,
  normalizeGuid,
  parseDesktopIds,
  pickDesktop,
  resolveDesktops,
  sanitizeDesktopChoice,
  sanitizeDesktopSet,
  setToSave,
  targetDesktop,
  toggleDesktop,
  type DesktopMenuEntry,
  type DesktopRegistry,
  type VirtualDesktop,
} from './virtual-desktops-core';

// The desktops of the machine the phase was built on (session 31), in Task View order.
const D1 = '8e1d428c-0192-4625-8893-b3586bb3fc01';
const D2 = '80a258a8-9855-44a1-8839-d137d9ec5eb1';
const D3 = 'acb154a0-6a1d-4080-8a84-65ecf4365749';
/** A `Desktops\{GUID}` key left over from a removed desktop: in no list. */
const STALE = '0e283df1-b53f-45f6-ab83-4e684ae61c47';

const bytes = (...ids: string[]) => Buffer.concat(ids.map((id) => Buffer.from(guidToBytes(id))));

function registry(ids: string[] | null, current: string | null, names: Record<string, string> = {}): DesktopRegistry {
  return { ids: ids ? bytes(...ids) : null, current: current ? bytes(current) : null, name: (id) => names[id] ?? null };
}

test('GUIDs: Windows byte layout (Data1–3 little-endian), both ways', () => {
  // The first bytes of D1 as `VirtualDesktopIDs` stores them.
  const raw = Buffer.from('8c421d8e920125468893b3586bb3fc01', 'hex');
  assert.equal(guidFromBytes(raw), D1);
  assert.deepEqual(Buffer.from(guidToBytes(D1)), raw);
  assert.equal(guidFromBytes(bytes(D2, D3), 16), D3);
  assert.equal(normalizeGuid('{ACB154A0-6A1D-4080-8A84-65ECF4365749}'), D3);
  assert.equal(normalizeGuid('not-a-guid'), null);
  assert.throws(() => guidToBytes('nope'));
  assert.equal(desktopKeyName(D3), '{ACB154A0-6A1D-4080-8A84-65ECF4365749}');
});

test('parseDesktopIds: 16 bytes per desktop in order; partial entries, GUID_NULL and repeats dropped', () => {
  assert.deepEqual(parseDesktopIds(bytes(D1, D2, D3)), [D1, D2, D3]);
  assert.deepEqual(parseDesktopIds(Buffer.concat([bytes(D1, GUID_NULL, D1), Buffer.alloc(7)])), [D1]);
  assert.deepEqual(parseDesktopIds(null), []);
  assert.deepEqual(parseDesktopIds(Buffer.alloc(0)), []);
});

test('listDesktops: numbers, default names, a renamed desktop, the current one; a stale Desktops\\ key is ignored', () => {
  const list = listDesktops(registry([D1, D2, D3], D2, { [D3]: 'Usage', [STALE]: 'Old' }));
  assert.deepEqual(list, [
    { id: D1, number: 1, name: 'Desktop 1', current: false },
    { id: D2, number: 2, name: 'Desktop 2', current: true },
    { id: D3, number: 3, name: 'Usage', current: false },
  ]);
  assert.ok(!list.some((d) => d.id === STALE));
  // A blank name is Task View's default name.
  assert.equal(listDesktops(registry([D1], D1, { [D1]: '   ' }))[0]?.name, 'Desktop 1');
});

test('listDesktops: CurrentVirtualDesktop missing or unknown → the first; no VirtualDesktopIDs → the current one alone', () => {
  assert.equal(listDesktops(registry([D1, D2], null)).find((d) => d.current)?.id, D1);
  assert.equal(listDesktops(registry([D1, D2], STALE)).find((d) => d.current)?.id, D1);
  assert.deepEqual(listDesktops(registry(null, D1)), [{ id: D1, number: 1, name: 'Desktop 1', current: true }]);
  assert.deepEqual(listDesktops(registry(null, null)), []);
});

/** Three desktops, the user on the first, the third renamed. */
const three: VirtualDesktop[] = listDesktops(registry([D1, D2, D3], D1, { [D3]: 'Usage' }));
const ids = (desktops: readonly VirtualDesktop[] | null) => desktops?.map((d) => d.id) ?? null;
const c = (id: string, number: number | null) => ({ id, number });

test('resolveDesktops: the GUIDs that are there, else the same numbers, else all desktops; Task View order', () => {
  assert.equal(resolveDesktops(null, three), null);
  assert.equal(resolveDesktops([], three), null);
  assert.deepEqual(ids(resolveDesktops([c(D3, 1)], three)), [D3], 'the GUID wins over a stale number');
  assert.deepEqual(ids(resolveDesktops([c(D3, 3), c(D1, 1)], three)), [D1, D3]);
  assert.deepEqual(ids(resolveDesktops([c(D3, 3), c(STALE, 2)], three)), [D3], 'a gone desktop is dropped while another GUID is there');
  assert.deepEqual(ids(resolveDesktops([c(STALE, 2)], three)), [D2], 'new GUIDs everywhere (Windows 10 after a sign-out): the numbers');
  assert.equal(resolveDesktops([c(STALE, 4)], three), null);
  assert.equal(resolveDesktops([{ id: null, number: null }], three), null, "macOS / Linux's choice means nothing here");
});

test('setToSave: new GUIDs or numbers saved; gone desktops dropped, all gone → all; an unreadable list keeps the set', () => {
  assert.equal(setToSave(null, three), undefined);
  assert.equal(setToSave([c(D3, 3)], three), undefined);
  assert.equal(setToSave([c(D3, 3), c(D1, 1)], three), undefined, 'the same desktops in another order');
  assert.deepEqual(setToSave([c(D3, 1)], three), [c(D3, 3)], 'desktops were reordered');
  assert.deepEqual(setToSave([c(STALE, 2)], three), [c(D2, 2)]);
  assert.deepEqual(setToSave([c(D1, 1), c(STALE, 2)], three), [c(D1, 1)], 'a removed desktop leaves the set');
  assert.equal(setToSave([c(STALE, 9)], three), null);
  assert.equal(setToSave([c(STALE, 9)], []), undefined);
  assert.equal(setToSave([{ id: null, number: null }], three), undefined);
});

test('targetDesktop: the current desktop when it is in the set, else the one it is on, else the first', () => {
  const set = (...wanted: string[]) => three.filter((d) => wanted.includes(d.id));
  assert.equal(targetDesktop(set(D1, D3), D3)?.id, D1, 'follows the user');
  assert.equal(targetDesktop(set(D2, D3), D3)?.id, D3, 'the user is elsewhere: it stays');
  assert.equal(targetDesktop(set(D2, D3), D1)?.id, D2, 'on a desktop outside its set: the first');
  assert.equal(targetDesktop(set(D2, D3), null)?.id, D2);
  assert.equal(targetDesktop([], D1), null);
});

test('adoptDesktops: where the window really is wins (Task View drag, removed desktop)', () => {
  assert.deepEqual(adoptDesktops([c(D3, 3)], D2, D3, three), [c(D2, 2)]);
  assert.equal(adoptDesktops([c(D3, 3)], D3, D3, three), undefined);
  assert.deepEqual(adoptDesktops([c(D1, 1), c(D3, 3)], D2, D3, three), [c(D1, 1), c(D2, 2)], 'takes the place of the desktop it was on');
  assert.equal(adoptDesktops([c(D1, 1), c(D3, 3)], D1, D3, three), undefined, 'moved within its set');
  assert.deepEqual(adoptDesktops([c(D1, 1), c(D3, 3)], D2, null, three), [c(D1, 1), c(D2, 2), c(D3, 3)], 'not placed yet: added');
  assert.deepEqual(adoptDesktops([c(D3, 3)], D2, null, three), [c(D2, 2)], 'its only desktop: replaced');
  assert.equal(adoptDesktops([c(D3, 3)], GUID_NULL, D3, three), undefined, 'on no desktop: nothing to adopt');
  assert.equal(adoptDesktops([c(D3, 3)], null, D3, three), undefined);
  assert.equal(adoptDesktops(null, D2, null, three), undefined, 'all desktops stays all desktops');
  assert.deepEqual(adoptDesktops([c(D3, 3)], STALE, D3, []), [c(STALE, null)], 'list unreadable');
});

test('toggleDesktop: tick or untick; all ticked = all desktops; the last one stays', () => {
  const d = (id: string) => three.find((x) => x.id === id) as VirtualDesktop;
  assert.deepEqual(toggleDesktop(null, d(D2), three), [c(D1, 1), c(D3, 3)], 'from all desktops: all but this one');
  assert.equal(toggleDesktop([c(D1, 1), c(D3, 3)], d(D2), three), null, 'every desktop ticked');
  assert.deepEqual(toggleDesktop([c(D1, 1), c(D3, 3)], d(D3), three), [c(D1, 1)]);
  assert.deepEqual(toggleDesktop([c(D3, 3)], d(D1), three), [c(D1, 1), c(D3, 3)]);
  assert.deepEqual(toggleDesktop([c(D1, 1)], d(D1), three), [c(D1, 1)], 'the last one stays');
  assert.deepEqual(toggleDesktop([c(STALE, 9)], d(D1), three), [c(D2, 2), c(D3, 3)], 'desktops gone = all desktops');
});

test('sanitizeDesktopChoice: a GUID and / or a number, both null, or null when invalid', () => {
  assert.equal(sanitizeDesktopChoice(undefined), null);
  assert.equal(sanitizeDesktopChoice(null), null);
  assert.equal(sanitizeDesktopChoice('Desktop 2'), null);
  assert.deepEqual(sanitizeDesktopChoice({ id: '{ACB154A0-6A1D-4080-8A84-65ECF4365749}', number: 3 }), c(D3, 3));
  assert.deepEqual(sanitizeDesktopChoice({ id: D3 }), c(D3, null));
  assert.deepEqual(sanitizeDesktopChoice({ id: null, number: null }), { id: null, number: null });
  assert.deepEqual(sanitizeDesktopChoice({}), { id: null, number: null });
  assert.equal(sanitizeDesktopChoice({ id: 'x', number: 3 }), null);
  assert.equal(sanitizeDesktopChoice({ id: D3, number: 0 }), null);
  assert.equal(sanitizeDesktopChoice({ id: D3, number: 2.5 }), null);
});

test('sanitizeDesktopSet: valid, unique entries, at most 50; empty or invalid = all desktops', () => {
  assert.equal(sanitizeDesktopSet(undefined), null);
  assert.equal(sanitizeDesktopSet({ id: D3, number: 3 }), null, 'not a list');
  assert.equal(sanitizeDesktopSet([]), null);
  assert.equal(sanitizeDesktopSet([null]), null, "1.5.0's all desktops");
  assert.deepEqual(sanitizeDesktopSet([{ id: '{ACB154A0-6A1D-4080-8A84-65ECF4365749}', number: 3 }]), [c(D3, 3)]);
  assert.deepEqual(sanitizeDesktopSet([c(D3, 3), c(D3.toUpperCase(), 3), { id: 'x' }, c(D2, 2)]), [c(D3, 3), c(D2, 2)]);
  assert.deepEqual(sanitizeDesktopSet([{}, c(D2, 2)]), [c(D2, 2)], '"only this one" means nothing next to named desktops');
  assert.deepEqual(sanitizeDesktopSet([{}]), [{ id: null, number: null }]);
  assert.ok(isThisOnly(sanitizeDesktopSet([{}])));
  assert.equal(sanitizeDesktopSet(Array.from({ length: 60 }, (_, i) => ({ number: i + 1 })))?.length, 50);
});

test('isWaylandSession: a Wayland session unless Electron is forced to X11', () => {
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' }, '', ''), true);
  assert.equal(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-0' }, '', ''), true);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'x11' }, '', ''), false);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' }, 'x11', ''), false);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' }, '', 'x11'), false);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland', ELECTRON_OZONE_PLATFORM_HINT: 'x11' }, '', ''), false);
});

/** ☑ / ☐ checkbox, ◉ / ○ radio, "(greyed)" when disabled; notes in brackets. */
const labels = (entries: readonly DesktopMenuEntry[]) =>
  entries.map((e) => {
    if (e.kind === 'separator') return '---';
    if (e.kind === 'note') return `(${e.label})`;
    const mark = e.type === 'checkbox' ? (e.checked ? '☑' : '☐') : e.checked ? '◉' : '○';
    return `${mark} ${e.label}${e.enabled ? '' : ' (greyed)'}`;
  });
const item = (entries: readonly DesktopMenuEntry[], index: number) => {
  const entry = entries[index];
  assert.ok(entry?.kind === 'item');
  return entry;
};

/** ☑ / ☐, "(greyed)" when disabled. */
const boxes = (cells: ReadonlyArray<{ checked: boolean; enabled: boolean }>) => cells.map((c) => `${c.checked ? '☑' : '☐'}${c.enabled ? '' : ' (greyed)'}`);

test('desktopCells (the picker, Windows): all desktops ticks every desktop; unticking one keeps the others', () => {
  const list = listDesktops(registry([D1, D2, D3], D1, { [D3]: 'R&D' }));
  const all = desktopCells(null, list);
  assert.deepEqual(boxes(all), ['☑', '☑', '☑', '☑']);
  assert.deepEqual(all[0]?.value, [c(D1, 1)], 'unticking all desktops: only the current one');
  assert.deepEqual(all[2]?.value, [c(D1, 1), c(D3, 3)]);
  assert.deepEqual(boxes(desktopCells([c(STALE, 7)], list)), boxes(all), 'desktops gone: on all desktops, and the picker says so');
});

test('desktopCells (the picker, Windows): some desktops ticked; the last ticked one is greyed', () => {
  const list = listDesktops(registry([D1, D2, D3], D1));
  const one = desktopCells([c(D3, 3)], list);
  assert.deepEqual(boxes(one), ['☐', '☐', '☐', '☑ (greyed)']);
  assert.equal(one[0]?.value, null);
  assert.deepEqual(one[1]?.value, [c(D1, 1), c(D3, 3)]);
  const two = desktopCells([c(D1, 1), c(D3, 3)], list);
  assert.deepEqual(boxes(two), ['☐', '☑', '☐', '☑']);
  assert.equal(two[2]?.value, null, 'ticking the last missing one = all desktops');
  assert.deepEqual(two[3]?.value, [c(D1, 1)]);
  assert.deepEqual(boxes(desktopCells(null, listDesktops(registry(null, D1)))), ['☑', '☑ (greyed)'], 'a single desktop');
});

test('desktopPickerState: a row per window, a column for all desktops and one per desktop; the hint with one desktop', () => {
  const list = listDesktops(registry([D1, D2, D3], D2, { [D3]: 'R&D' }));
  const state = desktopPickerState(
    [
      { key: '', label: 'a@x.com', set: [c(D1, 1), c(D2, 2)] },
      { key: 'E:\work', label: 'b@y.com', set: [c(D3, 3)] },
    ],
    list,
    'E:\work',
  );
  assert.deepEqual(state.columns, [
    { key: ALL_DESKTOPS, label: 'All desktops', current: false },
    { key: D1, label: 'Desktop 1', current: false },
    { key: D2, label: 'Desktop 2', current: true },
    { key: D3, label: 'R&D', current: false },
  ]);
  assert.deepEqual(
    state.rows.map((r) => [r.label, boxes(r.cells)]),
    [
      ['a@x.com', ['☐', '☑', '☑', '☐']],
      ['b@y.com', ['☐', '☐', '☐', '☑ (greyed)']],
    ],
  );
  assert.equal(state.focus, 'E:\work');
  assert.equal(state.hint, null);
  assert.equal(desktopPickerState([], list, 'gone').focus, null);
  assert.equal(desktopPickerState([], listDesktops(registry(null, D1)), null).hint, 'Add a desktop with Win+Ctrl+D');
});

test('pickDesktop: a click in the picker by column key; greyed or unknown cells change nothing', () => {
  const list = listDesktops(registry([D1, D2, D3], D1));
  assert.deepEqual(pickDesktop(null, D2, list), [c(D1, 1), c(D3, 3)]);
  assert.deepEqual(pickDesktop(null, ALL_DESKTOPS, list), [c(D1, 1)]);
  assert.equal(pickDesktop([c(D2, 2)], ALL_DESKTOPS, list), null);
  assert.equal(pickDesktop([c(D2, 2)], D2, list), undefined, 'the last ticked desktop');
  assert.equal(pickDesktop([c(D2, 2)], STALE, list), undefined, 'a desktop that is gone');
});

test('desktopMenuEntries: macOS / Linux X11 all or this one; Wayland and a failed setup a disabled line; nothing for Windows (the picker)', () => {
  assert.deepEqual(desktopMenuEntries({ support: 'list', platform: 'win32', desktops: [], selected: null }), []);
  assert.deepEqual(labels(desktopMenuEntries({ support: 'this-only', platform: 'darwin', desktops: [], selected: null })), [
    '◉ All desktops',
    '○ Only this desktop',
  ]);
  const linux = desktopMenuEntries({ support: 'this-only', platform: 'linux', desktops: [], selected: [{ id: null, number: null }] });
  assert.deepEqual(labels(linux), ['○ All workspaces', '◉ Only this workspace']);
  assert.deepEqual(item(linux, 1).value, [{ id: null, number: null }]);
  assert.deepEqual(labels(desktopMenuEntries({ support: 'wayland', platform: 'linux', desktops: [], selected: null })), ['(Not available on Wayland)']);
  assert.deepEqual(labels(desktopMenuEntries({ support: 'unavailable', platform: 'win32', desktops: [], selected: null })), [
    '(Not available on this computer)',
  ]);
  assert.equal(desktopMenuTitle('linux'), 'Show on workspace');
  assert.equal(desktopMenuTitle('win32'), 'Show on desktop');
});

test('desktopLogName: numbers only, never a desktop name', () => {
  assert.equal(desktopLogName(null), 'all desktops');
  assert.equal(desktopLogName([c(D3, 3)]), 'desktop 3');
  assert.equal(desktopLogName([c(D1, 1), c(D3, 3)]), 'desktops 1, 3');
  assert.equal(desktopLogName([{ id: null, number: null }]), 'only the desktop it is on');
  assert.equal(desktopLogName([c(STALE, null)]), 'a desktop');
});
