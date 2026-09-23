// Renders the overlay from AppState pushed by the main process.
// The DOM is rebuilt on every state change (it is tiny); bar and ring animations continue from the
// previously rendered values, so updates glide instead of jumping.
import type { AppState, BreakdownRow, LimitMeter, OverlayApi, SpendInfo, StatusKind } from '../shared/types';
import { formatAgo, formatClock, formatDuration } from './format';

declare global {
  interface Window {
    overlay: OverlayApi;
  }
}

const api = window.overlay;
const root = document.getElementById('app') as HTMLElement;
const TICK_MS = 30_000;
/** Categorical colors for the "this week by app" split. */
const SPLIT_COLORS = ['#d97757', '#8e9bff', '#5cc8e0', '#d9b77e', '#c38fd9'];

let state: AppState | null = null;
/** Last rendered percentage per meter id — the starting point of the next animation. */
const lastPercent = new Map<string, number>();
let pendingAnimations: Array<() => void> = [];

// ---- DOM helpers --------------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string | null, ...children: Child[]) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function s(tag: string, attrs: Record<string, string | number>, ...children: SVGElement[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  el.append(...children);
  return el;
}

const ICON_PATHS = {
  refresh: ['M13.5 8a5.5 5.5 0 1 1-1.61-3.89', 'M13.5 2.5v3h-3'],
  collapse: ['M3 3l3.5 3.5', 'M6.5 3.5v3h-3', 'M13 13l-3.5-3.5', 'M9.5 12.5v-3h3'],
  expand: ['M6.5 6.5L3 3', 'M3 6V3h3', 'M9.5 9.5L13 13', 'M13 10v3h-3'],
  menu: ['M3.5 8h.01', 'M8 8h.01', 'M12.5 8h.01'],
  alert: ['M8 2.5 14 13H2z', 'M8 6.5v2.75', 'M8 11.25h.01'],
  clock: ['M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z', 'M8 5v3l2 1.5'],
  offline: ['M2.5 2.5l11 11', 'M5.4 5.6A4.5 4.5 0 0 0 3 9.5 3 3 0 0 0 6 12.5h6', 'M7.6 4.1A4.5 4.5 0 0 1 12.5 8a2.6 2.6 0 0 1 1 3.3'],
  key: ['M10 2.5a3.5 3.5 0 1 1-2.9 5.4L2.5 12.5v1h2v-1.5H6V10.5h1.5l.4-.4', 'M10.5 5.5h.01'],
} as const;

type IconName = keyof typeof ICON_PATHS;

function icon(name: IconName): SVGElement {
  const width = name === 'menu' ? 2.6 : 1.6;
  return s(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ...ICON_PATHS[name].map((d) => s('path', { d })),
  );
}

function logo(): SVGElement {
  const svg = s(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'aria-hidden': 'true' },
    s('circle', { cx: 8, cy: 8, r: 6, 'stroke-opacity': 0.28 }),
    s('path', { d: 'M8 2a6 6 0 1 1-6 6' }),
  );
  svg.classList.add('logo');
  return svg;
}

function button(name: IconName, label: string, onClick: (btn: HTMLButtonElement) => void): HTMLButtonElement {
  const btn = h('button', 'icon-btn', icon(name));
  btn.type = 'button';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', () => onClick(btn));
  return btn;
}

// ---- Data helpers -------------------------------------------------------------------------------

const clampPct = (p: number) => Math.min(100, Math.max(0, p));
const pct = (p: number) => `${Math.round(p)}`;

function isStale(st: AppState): boolean {
  return st.snapshot !== null && st.status.kind !== 'ok' && st.status.kind !== 'loading';
}

function hasReset(meter: LimitMeter, now: Date): boolean {
  return meter.resetsAt !== null && Date.parse(meter.resetsAt) <= now.getTime();
}

