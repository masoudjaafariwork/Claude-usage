// Small rotating log file (Electron's logs folder) that makes problems diagnosable: status changes, HTTP
// statuses, errors and source switches. Every line passes through redact() first, so tokens,
// cookies and similar secrets never reach the disk. Pure module (Node fs only).
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFn = (level: LogLevel, message: string) => void;

export const LOG_FILE = 'claude-usage.log';
const OLD_LOG_FILE = 'claude-usage.1.log';
const MAX_BYTES = 512 * 1024;

const SECRET_NAMES = 'sessionKey\\w*|cf_clearance|__cf_bm|__Secure-[\\w-]+|access_?token|refresh_?token|id_token|token';

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  // Cookie / Set-Cookie headers: the whole value up to the end of the line.
  [/\b((?:set-)?cookie)(\s*[:=]\s*)[^\r\n]*/gi, '$1$2[redacted]'],
  // Authorization: Bearer <token>
  [/\b(Bearer)\s+[\w.~+/=-]+/gi, '$1 [redacted]'],
  // Anthropic keys and tokens: sk-ant-api03-…, sk-ant-oat01-…, sk-ant-sid01-… (the claude.ai session cookie).
  [/\bsk-ant-[\w-]+/g, 'sk-ant-[redacted]'],
  // name=value pairs of known secrets (query strings, cookie strings).
  [new RegExp(`\\b(${SECRET_NAMES})=[^;&\\s"',]*`, 'gi'), '$1=[redacted]'],
  // JSON fields: "accessToken": "…"
  [
    /"(accessToken|refreshToken|access_token|refresh_token|sessionKey|token|authorization|cookie|password|secret)"\s*:\s*"[^"]*"/gi,
    '"$1":"[redacted]"',
  ],
  // JWTs.
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[redacted-jwt]'],
  // E-mail addresses.
  [/[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi, '[email]'],
  // UUIDs (org / account ids) are not secret, but the first block is enough to tell them apart.
  [/\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '$1-…'],
];

/** Removes anything token-, cookie- or e-mail-like from a log message. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export class RotatingLog {
  readonly dir: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private size: number | null = null;

  constructor(dir: string, options: { maxBytes?: number; now?: () => Date } = {}) {
    this.dir = dir;
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  get file(): string {
    return join(this.dir, LOG_FILE);
  }

  readonly write: LogFn = (level, message) => {
    const line = `${this.now().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(message)}\n`;
    try {
      mkdirSync(this.dir, { recursive: true });
      if (this.size === null) this.size = fileSize(this.file);
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        // Keep one previous file: claude-usage.log → claude-usage.1.log.
        rmSync(join(this.dir, OLD_LOG_FILE), { force: true });
        renameSync(this.file, join(this.dir, OLD_LOG_FILE));
        this.size = 0;
      }
      appendFileSync(this.file, line, 'utf8');
      this.size += bytes;
    } catch {
      // Logging must never break the app.
      this.size = null;
    }
  };

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
