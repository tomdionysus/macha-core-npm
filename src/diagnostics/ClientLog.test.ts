import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearClientDiagnostics,
  clientDiagnosticsConsole,
  clientDiagnosticsSnapshot,
  clientDiagnosticsText,
  configureClientDiagnostics,
  createClientLogger,
} from './ClientLog.js';

describe('client playback diagnostics', () => {
  beforeEach(() => {
    clearClientDiagnostics();
    configureClientDiagnostics({ level: 'debug', console: false, maxEntries: 100 });
  });

  it('redacts playback capability tokens and auth-like fields', () => {
    const log = createClientLogger('test');
    log.info('stream', {
      url: 'http://node/api/v1/playback/stream/session-1/very-secret-token/2/master.m3u8',
      bearerToken: 'also-secret',
    });

    const text = clientDiagnosticsText();
    expect(text).toContain('/api/v1/playback/stream/session-1/<capability>/2/master.m3u8');
    expect(text).not.toContain('very-secret-token');
    expect(text).not.toContain('also-secret');
  });
});

describe('what reaches the log at all', () => {
  beforeEach(() => {
    clearClientDiagnostics();
    configureClientDiagnostics({ level: 'debug', console: false, maxEntries: 100 });
  });

  it('drops anything below the configured level', () => {
    configureClientDiagnostics({ level: 'warn' });
    const log = createClientLogger('test');

    log.debug('dropped-debug');
    log.info('dropped-info');
    log.warn('kept-warn');
    log.error('kept-error');

    expect(clientDiagnosticsSnapshot().map((entry) => entry.event)).toEqual(['kept-warn', 'kept-error']);
  });

  it('keeps the newest entries when the buffer is full, not the oldest', () => {
    // A trail that stops recording the moment it fills is worse than none: the
    // interesting part of an on-device failure is always the end of it.
    configureClientDiagnostics({ maxEntries: 100 });
    const log = createClientLogger('test');

    for (let index = 0; index < 150; index += 1) log.info(`event-${index}`);

    const events = clientDiagnosticsSnapshot().map((entry) => entry.event);
    expect(events).toHaveLength(100);
    expect(events.at(0)).toBe('event-50');
    expect(events.at(-1)).toBe('event-149');
  });

  it('refuses a buffer too small to hold a useful trail', () => {
    configureClientDiagnostics({ maxEntries: 1 });
    const log = createClientLogger('test');

    for (let index = 0; index < 120; index += 1) log.info(`event-${index}`);

    expect(clientDiagnosticsSnapshot()).toHaveLength(100);
  });

  it('numbers entries so a gap in a pasted dump is visible', () => {
    const log = createClientLogger('test');
    log.info('first');
    log.info('second');

    const [first, second] = clientDiagnosticsSnapshot();
    expect(second.sequence).toBe(first.sequence + 1);
  });
});

describe('normalising what a caller logs', () => {
  beforeEach(() => {
    clearClientDiagnostics();
    configureClientDiagnostics({ level: 'debug', console: false, maxEntries: 100 });
  });

  it('keeps an Error readable instead of serialising it to {}', () => {
    // JSON.stringify(new Error('x')) is '{}', so a log that does not unpack an
    // Error records that something failed and nothing about what.
    const log = createClientLogger('test');
    log.error('failed', new Error('node unreachable'));

    const [entry] = clientDiagnosticsSnapshot();
    expect(entry.data).toMatchObject({ name: 'Error', message: 'node unreachable' });
    expect((entry.data as { stack?: string }).stack).toBeTruthy();
  });

  it('redacts inside arrays and nested objects, not just at the top level', () => {
    const log = createClientLogger('test');
    log.info('request', {
      headers: { Authorization: 'Bearer secret-one' },
      urls: ['http://node/api/v1/playback/stream/s1/secret-two/2/master.m3u8'],
    });

    const text = clientDiagnosticsText();
    expect(text).not.toContain('secret-one');
    expect(text).not.toContain('secret-two');
    expect(text).toContain('<redacted>');
    expect(text).toContain('<capability>');
  });

  it('stops descending rather than following a deep structure forever', () => {
    const log = createClientLogger('test');
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let depth = 0; depth < 10; depth += 1) deep = { nested: deep };

    log.info('deep', deep);

    expect(clientDiagnosticsText()).toContain('[depth-limit]');
  });

  it('stringifies a value JSON cannot carry', () => {
    const log = createClientLogger('test');
    log.info('odd', { marker: Symbol('unserialisable') });

    expect(clientDiagnosticsText()).toContain('Symbol(unserialisable)');
  });

  it('merges a logger context and keeps the call data beside it', () => {
    const log = createClientLogger('resolver', { endpointId: 'node-a' });
    log.info('resolved', { mediaId: 'macha:media' });

    const [entry] = clientDiagnosticsSnapshot();
    expect(entry.scope).toBe('resolver');
    expect(entry.data).toEqual({ endpointId: 'node-a', detail: { mediaId: 'macha:media' } });
  });

  it('omits data entirely when a caller passed none', () => {
    createClientLogger('test').info('bare');

    expect(clientDiagnosticsSnapshot()[0]).not.toHaveProperty('data');
  });
});

describe('handing the trail to someone', () => {
  beforeEach(() => {
    clearClientDiagnostics();
    configureClientDiagnostics({ level: 'debug', console: false, maxEntries: 100 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('hands out copies, so a caller cannot edit the record it was shown', () => {
    createClientLogger('test').info('event', { a: 1 });

    const snapshot = clientDiagnosticsSnapshot();
    snapshot[0].event = 'tampered';

    expect(clientDiagnosticsSnapshot()[0].event).toBe('event');
  });

  it('dumps one JSON object per line, so a paste can be read back', () => {
    const log = createClientLogger('test');
    log.info('first');
    log.warn('second');

    const lines = clientDiagnosticsText().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ level: 'warn', event: 'second' });
  });

  it('exposes dump, snapshot and clear as one object for a device console', () => {
    createClientLogger('test').info('event');
    const surface = clientDiagnosticsConsole();

    expect(surface.snapshot()).toHaveLength(1);
    expect(surface.dump()).toContain('event');
    surface.clear();
    expect(surface.snapshot()).toEqual([]);
  });

  it('routes each level to its own console method when the console is on', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configureClientDiagnostics({ console: true });

    const log = createClientLogger('test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    configureClientDiagnostics({ console: false });

    expect(debug).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('still records when the console is off', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    createClientLogger('test').info('quiet');

    expect(info).not.toHaveBeenCalled();
    expect(clientDiagnosticsSnapshot()).toHaveLength(1);
  });
});
