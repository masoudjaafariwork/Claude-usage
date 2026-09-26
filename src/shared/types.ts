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

/** The Claude account the numbers belong to, from Claude Code's non-secret `.claude.json`. */
export interface AccountInfo {
  email: string | null;
  /** Display name, e.g. "Ada Lovelace". */
  name: string | null;
  /** Organization name, only when it isn't the personal default ("<email>'s Organization"). */
  organization: string | null;
}

export interface UsageSnapshot {
  /** ISO timestamp of when the data was fetched. */
  fetchedAt: string;
  /** Human-readable plan, e.g. "Max 20×", or null when unknown. */
  plan: string | null;
  /**
   * Whose usage this is. Null or missing when unknown: Claude Desktop samples of an org other than
   * Claude Code's, or snapshots cached before accounts were shown.
   */
  account?: AccountInfo | null;
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
  /** Click-through mode: the overlay can't be clicked (shows a lock instead of its buttons). */
  locked: boolean;
  /** Label of the working lock/unlock shortcut, e.g. "Ctrl+Alt+Shift+U"; null when there is none. */
  unlockShortcut: string | null;
  /** Show whose usage it is (e-mail) in both views; off e.g. for screen sharing. */
  showAccount: boolean;
}

export interface AppState {
  /** Last successfully fetched data. Kept (and shown as stale) when later fetches fail. */
  snapshot: UsageSnapshot | null;
  status: Status;
  refreshing: boolean;
  view: ViewSettings;
  sourceMode: SourceMode;
  /**
   * The Claude Code account picked in the menu, read from its `.claude.json` now. Shown while there
   * is no snapshot yet; a snapshot's own account wins otherwise (D41).
   */
  selectedAccount: AccountInfo | null;
  /** True when an added config folder is picked instead of the default account (Phase 6). */
  addedAccount: boolean;
  /**
   * An update waits for the user (its menu item is at the top of the menu, D47): the ⋯ button, the
   * compact pill's expand button, the lock badge and the tray icon show a coral dot (D56).
   */
  updateReady: boolean;
  /**
   * "At this pace" forecast: meter id → ISO time when the limit reaches 100 %, only for limits
   * that would hit it before their reset (and only while the data is fresh).
   */
  forecast: Record<string, string>;
}

/** API exposed to the renderer by the preload script as `window.overlay`. */
export interface OverlayApi {
  getState(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  /** The cursor entered or left a see-through overlay: it is shown fully opaque meanwhile (D57). */
  onHover(listener: (hovered: boolean) => void): () => void;
  refresh(): void;
  setCompact(compact: boolean): void;
  /** Ask the main process to fit the window to the rendered content (CSS pixels). */
  resize(width: number, height: number): void;
  showMenu(): void;
  /** Open the user's Claude Code (VS Code or a terminal) so it renews its own sign-in. */
  openClaudeCode(): void;
  /** Whether the page is hidden (Page Visibility API): hidden while the window is shown means Chromium stopped drawing it (D60). */
  pageVisibility(hidden: boolean): void;
}
