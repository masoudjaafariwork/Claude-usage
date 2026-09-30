import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GUID_NULL,
  adoptDesktop,
  choiceToSave,
  commonSelection,
  desktopKeyName,
  desktopLogName,
  desktopMenuEntries,
  desktopMenuTitle,
  guidFromBytes,
  guidToBytes,
  isWaylandSession,
  listDesktops,
  normalizeGuid,
  parseDesktopIds,
  resolveDesktop,
  sanitizeDesktopChoice,
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

const three: VirtualDesktop[] = listDesktops(registry([D1, D2, D3], D1, { [D3]: 'Usage' }));

test('resolveDesktop: the same GUID, else the same number, else all desktops', () => {
  assert.equal(resolveDesktop(null, three), null);
  assert.equal(resolveDesktop({ id: D3, number: 1 }, three)?.id, D3, 'the GUID wins over a stale number');
  assert.equal(resolveDesktop({ id: STALE, number: 2 }, three)?.id, D2, 'new GUIDs (Windows 10 after a sign-out)');
  assert.equal(resolveDesktop({ id: STALE, number: 4 }, three), null);
  assert.equal(resolveDesktop({ id: null, number: null }, three), null, "macOS / Linux's choice means nothing here");
});

test('choiceToSave: new GUID or number saved; a gone desktop → all; an unreadable list keeps the choice', () => {
  assert.equal(choiceToSave(null, three), undefined);
  assert.equal(choiceToSave({ id: D3, number: 3 }, three), undefined);
  assert.deepEqual(choiceToSave({ id: D3, number: 1 }, three), { id: D3, number: 3 }, 'desktops were reordered');
  assert.deepEqual(choiceToSave({ id: STALE, number: 2 }, three), { id: D2, number: 2 });
  assert.equal(choiceToSave({ id: STALE, number: 9 }, three), null);
  assert.equal(choiceToSave({ id: STALE, number: 9 }, []), undefined);
  assert.equal(choiceToSave({ id: null, number: null }, three), undefined);
});

test('adoptDesktop: where the window really is wins (Task View drag, removed desktop)', () => {
  assert.deepEqual(adoptDesktop({ id: D3, number: 3 }, D2, three), { id: D2, number: 2 });
  assert.equal(adoptDesktop({ id: D3, number: 3 }, D3, three), undefined);
  assert.deepEqual(adoptDesktop({ id: D3, number: 1 }, D3, three), { id: D3, number: 3 }, 'renumbered');
  assert.equal(adoptDesktop({ id: D3, number: 3 }, GUID_NULL, three), undefined, 'on no desktop: nothing to adopt');
  assert.equal(adoptDesktop({ id: D3, number: 3 }, null, three), undefined);
  assert.equal(adoptDesktop(null, D2, three), undefined, 'all desktops stays all desktops');
  assert.deepEqual(adoptDesktop({ id: D3, number: 3 }, STALE, []), { id: STALE, number: null }, 'list unreadable');
});

test('sanitizeDesktopChoice: a GUID and / or a number, both null, or null (all desktops)', () => {
  assert.equal(sanitizeDesktopChoice(undefined), null);
  assert.equal(sanitizeDesktopChoice(null), null);
  assert.equal(sanitizeDesktopChoice('Desktop 2'), null);
  assert.deepEqual(sanitizeDesktopChoice({ id: '{ACB154A0-6A1D-4080-8A84-65ECF4365749}', number: 3 }), { id: D3, number: 3 });
  assert.deepEqual(sanitizeDesktopChoice({ id: D3 }), { id: D3, number: null });
  assert.deepEqual(sanitizeDesktopChoice({ id: null, number: null }), { id: null, number: null });
  assert.deepEqual(sanitizeDesktopChoice({}), { id: null, number: null });
  assert.equal(sanitizeDesktopChoice({ id: 'x', number: 3 }), null);
  assert.equal(sanitizeDesktopChoice({ id: D3, number: 0 }), null);
  assert.equal(sanitizeDesktopChoice({ id: D3, number: 2.5 }), null);
});