/** Two lines describing when a limit resets. */
function resetLines(meter: LimitMeter, now: Date, stale: boolean): { main: string; sub: string } {
  if (!meter.resetsAt) {
    return meter.group === 'session'
      ? { main: 'No active session', sub: 'Starts with your next message' }
      : { main: 'No reset scheduled', sub: '' };
  }
  const at = new Date(meter.resetsAt);
  if (at.getTime() <= now.getTime()) {
    return { main: 'Window has reset', sub: stale ? 'Waiting for fresh data' : 'Refreshing…' };
  }
  const inText = `Resets in ${formatDuration(at.getTime() - now.getTime())}`;
  if (meter.percent >= 100) return { main: 'Limit reached', sub: `${inText} · ${formatClock(at, now)}` };
  return { main: inText, sub: `at ${formatClock(at, now)}` };
}

// ---- Components ---------------------------------------------------------------------------------

function ring(meter: LimitMeter, size: number, stroke: number): SVGElement {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const center = size / 2;
  const from = clampPct(lastPercent.get(meter.id) ?? 0);
  const to = clampPct(meter.percent);

  const progress = s('circle', { class: 'progress', cx: center, cy: center, r, 'stroke-width': stroke });
  progress.style.stroke = `url(#grad-${meter.severity})`;
  progress.style.strokeDasharray = String(circumference);
  progress.style.strokeDashoffset = String(circumference * (1 - from / 100));
  if (to <= 0) progress.style.visibility = 'hidden';
  pendingAnimations.push(() => {
    progress.style.strokeDashoffset = String(circumference * (1 - to / 100));
  });

  return s('svg', { viewBox: `0 0 ${size} ${size}` }, s('circle', { class: 'track', cx: center, cy: center, r, 'stroke-width': stroke }), progress);
}

function bar(meter: { id: string; percent: number }): HTMLElement {
  const fill = h('div', 'bar-fill');
  fill.style.width = `${clampPct(lastPercent.get(meter.id) ?? 0)}%`;
  pendingAnimations.push(() => {
    fill.style.width = `${clampPct(meter.percent)}%`;
  });
  return h('div', 'bar', fill);
}

function header(st: AppState): HTMLElement {
  const refresh = button('refresh', 'Refresh now', (btn) => {
    api.refresh();
    btn.classList.add('spinning');
    setTimeout(() => {
      if (!state?.refreshing) btn.classList.remove('spinning');
    }, 1200);
  });
  if (st.refreshing) refresh.classList.add('spinning');

  return h(
    'header',
    'head',
    h('div', 'brand', logo(), h('span', 'title', 'Claude Usage'), st.snapshot?.plan ? h('span', 'plan', st.snapshot.plan) : null),
    h('div', 'actions', refresh, button('collapse', 'Compact view', () => api.setCompact(true)), button('menu', 'Menu', () => api.showMenu())),
  );
}

function hero(meter: LimitMeter, now: Date, stale: boolean): HTMLElement {
  const { main, sub } = resetLines(meter, now, stale);
  const ringBox = h('div', 'ring', ring(meter, 76, 8), h('div', 'ring-value', h('span', 'num', pct(meter.percent), h('small', null, '%'))));
  return h(
    'section',
    `hero sev-${meter.severity}${hasReset(meter, now) ? ' is-reset' : ''}`,
    ringBox,
    h('div', 'hero-text', h('div', 'eyebrow', meter.label), h('div', 'hero-main', main), sub ? h('div', 'hero-sub', sub) : null),
  );
}

function meterRow(meter: LimitMeter, now: Date, stale: boolean): HTMLElement {
  const { main, sub } = resetLines(meter, now, stale);
  const line = [main, sub.replace(/^at /, '')].filter(Boolean).join(' · ');
  return h(
    'div',
    `meter sev-${meter.severity}${hasReset(meter, now) ? ' is-reset' : ''}`,
    h('div', 'meter-row', h('span', 'meter-label', meter.label), h('span', 'meter-value', `${pct(meter.percent)}%`)),
    bar(meter),
    h('div', 'meter-sub', line),
  );
}

function breakdown(rows: BreakdownRow[]): HTMLElement {
  const total = rows.reduce((sum, row) => sum + row.percent, 0) || 1;
  const color = (i: number) => SPLIT_COLORS[i % SPLIT_COLORS.length]!;
  const stack = h(
    'div',
    'stack',
    ...rows.map((row, i) => {
      const segment = h('span');
      segment.style.flex = String(row.percent / total);
      segment.style.background = color(i);
      return segment;
    }),
  );
  const legend = h(
    'div',
    'legend',
    ...rows.map((row, i) => {
      const swatch = h('i');
      swatch.style.background = color(i);
      return h('span', 'legend-item', swatch, row.label, h('b', null, `${pct(row.percent)}%`));
    }),
  );
  return h('section', 'section breakdown', h('div', 'eyebrow', 'This week, by app'), stack, legend);
}

