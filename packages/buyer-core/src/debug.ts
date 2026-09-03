import { createRequire } from 'node:module';

// Browser-safe env access: `process` only exists under Node/bundler shims.
function readEnv(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

function normalizeDebugValue(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

let cachedDebugFilters: string[] | null = null;

export function getDebugFilters(): readonly string[] {
  if (cachedDebugFilters) {
    return cachedDebugFilters;
  }

  const raw = readEnv('ANTSEED_LOG_FILTER') ?? readEnv('ANTSEED_DEBUG_FILTER') ?? '';
  cachedDebugFilters = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return cachedDebugFilters;
}

function getDebugSource(line: string): string | null {
  const match = /^\s*\[([^\]]{1,48})\]/.exec(line);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

export function shouldEmitDebugLine(line: string): boolean {
  const filters = getDebugFilters();
  if (filters.length === 0) {
    return true;
  }

  const normalizedLine = line.toLowerCase();
  const source = getDebugSource(line);
  return filters.some((filter) => source === filter || normalizedLine.includes(filter));
}

function shouldEmitDebug(args: unknown[]): boolean {
  return shouldEmitDebugLine(args.map((arg) => typeof arg === 'string' ? arg : String(arg)).join(' '));
}

export function isDebugEnabled(): boolean {
  const fromAntseed = normalizeDebugValue(readEnv('ANTSEED_DEBUG'));
  if (
    fromAntseed === '1' ||
    fromAntseed === 'true' ||
    fromAntseed === 'yes' ||
    fromAntseed === 'on'
  ) {
    return true;
  }

  const fromDebug = normalizeDebugValue(readEnv('DEBUG'));
  return fromDebug === '*' || fromDebug.includes('antseed');
}

/**
 * Optional file sink for debug output, in addition to console. Console
 * output is lost the moment a process is killed (`kill -9`, a crash, an
 * accidental restart) -- exactly what happened repeatedly while diagnosing
 * a real day-pass-flow bug across `apps/cli` (buyer) and
 * `levanto-routing-server` (seller) as two separate processes: getting any
 * correlated evidence meant re-running throwaway scripts with stdout
 * manually redirected each time. Set `ANTSEED_DEBUG_LOG_FILE=<path>`
 * (only takes effect alongside `ANTSEED_DEBUG=1`/`DEBUG=antseed*`, same as
 * console output) to also append every debug line, timestamped, to a real
 * file that survives the process. Synchronous append (`fs.appendFileSync`)
 * deliberately, not a buffered/async writer -- a debug log that can lose
 * its last lines to a `kill -9` defeats the point of writing it at all,
 * and this is diagnostic-path-only, never called outside `isDebugEnabled()`.
 */
let cachedLogFilePath: string | null | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- lazily required, Node-only
let cachedFsModule: any;

function getLogFilePath(): string | null {
  if (cachedLogFilePath !== undefined) {
    return cachedLogFilePath;
  }
  const raw = readEnv('ANTSEED_DEBUG_LOG_FILE');
  cachedLogFilePath = raw && raw.trim().length > 0 ? raw.trim() : null;
  return cachedLogFilePath;
}

function appendToLogFile(prefix: string, args: unknown[]): void {
  const path = getLogFilePath();
  if (!path || typeof process === 'undefined') {
    return;
  }
  try {
    cachedFsModule ??= createRequire(import.meta.url)('node:fs');
    const line = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ');
    cachedFsModule.appendFileSync(path, `${new Date().toISOString()} ${prefix} ${line}\n`);
  } catch {
    // Never let logging itself break the caller -- a failed write (bad
    // path, permissions, disk full) just means no file sink this line.
  }
}

export function debugLog(...args: unknown[]): void {
  if (isDebugEnabled() && shouldEmitDebug(args)) {
    console.log(...args);
    appendToLogFile('LOG', args);
  }
}

export function debugWarn(...args: unknown[]): void {
  if (isDebugEnabled() && shouldEmitDebug(args)) {
    console.warn(...args);
    appendToLogFile('WARN', args);
  }
}
