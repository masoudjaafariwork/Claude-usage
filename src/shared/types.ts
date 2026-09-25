// Types shared by the main process, preload script and renderer.
// Keep this file type-only: no runtime values, so every bundle can import it freely.

export type Severity = 'normal' | 'warning' | 'critical';

/** Where usage data comes from: Claude Code's token, or Claude Desktop's usage history (no sign-in). */
export type SourceId = 'claude-code' | 'claude-desktop';
/** 'auto' tries Claude Code first, then Claude Desktop. */
export type SourceMode = 'auto' | SourceId;

/** One usage limit as shown in Claude → Settings → Usage (e.g. "Current session", "Weekly · All models"). */
export interface LimitMeter {
  /** Stable identifier, e.g. "session", "weekly_all", "weekly_scoped:fable". */
  id: string;
  group: 'session' | 'weekly' | 'other';
  label: string;
  /** Percentage used, 0–100 (may exceed 100 if the server reports it). */
  percent: number;
  severity: Severity;
  /** ISO timestamp of the next reset, or null when unknown / not started. */
  resetsAt: string | null;
  /** True for the limit that is currently the binding constraint. */
  isActive: boolean;
}

/** How this week's usage splits across surfaces (Claude Code, Chats, …). */
export interface BreakdownRow {
  key: string;
  label: string;
  percent: number;
}

/** Pay-as-you-go "extra usage" credits. */
export interface SpendInfo {
  enabled: boolean;
  percent: number;
  severity: Severity;
  /** Pre-formatted money strings, e.g. "£40.53". */
  used: string | null;
  limit: string | null;
}

export interface UsageSnapshot {
  /** ISO timestamp of when the data was fetched. */
  fetchedAt: string;
  /** Human-readable plan, e.g. "Max 20×", or null when unknown. */
  plan: string | null;
  meters: LimitMeter[];
  breakdown: BreakdownRow[];
  spend: SpendInfo | null;
  /** Where the data came from. Claude Desktop samples have no reset times (and no plan). */
  source: SourceId;
}

export type StatusKind =
  | 'loading'
  | 'ok'
  /** Nothing to read from (in Auto mode: no source is available at all). */
  | 'no-credentials'
  /** Claude Code's token has expired or was rejected. */
  | 'token-expired'
  /** Claude Desktop only: no recent sample in its usage history. */
  | 'desktop-unavailable'
  | 'rate-limited'
  | 'network-error'
  | 'error';

export interface Status {
  kind: StatusKind;
  /** Short human-readable detail for non-ok states. */
  message?: string;
  /** ISO timestamp of the next automatic attempt, when one is scheduled. */
  nextAttemptAt?: string;
}

/** Settings the renderer needs to know about. */
export interface ViewSettings {
  compact: boolean;
  opacity: number;
  /** Meter ids left out of the compact pill (the session ring always shows). */
  compactHidden: string[];
}

export interface AppState {
  /** Last successfully fetched data. Kept (and shown as stale) when later fetches fail. */
  snapshot: UsageSnapshot | null;
  status: Status;
  refreshing: boolean;
  view: ViewSettings;
  sourceMode: SourceMode;
}

/** API exposed to the renderer by the preload script as `window.overlay`. */
export interface OverlayApi {
  getState(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  refresh(): void;
  setCompact(compact: boolean): void;
  /** Ask the main process to fit the window to the rendered content (CSS pixels). */
  resize(width: number, height: number): void;
  showMenu(): void;
  /** Open the user's Claude Code (VS Code or a terminal) so it renews its own sign-in. */
  openClaudeCode(): void;
}