function spendRow(spend: SpendInfo): HTMLElement {
  const amounts = spend.used && spend.limit ? `${spend.used} / ${spend.limit}` : null;
  return h(
    'section',
    `section meters sev-${spend.severity}`,
    h(
      'div',
      'meter-row',
      h('span', 'meter-label', 'Extra usage'),
      h('span', 'meter-value', amounts ? h('span', 'of', amounts) : null, `${pct(spend.percent)}%`),
    ),
    bar({ id: 'spend', percent: spend.percent }),
  );
}

interface BannerSpec {
  tone: 'warn' | 'crit';
  icon: IconName;
  title: string;
  body: Child[];
}

function retryText(st: AppState, now: Date): string {
  const next = st.status.nextAttemptAt ? Date.parse(st.status.nextAttemptAt) : NaN;
  return Number.isNaN(next) ? 'Retrying automatically.' : `Retrying in ${formatDuration(Math.max(0, next - now.getTime()))}.`;
}

function bannerSpec(st: AppState, now: Date): BannerSpec | null {
  const code = (text: string) => h('code', null, text);
  const specs: Partial<Record<StatusKind, () => BannerSpec>> = {
    'token-expired': () => ({
      tone: 'warn',
      icon: 'key',
      title: 'Claude Code sign-in expired',
      body: ['Open Claude Code to renew it — the overlay recovers on its own.'],
    }),
    'no-credentials': () => ({
      tone: 'warn',
      icon: 'key',
      title: 'Not signed in to Claude Code',
      body: ['Run ', code('claude'), ' and use ', code('/login'), '. The overlay picks it up automatically.'],
    }),
    'rate-limited': () => ({ tone: 'warn', icon: 'clock', title: 'Usage API is rate-limiting', body: [retryText(st, now)] }),
    'network-error': () => ({
      tone: 'warn',
      icon: 'offline',
      title: 'Can’t reach Anthropic',
      body: [`Check your connection or VPN. ${retryText(st, now)}`],
    }),
    error: () => ({ tone: 'crit', icon: 'alert', title: 'Something went wrong', body: [st.status.message ?? retryText(st, now)] }),
  };
  return specs[st.status.kind]?.() ?? null;
}

function banner(st: AppState, now: Date): HTMLElement | null {
  const spec = bannerSpec(st, now);
  if (!spec) return null;
  return h(
    'div',
    `banner ${spec.tone}`,
    icon(spec.icon),
    h('div', null, h('div', 'banner-title', spec.title), h('div', 'banner-body', ...spec.body)),
  );
}

function dotClass(st: AppState): string {
  const busy = st.refreshing ? ' busy' : '';
  if (st.status.kind === 'error' || (!st.snapshot && st.status.kind !== 'loading' && st.status.kind !== 'ok')) return `dot error${busy}`;
  if (isStale(st)) return `dot stale${busy}`;
  return `dot${busy}`;
}

function footerText(st: AppState, now: Date): string {
  const fetchedAt = st.snapshot ? new Date(st.snapshot.fetchedAt) : null;
  if (st.refreshing) return fetchedAt ? `Updating… · last ${formatAgo(fetchedAt, now)}` : 'Loading…';
  if (!fetchedAt) return st.status.kind === 'loading' ? 'Loading…' : 'No data yet';
  return isStale(st) ? `Last updated ${formatAgo(fetchedAt, now)}` : `Updated ${formatAgo(fetchedAt, now)}`;
}

function skeleton(): HTMLElement {
  const line = (width: string) => {
    const el = h('div', 'skel line');
    el.style.width = width;
    return el;
  };
  return h('section', 'skeleton', h('div', 'skel circle'), h('div', 'skel-lines', line('45%'), line('80%'), line('60%')));
}

// ---- Views --------------------------------------------------------------------------------------

