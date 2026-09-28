// Background renewal of an expired Claude Code sign-in (Phase 8). The overlay never refreshes a
// token itself (D3): it runs the user's own Claude Code, hidden, with its local `/usage` command —
//
//   claude -p "/usage" --no-session-persistence --strict-mcp-config --settings {"disableAllHooks":true}
//
// — whose usage request lets Claude Code renew its own expired token ("401 → refresh → retry").
// Claude Code then rewrites its credentials and the overlay's watch loads fresh numbers.
//
// Why this sends no prompt (read in Claude Code 2.1.283's code, 2026-09-28): `/usage` is a built-in
// command of type "local" that supports non-interactive runs and is enabled exactly when the session
// is non-interactive, which `-p` makes it; a local command's text is never sent to the model. Were
// it ever not enabled, a built-in name is answered with "isn't available in this environment" — also
// without the model — unless a file `/usage` exists at the root of the working folder's drive, which
// usagePathClash() rules out first. Two more guards: the binary is started directly (a shell such as
// Git Bash turns `/usage` into a path, which Claude Code then sends as a real prompt), and the
// output must look like `/usage` output — anything else stops renewal for that account
// (classifyUsageOutput). Claude Code versions older than the one read are not run at all.
// Pure module (Node only).
import { execFile, spawn } from 'node:child_process';
import { posix, win32 } from 'node:path';

/** The Claude Code version whose code was read (see above); older ones are never run. */
export const MIN_RENEWAL_VERSION: readonly number[] = [2, 1, 283];
export const RENEW_TIMEOUT_MS = 60_000;
/** At most one renewal per account per 30 minutes… */
export const RENEW_MIN_GAP_MS = 30 * 60_000;
/** …and after failed ones, waits of 1 h, 2 h, 4 h, 8 h, then 12 h. */
export const RENEW_BACKOFF_MS: readonly number[] = [1, 2, 4, 8, 12].map((hours) => hours * 3_600_000);
/** Most output kept from a run (it's a few hundred bytes normally). */
const MAX_OUTPUT = 64 * 1024;

export const RENEWAL_ARGS: readonly string[] = [
  '-p',
  '/usage',
  '--no-session-persistence', // no session file, nothing in the user's session list
  '--strict-mcp-config', // no MCP servers started
  '--settings',
  '{"disableAllHooks":true}', // the user's hooks don't run for this
];

/**
 * Variables that would make Claude Code use another sign-in than the account's subscription (API key,
 * gateway, cloud provider, a token in the environment) or tell it it runs inside another Claude
 * Code session. Removed from the hidden run's environment.
 */
export const STRIPPED_ENV: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
];

/** The hidden run's environment: the account's config folder (null = the default account, as inherited). */
export function renewalEnv(base: NodeJS.ProcessEnv, configDir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: '1' };
  for (const name of STRIPPED_ENV) delete env[name];
  if (configDir !== null) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/** "2.1.283 (Claude Code)" → [2, 1, 283]. */
export function parseClaudeVersion(text: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? match.slice(1).map(Number) : null;
}

