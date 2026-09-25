// Native notifications when a limit reaches 75 / 90 / 100 % (and, optionally, when it resets).
// notifications-core.ts decides; this file shows them and remembers what was already announced
// (userData/notifications.json), so a restart doesn't repeat a notification for the same window.
import { Notification, nativeImage } from 'electron';
import type { UsageSnapshot } from '../shared/types';
import { describeError, type LogFn } from './log';
import { checkThresholds, notificationText, sanitizeRecords, type NotifyPrefs, type NotifyRecord } from './notifications-core';
import { readJson, writeJsonAtomic } from './settings';
import { APP_ICON_PATH } from './window';

/** How many shown notifications stay referenced (a collected one loses its click handler). */
const KEEP_SHOWN = 10;

export interface NotifierOptions {
  /** Where the records live; null = memory only (mock runs). */
  file: string | null;
  /** Clicking a notification (shows the overlay). */
  onClick(): void;
  log: LogFn;
}

export class Notifier {
  private records: NotifyRecord[];
  private readonly shown: Notification[] = [];
  private readonly options: NotifierOptions;

  constructor(options: NotifierOptions) {
    this.options = options;
    this.records = options.file ? sanitizeRecords(readJson(options.file)) : [];
  }

  get supported(): boolean {
    return Notification.isSupported();
  }

  /** Checks a freshly fetched snapshot. `forecast`: meter id → ISO time of the projected 100 %. */
  check(snapshot: UsageSnapshot, prefs: NotifyPrefs, forecast: Readonly<Record<string, string>>): void {
    const now = Date.now();
    const { events, records } = checkThresholds(snapshot.meters, this.records, prefs, now);
    if (JSON.stringify(records) !== JSON.stringify(this.records)) {
      this.records = records;
      this.save();
    }
    for (const event of events) {
      const limitAt = forecast[event.meter.id];
      this.show(notificationText(event, new Date(now), limitAt ? Date.parse(limitAt) : null));
    }
  }

  /** From the menu: shows whether notifications reach the user at all (OS permission, Focus Assist…). */
  test(): void {
    this.show({ title: 'Notifications are on', body: 'Claude Usage will tell you when a limit reaches the levels you picked.' });
  }

  private show({ title, body }: { title: string; body: string }): void {
    if (!this.supported) return;
    // Windows and Linux show this image in the notification; macOS always uses the app icon.
    const icon = process.platform === 'darwin' ? undefined : nativeImage.createFromPath(APP_ICON_PATH);
    const notification = new Notification({ title, body, ...(icon ? { icon } : {}) });
    notification.on('click', () => this.options.onClick());
    notification.on('failed', (_event, error) => this.options.log('warn', `Notification failed: ${error}`));
    this.shown.push(notification);
    if (this.shown.length > KEEP_SHOWN) this.shown.shift();
    notification.show();
    this.options.log('info', `Notification: ${title}`);
  }

  private save(): void {
    if (!this.options.file) return;
    try {
      writeJsonAtomic(this.options.file, { version: 1, records: this.records });
    } catch (err) {
      this.options.log('error', `Saving notification state failed: ${describeError(err)}`);
    }
  }
}