test('isWaylandSession: a Wayland session unless Electron is forced to X11', () => {
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' }, '', ''), true);
  assert.equal(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-0' }, '', ''), true);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'x11' }, '', ''), false);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' }, 'x11', ''), false);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' }, '', 'x11'), false);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland', ELECTRON_OZONE_PLATFORM_HINT: 'x11' }, '', ''), false);
});

test('commonSelection: the tray menu with several windows checks a choice only when all share it', () => {
  assert.equal(commonSelection([null, null]), null);
  assert.deepEqual(commonSelection([{ id: D2, number: 2 }, { id: D2, number: 2 }]), { id: D2, number: 2 });
  assert.equal(commonSelection([{ id: D2, number: 2 }, null]), undefined);
  assert.equal(commonSelection([{ id: D2, number: 2 }, { id: D3, number: 3 }]), undefined);
  assert.equal(commonSelection([]), undefined);
});

const labels = (entries: ReturnType<typeof desktopMenuEntries>) =>
  entries.map((e) => (e.kind === 'separator' ? '---' : e.kind === 'note' ? `(${e.label})` : `${e.checked ? '◉' : '○'} ${e.label}`));

test('desktopMenuEntries (Windows): all desktops, then each desktop with its name and (current)', () => {
  const list = listDesktops(registry([D1, D2, D3], D1, { [D3]: 'R&D' }));
  assert.deepEqual(labels(desktopMenuEntries({ support: 'list', platform: 'win32', desktops: list, selected: null })), [
    '◉ All desktops',
    '---',
    '○ Desktop 1 (current)',
    '○ Desktop 2',
    '○ R&&D',
  ]);
  const chosen = desktopMenuEntries({ support: 'list', platform: 'win32', desktops: list, selected: { id: D3, number: 3 } });
  assert.deepEqual(labels(chosen), ['○ All desktops', '---', '○ Desktop 1 (current)', '○ Desktop 2', '◉ R&&D']);
  const item = chosen[4];
  assert.ok(item?.kind === 'item');
  assert.deepEqual(item.choice, { id: D3, number: 3 });
  // Several windows on different desktops (tray menu): nothing checked.
  assert.deepEqual(
    labels(desktopMenuEntries({ support: 'list', platform: 'win32', desktops: list, selected: undefined })).filter((l) => l.startsWith('◉')),
    [],
  );
  // A saved desktop that is gone: the overlay is on all desktops, and the menu says so.
  assert.equal(labels(desktopMenuEntries({ support: 'list', platform: 'win32', desktops: list, selected: { id: STALE, number: 7 } }))[0], '◉ All desktops');
});

test('desktopMenuEntries (Windows): a single desktop gets a hint how to add one', () => {
  const one = listDesktops(registry(null, D1));
  assert.deepEqual(labels(desktopMenuEntries({ support: 'list', platform: 'win32', desktops: one, selected: null })), [
    '◉ All desktops',
    '---',
    '○ Desktop 1 (current)',
    '(Add a desktop: Win+Ctrl+D)',
  ]);
});

test('desktopMenuEntries: macOS / Linux X11 all or this one; Wayland and a failed setup a disabled line', () => {
  assert.deepEqual(labels(desktopMenuEntries({ support: 'this-only', platform: 'darwin', desktops: [], selected: null })), [
    '◉ All desktops',
    '○ Only this desktop',
  ]);
  assert.deepEqual(labels(desktopMenuEntries({ support: 'this-only', platform: 'linux', desktops: [], selected: { id: null, number: null } })), [
    '○ All workspaces',
    '◉ Only this workspace',
  ]);
  assert.deepEqual(labels(desktopMenuEntries({ support: 'wayland', platform: 'linux', desktops: [], selected: null })), ['(Not available on Wayland)']);
  assert.deepEqual(labels(desktopMenuEntries({ support: 'unavailable', platform: 'win32', desktops: [], selected: null })), [
    '(Not available on this computer)',
  ]);
  assert.equal(desktopMenuTitle('linux'), 'Show on workspace');
  assert.equal(desktopMenuTitle('win32'), 'Show on desktop');
});

test('desktopLogName: numbers only, never a desktop name', () => {
  assert.equal(desktopLogName(null), 'all desktops');
  assert.equal(desktopLogName({ id: D3, number: 3 }), 'desktop 3');
  assert.equal(desktopLogName({ id: null, number: null }), 'only the desktop it is on');
});