export function versionAtLeast(version: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = version[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * True when `/usage` exists as a file or folder at the root of `cwd`'s drive: Claude Code checks
 * that before treating an unknown `/usage` as a command, and would send it to the model instead.
 */
export function usagePathClash(cwd: string, platform: NodeJS.Platform, exists: (file: string) => boolean): boolean {
  const path = platform === 'win32' ? win32 : posix;
  return exists(path.join(path.parse(path.resolve(cwd)).root, 'usage'));
}

export type UsageOutput = 'usage' | 'no-usage' | 'signed-out' | 'empty' | 'unexpected';

/** Terminal colour / cursor codes (NO_COLOR is set, but just in case). */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Output without colour codes, trimmed. */
export function cleanOutput(raw: string): string {
  return raw.replace(ANSI, '').trim();
}

/**
 * What a `/usage` run printed (seen with Claude Code 2.1.283, 2026-09-28):
 * - signed in: "You are currently using your subscription to power your Claude Code usage", then
 *   "Current session: 34% used · resets …" and the weekly lines → 'usage';
 * - no usable subscription sign-in: only the session's cost block ("Total cost: $0.0000 …
 *   Usage: 0 input, 0 output, …") → 'no-usage' — still the local command, no model request;
 * - Claude Code saying the account isn't signed in → 'signed-out';
 * - nothing → 'empty';
 * - anything else, and any output whose token count shows model use → 'unexpected'.
 */
export function classifyUsageOutput(raw: string): UsageOutput {
  const text = cleanOutput(raw);
  if (text === '') return 'empty';
  // The cost block counts the run's own model tokens: anything but 0 means a prompt went out.
  const tokens = /usage:\s*([\d,]+)\s*input,\s*([\d,]+)\s*output/i.exec(text);
  if (tokens && (Number(tokens[1]?.replaceAll(',', '')) > 0 || Number(tokens[2]?.replaceAll(',', '')) > 0)) return 'unexpected';
  if (/current session/i.test(text) && /\d\s*%/.test(text)) return 'usage';
  if (/not logged in|please run \/login|\/login\b|auth login|sign in again|log in again|authentication required|invalid_grant|refresh token|oauth token (?:has )?(?:expired|been revoked)/i.test(text)) {
    return 'signed-out';
  }
  if (/currently using your subscription|total cost:/i.test(text)) return 'no-usage';
  return 'unexpected';
}

/** The first line(s) of an output, for the log (which redacts e-mails and tokens itself). */
export function outputExcerpt(raw: string, max = 160): string {
  const text = cleanOutput(raw).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export type RenewalResult =
  /** Claude Code printed usage: its sign-in works again (renewed on the way if it had expired). */
  | { kind: 'renewed' }
  /** Claude Code ran `/usage` but had no plan usage to show: its sign-in couldn't be renewed. */
  | { kind: 'no-usage' }
  /** Claude Code says the account isn't signed in: renewing can't help, the user has to sign in. */
  | { kind: 'signed-out'; excerpt: string }
  /** Output that isn't `/usage` output: renewal stops for this account. */
  | { kind: 'unexpected'; excerpt: string }
  /** It didn't run through (timeout, no output, couldn't start): tried again later. */
  | { kind: 'failed'; detail: string };

export interface RunOutcome {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The process couldn't be started. */
  error?: string;
}

export function renewalResult(run: RunOutcome, timeoutMs = RENEW_TIMEOUT_MS): RenewalResult {
  if (run.error) return { kind: 'failed', detail: run.error };
  if (run.timedOut) return { kind: 'failed', detail: `no answer within ${Math.round(timeoutMs / 1000)} s` };
  switch (classifyUsageOutput(run.output)) {
    case 'usage':
      return { kind: 'renewed' };
    case 'no-usage':
      return { kind: 'no-usage' };
    case 'signed-out':
      return { kind: 'signed-out', excerpt: outputExcerpt(run.output) };
    case 'empty':
      return { kind: 'failed', detail: `no output (exit code ${run.exitCode ?? '?'})` };
    case 'unexpected':
      return { kind: 'unexpected', excerpt: outputExcerpt(run.output) };
  }
}

/**
 * When an account may be renewed again: at most once per 30 min, and after attempts that didn't
 * bring the account back, 1 h, 2 h … 12 h. An attempt counts as failed until `succeeded()` (the
 * account shows fresh numbers again); the 30-minute gap holds after a success too.
 */
export class RenewalSchedule {
  private lastAttemptAt: number | null = null;
  private failures = 0;

  nextAt(): number {
    if (this.lastAttemptAt === null) return 0;
    const wait = this.failures === 0 ? RENEW_MIN_GAP_MS : RENEW_BACKOFF_MS[Math.min(this.failures, RENEW_BACKOFF_MS.length) - 1]!;
    return this.lastAttemptAt + wait;
  }

  due(now: number): boolean {
    return now >= this.nextAt();
  }

  attempted(now: number): void {
    this.lastAttemptAt = now;
    this.failures++;
  }

  succeeded(): void {
    this.failures = 0;
  }
}

/** Runs `claude --version` (no network, no sign-in): the version, or null. */
export function readClaudeVersion(claude: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(claude, ['--version'], { env, timeout: 15_000, windowsHide: true }, (err, stdout) => {
      const version = err ? null : parseClaudeVersion(stdout);
      resolve(version ? version.join('.') : null);
    });
  });
}

/**
 * Runs Claude Code hidden with `args`, directly (never through a shell), and collects its output.
 * After `timeoutMs` the whole process tree is killed.
 */
export function runHidden(
  claude: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; platform: NodeJS.Platform },
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(claude, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      // Its own process group elsewhere, so a timeout can end the whole tree (Windows: taskkill /T).
      detached: options.platform !== 'win32',
    });
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, options.platform);
    }, options.timeoutMs);
    child.on('error', (err) => finish({ output, exitCode: null, timedOut, error: err.message }));
    child.on('close', (code) => finish({ output, exitCode: code, timedOut }));
  });
}

function killTree(pid: number | undefined, platform: NodeJS.Platform): void {
  if (pid === undefined) return;
  if (platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}
