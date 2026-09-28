import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MIN_RENEWAL_VERSION,
  RENEWAL_ARGS,
  RENEW_BACKOFF_MS,
  RENEW_MIN_GAP_MS,
  RenewalSchedule,
  classifyUsageOutput,
  outputExcerpt,
  parseClaudeVersion,
  renewalEnv,
  renewalResult,
  usagePathClash,
  versionAtLeast,
} from './claude-code-renewal';

const HOUR = 3_600_000;

test('the hidden run is `claude -p /usage` without a session file, MCP servers or hooks', () => {
  assert.deepEqual(RENEWAL_ARGS.slice(0, 2), ['-p', '/usage']);
  assert.ok(RENEWAL_ARGS.includes('--no-session-persistence'));
  assert.ok(RENEWAL_ARGS.includes('--strict-mcp-config'));
  const settings = RENEWAL_ARGS[RENEWAL_ARGS.indexOf('--settings') + 1];
  assert.deepEqual(JSON.parse(settings ?? ''), { disableAllHooks: true });
});

test('renewalEnv: the account’s folder, and no other sign-in or parent session', () => {
  const base = {
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://proxy:8080',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    ANTHROPIC_BASE_URL: 'https://gateway',
    CLAUDECODE: '1',
    ELECTRON_RUN_AS_NODE: '1',
    CLAUDE_CONFIG_DIR: '/home/j/.claude-default',
  };
  const added = renewalEnv(base, '/home/j/.claude-account-2');
  assert.equal(added.CLAUDE_CONFIG_DIR, '/home/j/.claude-account-2');
  assert.equal(added.HTTPS_PROXY, 'http://proxy:8080', 'proxy settings stay');
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'ELECTRON_RUN_AS_NODE']) {
    assert.equal(added[name], undefined, name);
  }
  assert.equal(renewalEnv(base, null).CLAUDE_CONFIG_DIR, '/home/j/.claude-default', 'the default account: as the app has it');
  assert.equal(renewalEnv(base, null).NO_COLOR, '1');
  assert.equal(base.ANTHROPIC_API_KEY, 'sk-ant-x', 'the app’s own environment is left alone');
});

test('versions: parsed from `claude --version`; only the one read and newer run', () => {
  assert.deepEqual(parseClaudeVersion('2.1.283 (Claude Code)\n'), [2, 1, 283]);
  assert.equal(parseClaudeVersion('command not found'), null);
  assert.ok(versionAtLeast([2, 1, 283], MIN_RENEWAL_VERSION));
  assert.ok(versionAtLeast([2, 2, 0], MIN_RENEWAL_VERSION));
  assert.ok(versionAtLeast([3, 0, 0], MIN_RENEWAL_VERSION));
  assert.ok(!versionAtLeast([2, 1, 282], MIN_RENEWAL_VERSION));
  assert.ok(!versionAtLeast([1, 9, 999], MIN_RENEWAL_VERSION));
});

test('usagePathClash: a `usage` file or folder at the root of the working folder’s drive', () => {
  const at = (file: string) => (f: string) => f === file;
  assert.ok(usagePathClash('C:\\Users\\j\\AppData\\Roaming\\Claude Usage\\claude-code-runs', 'win32', at('C:\\usage')));
  assert.ok(!usagePathClash('D:\\data\\runs', 'win32', at('C:\\usage')), 'another drive');
  assert.ok(usagePathClash('/home/j/.config/Claude Usage/claude-code-runs', 'linux', at('/usage')));
  assert.ok(!usagePathClash('/home/j/.config/Claude Usage/claude-code-runs', 'linux', () => false));
});

/** Claude Code 2.1.283's `claude -p /usage`, signed in (2026-09-28; the per-session breakdown shortened). */
const SIGNED_IN = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 34% used · resets Sep 28, 6:50pm (Asia/Tehran)',
  'Current week (all models): 85% used · resets Sep 28, 7:30pm (Asia/Tehran)',
  'Current week (Fable): 58% used · resets Sep 28, 7:30pm (Asia/Tehran)',
  '',
  'What’s contributing to your limits usage?',
  'Last 24h · 1008 requests · 10 sessions',
  '  88% of your usage was at >150k context',
].join('\n');