function expandedView(st: AppState, now: Date): HTMLElement {
  const stale = isStale(st);
  const card = h('div', `card${stale ? ' stale' : ''}`, header(st));
  const snap = st.snapshot;
  if (snap) {
    const session = snap.meters.find((m) => m.group === 'session');
    const others = snap.meters.filter((m) => m !== session);
    if (session) card.append(hero(session, now, stale));
    if (others.length > 0) card.append(h('section', 'section meters', ...others.map((m) => meterRow(m, now, stale))));
    if (snap.breakdown.length > 0) card.append(breakdown(snap.breakdown));
    if (snap.spend?.enabled) card.append(spendRow(snap.spend));
  } else if (st.status.kind === 'loading') {
    card.append(skeleton());
  }
  const statusBanner = banner(st, now);
  if (statusBanner) card.append(statusBanner);
  card.append(h('footer', 'foot', h('span', dotClass(st)), footerText(st, now)));
  return card;
}

/** Session, weekly (all models), and any scoped weekly limit that is currently higher. */
function compactMeters(meters: LimitMeter[]): Array<{ meter: LimitMeter; label: string }> {
  const session = meters.find((m) => m.group === 'session');
  const weeklyAll = meters.find((m) => m.id === 'weekly_all');
  const floor = weeklyAll?.percent ?? -1;
  const scoped = meters.filter((m) => m.group === 'weekly' && m !== weeklyAll && m.percent > floor);
  return [
    ...(session ? [{ meter: session, label: 'Session' }] : []),
    ...(weeklyAll ? [{ meter: weeklyAll, label: 'Week' }] : []),
    ...scoped.map((meter) => ({ meter, label: meter.label.replace(/^Weekly · /, '') })),
  ];
}

function compactStatusText(st: AppState): string {
  const texts: Partial<Record<StatusKind, string>> = {
    loading: 'Loading…',
    'no-credentials': 'Not signed in',
    'token-expired': 'Sign-in expired',
    'rate-limited': 'Rate limited',
    'network-error': 'Offline',
    error: 'Error',
  };
  return texts[st.status.kind] ?? '';
}

function compactView(st: AppState): HTMLElement {
  const card = h('div', `card compact${isStale(st) ? ' stale' : ''}`);
  const items = st.snapshot ? compactMeters(st.snapshot.meters) : [];
  if (items.length > 0) {
    items.forEach(({ meter, label }, i) => {
      if (i > 0) card.append(h('span', 'vsep'));
      card.append(
        h(
          'div',
          `chip sev-${meter.severity}`,
          h('div', 'ring', ring(meter, 26, 4)),
          h('div', null, h('div', 'chip-value', pct(meter.percent), h('small', null, '%')), h('div', 'chip-label', label)),
        ),
      );
    });
  } else {
    card.append(logo(), h('span', 'compact-msg', compactStatusText(st)));
  }
  card.append(h('div', 'tail', h('span', dotClass(st)), button('expand', 'Expand', () => api.setCompact(false))));
  card.title = st.status.message ?? '';
  return card;
}

// ---- Render loop --------------------------------------------------------------------------------

function render(): void {
  if (!state) return;
  const now = new Date();
  pendingAnimations = [];
  const card = state.view.compact ? compactView(state) : expandedView(state, now);
  card.style.opacity = String(state.view.opacity);
  root.replaceChildren(card);

  for (const meter of state.snapshot?.meters ?? []) lastPercent.set(meter.id, meter.percent);
  if (state.snapshot?.spend) lastPercent.set('spend', state.snapshot.spend.percent);

  // Two frames: the first commits the start values, the second starts the transitions.
  const animations = pendingAnimations;
  requestAnimationFrame(() => requestAnimationFrame(() => animations.forEach((run) => run())));
}

new ResizeObserver(() => {
  const { width, height } = root.getBoundingClientRect();
  api.resize(Math.ceil(width), Math.ceil(height));
}).observe(root);

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  api.showMenu();
});

api.onState((next) => {
  state = next;
  render();
});

void api.getState().then((initial) => {
  if (initial && !state) {
    state = initial;
    render();
  }
});

// Keep countdowns and "updated … ago" current between data updates.
setInterval(render, TICK_MS);
