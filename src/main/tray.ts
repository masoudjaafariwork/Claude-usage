// System tray / menu bar icon: a live progress ring for the most constrained limit,
// a tooltip with every limit, and the shared context menu.
import { Tray, nativeImage, type Menu, type NativeImage } from 'electron';
import type { AppState, LimitMeter, Severity } from '../shared/types';
import { ringPng } from './tray-icon';
import { SOURCE_LABELS } from './usage-service';

const TOOLTIP_MAX = 127; // Windows truncates longer tooltips.

function mostConstrained(meters: LimitMeter[]): LimitMeter | null {
  return meters.reduce<LimitMeter | null>((top, m) => (top === null || m.percent > top.percent ? m : top), null);
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

  update(state: AppState, menu: Menu): void {
    const top = state.snapshot ? mostConstrained(state.snapshot.meters) : null;
    const stale = state.status.kind !== 'ok' && state.status.kind !== 'loading';
    const key = `${top?.percent ?? 'none'}|${top?.severity ?? ''}|${stale}|${state.updateReady}`;
    if (key !== this.iconKey) {
      this.iconKey = key;
      this.tray.setImage(this.icon(top?.percent ?? null, top?.severity ?? 'normal', stale, state.updateReady));
    }
    if (process.platform === 'darwin') this.tray.setTitle(top ? `${Math.round(top.percent)}%` : '');
    this.tray.setToolTip(this.tooltip(state));
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
    const text = lines.join('\n');
    return text.length > TOOLTIP_MAX ? `${text.slice(0, TOOLTIP_MAX - 1)}…` : text;
  }
}
