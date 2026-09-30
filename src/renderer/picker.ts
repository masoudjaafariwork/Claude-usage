// The desktop picker (Windows, Phase 11): which virtual desktops each overlay window is shown on, as
// a grid of checkboxes — a row per window (its account), a column for "All desktops" and one per
// desktop. Unlike a native menu it stays open while the user ticks; Esc, ✕ or a click elsewhere (the
// window loses the focus: main closes it) close it. Sandboxed page: DOM built with textContent only.
import type { DesktopPickerApi, DesktopPickerState } from '../shared/types';

declare global {
  interface Window {
    picker: DesktopPickerApi;
  }
}

const api = window.picker;
const root = document.getElementById('app') as HTMLElement;

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string | null, ...children: Child[]) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The ✕ of the close button, drawn like the overlay's icons. */
function closeIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M4 4l8 8', 'M12 4l-8 8']) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function cellId(row: string, column: string): string {
  return `${row}|${column}`;
}

function render(state: DesktopPickerState): void {
  // Keep the keyboard focus on the same checkbox across renders.
  const focused = (document.activeElement as HTMLElement | null)?.dataset.cell;

  const close = h('button', 'close');
  close.type = 'button';
  close.title = 'Close (Esc)';
  close.setAttribute('aria-label', 'Close');
  close.append(closeIcon());
  close.addEventListener('click', () => api.close());

  const headRow = h('tr', null, h('th', 'corner'));
  state.columns.forEach((column, i) => {
    const name = h('span', 'name', column.label);
    name.title = column.label;
    const th = h('th', i === 0 ? 'all' : column.current ? 'current' : null, name, column.current ? h('span', 'here', 'current') : null);
    th.scope = 'col';
    headRow.append(th);
  });

  const body = h('tbody');
  for (const row of state.rows) {
    const label = h('span', 'who', row.label);
    label.title = row.label;
    const th = h('th', null, label);
    th.scope = 'row';
    const tr = h('tr', row.key === state.focus ? 'focus' : null, th);
    row.cells.forEach((cell, i) => {
      const column = state.columns[i];
      if (!column) return;
      const box = h('input');
      box.type = 'checkbox';
      box.checked = cell.checked;
      box.disabled = !cell.enabled;
      box.dataset.cell = cellId(row.key, column.key);
      box.setAttribute('aria-label', `${row.label}: ${column.label}`);
      if (!cell.enabled) box.title = 'An overlay is on at least one desktop';
      box.addEventListener('change', () => api.pick(row.key, column.key));
      tr.append(h('td', i === 0 ? 'all' : column.current ? 'current' : null, box));
    });
    body.append(tr);
  }

  const table = h('table', 'grid', h('thead', null, headRow), body);
  const card = h(
    'div',
    'panel',
    h('header', null, h('h1', null, 'Show on desktops'), close),
    table,
    state.hint ? h('p', 'hint', state.hint) : null,
  );
  root.replaceChildren(card);

  const again = focused ? root.querySelector<HTMLElement>(`[data-cell="${CSS.escape(focused)}"]`) : null;
  (again ?? root.querySelector<HTMLInputElement>('input:not([disabled])'))?.focus();
}

let reported = { width: 0, height: 0 };
function fit(): void {
  const { width, height } = root.getBoundingClientRect();
  if (width === reported.width && height === reported.height) return;
  reported = { width, height };
  api.resize(width, height);
}
new ResizeObserver(fit).observe(root);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close();
});

api.onState((state) => {
  render(state);
  fit();
});
