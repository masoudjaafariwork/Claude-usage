// System tray / menu bar icon: a live progress ring for the most constrained limit (of every open
// account window), a tooltip with the limits, and the shared context menu.
import { Tray, nativeImage, type Menu, type NativeImage } from 'electron';
import type { AppState, LimitMeter, Severity, StatusKind } from '../shared/types';
import { ringPng } from './tray-icon';
import { SOURCE_LABELS } from './usage-service';

const TOOLTIP_MAX = 127; // Windows truncates longer tooltips.

function mostConstrained(meters: LimitMeter[]): LimitMeter | null {
  return meters.reduce<LimitMeter | null>((top, m) => (top === null || m.percent > top.percent ? m : top), null);
}

const isStale = (state: AppState) => state.status.kind !== 'ok' && state.status.kind !== 'loading';

/** Status words for a tooltip line (the banners' long texts don't fit in 127 characters). */
const SHORT_STATUS: Partial<Record<StatusKind, string>> = {
  loading: 'loading…',
  'no-credentials': 'not signed in',
  'token-expired': 'sign-in expired',
  'desktop-unavailable': 'no Desktop data',
  'rate-limited': 'rate limited',
  'network-error': 'offline',
  error: 'error',
};

/** One overlay window's account (Phase 7): its state and a short name for it (e-mail or folder). */
export interface TrayAccount {
  state: AppState;
  who: string;
}

export class TrayController {
  private readonly tray: Tray;
  private iconKey = '';

  constructor(onClick: () => void) {
    this.tray = new Tray(this.icon(null, 'normal', false, false));
    this.tray.setToolTip('Claude Usage');
    // On macOS any click opens the context menu; elsewhere a left click toggles the overlay.
    if (process.platform !== 'darwin') this.tray.on('click', onClick);
  }

  /** `accounts`: one per open window; the ring shows the most constrained limit among all of them. */
  update(accounts: readonly TrayAccount[], updateReady: boolean, menu: Menu): void {
    let top: LimitMeter | null = null;
    let stale = false;
    for (const { state } of accounts) {
      const meter = state.snapshot ? mostConstrained(state.snapshot.meters) : null;
      if (meter && (top === null || meter.percent > top.percent)) {
        top = meter;
        stale = isStale(state);
      }
    }
    if (!top) stale = accounts.some(({ state }) => isStale(state));
    const key = `${top?.percent ?? 'none'}|${top?.severity ?? ''}|${stale}|${updateReady}`;
    if (key !== this.iconKey) {
      this.iconKey = key;
      this.tray.setImage(this.icon(top?.percent ?? null, top?.severity ?? 'normal', stale, updateReady));
    }
    if (process.platform === 'darwin') this.tray.setTitle(top ? `${Math.round(top.percent)}%` : '');
    const only = accounts.length === 1 ? accounts[0] : undefined;
    this.tray.setToolTip(only ? this.tooltip(only.state) : this.accountsTooltip(accounts));
    this.tray.setContextMenu(menu);
  }

  destroy(): void {
    this.tray.destroy();
  }

  /** The ring; with `badge`, a coral dot in the corner says an update is ready (D56). */
  private icon(percent: number | null, severity: Severity, dim: boolean, badge: boolean): NativeImage {
    const image = nativeImage.createEmpty();
    for (const scaleFactor of [1, 2]) {
      const size = 16 * scaleFactor;
      image.addRepresentation({ scaleFactor, width: size, height: size, buffer: ringPng(size, { percent, severity, dim, badge }) });
    }
    return image;
  }

  private tooltip(state: AppState): string {
    const source = state.snapshot ? ` · via ${SOURCE_LABELS[state.snapshot.source]}` : '';
    const lines = [`Claude Usage${source}`];
    for (const meter of state.snapshot?.meters ?? []) lines.push(`${meter.label}: ${Math.round(meter.percent)}%`);
    if (state.status.kind !== 'ok' && state.status.message) lines.push(state.status.message);
    return fit(lines);
  }

  /** Several windows: one line per account with its most constrained limit (or what is wrong). */
  private accountsTooltip(accounts: readonly TrayAccount[]): string {
    const lines = ['Claude Usage'];
    for (const { state, who } of accounts) {
      const top = state.snapshot ? mostConstrained(state.snapshot.meters) : null;
      const status = state.status.kind !== 'ok' ? SHORT_STATUS[state.status.kind] : undefined;
      const usage = top ? `${Math.round(top.percent)}% ${top.label}` : null;
      lines.push(`${who}: ${[usage, status].filter(Boolean).join(' · ') || '—'}`);
    }
    return fit(lines);
  }
}

/** Windows cuts tooltips at 127 characters. */
function fit(lines: readonly string[]): string {
  const text = lines.join('\n');
  return text.length > TOOLTIP_MAX ? `${text.slice(0, TOOLTIP_MAX - 1)}…` : text;
}
