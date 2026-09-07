import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearClientDiagnostics,
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
