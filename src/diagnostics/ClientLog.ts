import { defaultNow } from '../runtime/host.js';

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ClientLogEntry {
  sequence: number;
  timestamp: string;
  elapsedMs: number;
  level: ClientLogLevel;
  scope: string;
  event: string;
  data?: unknown;
}

export interface ClientLogger {
  debug(event: string, data?: unknown): void;
  info(event: string, data?: unknown): void;
  warn(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
}

interface DiagnosticsSettings {
  level: ClientLogLevel;
  console: boolean;
  maxEntries: number;
}

const levels: Record<ClientLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const startedAt = defaultNow();
let sequence = 0;
let config: DiagnosticsSettings = {
  level: 'debug',
  console: true,
  maxEntries: 2_000,
};
const entries: ClientLogEntry[] = [];

function nowMs(): number {
  return defaultNow();
}

function redactString(value: string): string {
  return value.replace(
    /(\/api\/v1\/playback\/stream\/[^/]+\/)[^/]+/g,
    '$1<capability>',
  );
}

function normalise(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => normalise(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/authorization|bearer|token/i.test(key)) {
        out[key] = '<redacted>';
      } else {
        out[key] = normalise(child, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function emit(level: ClientLogLevel, scope: string, event: string, data?: unknown): void {
  if (levels[level] < levels[config.level]) return;
  const entry: ClientLogEntry = {
    sequence: ++sequence,
    timestamp: new Date().toISOString(),
    elapsedMs: Math.round((nowMs() - startedAt) * 10) / 10,
    level,
    scope,
    event,
    ...(data === undefined ? {} : { data: normalise(data) }),
  };
  entries.push(entry);
  if (entries.length > config.maxEntries) entries.splice(0, entries.length - config.maxEntries);

  if (!config.console || typeof console === 'undefined') return;
  const prefix = `[macha ${entry.elapsedMs.toFixed(1)}ms] [${scope}] ${event}`;
  if (level === 'error') console.error(prefix, entry.data ?? '');
  else if (level === 'warn') console.warn(prefix, entry.data ?? '');
  else if (level === 'info') console.info(prefix, entry.data ?? '');
  else console.debug(prefix, entry.data ?? '');
}

export function configureClientDiagnostics(next: Partial<DiagnosticsSettings>): void {
  config = { ...config, ...next };
  if (config.maxEntries < 100) config.maxEntries = 100;
}

export function createClientLogger(scope: string, context?: Record<string, unknown>): ClientLogger {
  const write = (level: ClientLogLevel, event: string, data?: unknown) => {
    const merged = context
      ? { ...context, ...(data === undefined ? {} : { detail: data }) }
      : data;
    emit(level, scope, event, merged);
  };
  return {
    debug: (event, data) => write('debug', event, data),
    info: (event, data) => write('info', event, data),
    warn: (event, data) => write('warn', event, data),
    error: (event, data) => write('error', event, data),
  };
}

export function clientDiagnosticsText(): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n');
}

export function clientDiagnosticsSnapshot(): ClientLogEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function clearClientDiagnostics(): void {
  entries.length = 0;
}

export interface ClientDiagnosticsConsole {
  dump(): string;
  snapshot(): ClientLogEntry[];
  clear(): void;
}

/**
 * The hand-holdable diagnostics surface, as a plain object.
 *
 * The web client installs this on `window` so a developer can dump the log
 * from a device console (and adds its own clipboard `copy()` there, which is
 * a browser affordance). The core only builds it.
 */
export function clientDiagnosticsConsole(): ClientDiagnosticsConsole {
  return {
    dump: clientDiagnosticsText,
    snapshot: clientDiagnosticsSnapshot,
    clear: clearClientDiagnostics,
  };
}