/** The same without a usable subscription sign-in (an empty config folder): only the session's cost block. */
const NO_SIGN_IN = [
  'Total cost:            $0.0000',
  'Total duration (API):  0s',
  'Total duration (wall): 1s',
  'Total code changes:    0 lines added, 0 lines removed',
  'Usage:                 0 input, 0 output, 0 cache read, 0 cache write',
].join('\n');

test('classifyUsageOutput: /usage lines, no plan usage, "not signed in", nothing, or anything else', () => {
  assert.equal(classifyUsageOutput(SIGNED_IN), 'usage');
  assert.equal(classifyUsageOutput(NO_SIGN_IN), 'no-usage', 'the local command ran, but without plan usage');
  assert.equal(classifyUsageOutput('You are currently using your subscription to power your Claude Code usage\n\nFailed to load usage data'), 'no-usage');
  // The cost block counts the run's model tokens: any at all means the text reached the model.
  assert.equal(classifyUsageOutput(NO_SIGN_IN.replace('0 input, 0 output', '1,204 input, 87 output')), 'unexpected');
  assert.equal(classifyUsageOutput(`${SIGNED_IN}\nUsage: 12 input, 0 output`), 'unexpected');
  assert.equal(classifyUsageOutput('\x1b[1mCurrent session\x1b[0m  \x1b[32m23%\x1b[0m used'), 'usage', 'colour codes are ignored');
  assert.equal(classifyUsageOutput('Not logged in · Please run /login'), 'signed-out');
  assert.equal(classifyUsageOutput('Not logged in. Run claude auth login to authenticate.'), 'signed-out');
  assert.equal(classifyUsageOutput('OAuth token has expired. Please obtain a new token or refresh your existing token.'), 'signed-out');
  assert.equal(classifyUsageOutput('   \n'), 'empty');
  // What a model would answer if the text ever reached it: never counted as success.
  assert.equal(classifyUsageOutput('I don’t have a /usage command. Could you tell me what you’d like to check?'), 'unexpected');
  assert.equal(classifyUsageOutput('Current session'), 'unexpected', 'no numbers');
});

test('renewalResult maps a run to what happens next', () => {
  assert.deepEqual(renewalResult({ output: SIGNED_IN, exitCode: 0, timedOut: false }), { kind: 'renewed' });
  assert.deepEqual(renewalResult({ output: NO_SIGN_IN, exitCode: 0, timedOut: false }), { kind: 'no-usage' });
  assert.equal(renewalResult({ output: 'Not logged in', exitCode: 1, timedOut: false }).kind, 'signed-out');
  assert.equal(renewalResult({ output: 'Hello! How can I help?', exitCode: 0, timedOut: false }).kind, 'unexpected');
  assert.deepEqual(renewalResult({ output: '', exitCode: 1, timedOut: false }), { kind: 'failed', detail: 'no output (exit code 1)' });
  assert.deepEqual(renewalResult({ output: 'Current session: 5%', exitCode: null, timedOut: true }), { kind: 'failed', detail: 'no answer within 60 s' });
  assert.deepEqual(renewalResult({ output: '', exitCode: null, timedOut: false, error: 'spawn ENOENT' }), { kind: 'failed', detail: 'spawn ENOENT' });
});

test('outputExcerpt: one short line', () => {
  assert.equal(outputExcerpt('a\n\n  b\tc'), 'a b c');
  assert.equal(outputExcerpt('x'.repeat(300)).length, 160);
});

test('RenewalSchedule: now, then at most every 30 min; failed attempts back off 1 h … 12 h', () => {
  const s = new RenewalSchedule();
  const t0 = 1_000_000_000_000;
  assert.ok(s.due(t0), 'first time: at once');
  s.attempted(t0);
  assert.ok(!s.due(t0 + 59 * 60_000));
  assert.ok(s.due(t0 + HOUR), 'still expired afterwards: 1 h');
  const steps: number[] = [];
  let at = t0;
  for (let i = 0; i < 6; i++) {
    at = s.nextAt();
    steps.push((at - t0) / HOUR);
    s.attempted(at);
  }
  assert.deepEqual(steps.map((h, i) => h - (steps[i - 1] ?? 0)), [1, 2, 4, 8, 12, 12]);
  assert.equal(RENEW_BACKOFF_MS.at(-1), 12 * HOUR);

  // Renewed and fresh numbers: failures forgotten, the 30-minute gap still holds.
  s.succeeded();
  assert.equal(s.nextAt(), at + RENEW_MIN_GAP_MS);
});
