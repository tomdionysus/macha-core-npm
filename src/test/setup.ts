import { beforeEach } from 'vitest';
import { configureClientDiagnostics } from '../diagnostics/ClientLog.js';
import { configureMachaHost, memoryStorage, resetMachaHost } from '../runtime/host.js';

// Expected playback failure/recovery tests exercise verbose diagnostics. Keep
// collecting those entries while reserving test stdout/stderr for assertions
// and unexpected failures.
configureClientDiagnostics({ console: false });

// Give every test its own host storage. Persisted client state (an anonymous
// session, a bandwidth estimate, a queue) is otherwise process-wide, and one
// test's leftovers would arrive as another's starting state.
beforeEach(() => {
  resetMachaHost();
  configureMachaHost({
    storage: memoryStorage(),
    ephemeralStorage: memoryStorage(),
    origin: undefined,
  });
});
