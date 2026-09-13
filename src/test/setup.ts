import { beforeEach } from 'vitest';
import { configureClientDiagnostics } from '../diagnostics/ClientLog.js';
import { configureMachaHost, memoryStorage, resetMachaHost } from '../runtime/host.js';

// Expected playback failure/recovery tests exercise verbose diagnostics. Keep
// collecting those entries while reserving test stdout/stderr for assertions
// and unexpected failures.
configureClientDiagnostics({ console: false });

// Give every test its own host storage. Persisted client state (a session, a
// bandwidth estimate, a queue) is otherwise process-wide, and one test's
// leftovers would arrive as another's starting state.
//
// `secureStorage` is supplied separately from `storage` so the fallback order
// in `SessionManager` is exercised as a real host would exercise it, rather
// than collapsing to one store where a wrong lookup would still pass.
beforeEach(() => {
  resetMachaHost();
  configureMachaHost({
    storage: memoryStorage(),
    secureStorage: memoryStorage(),
    origin: undefined,
  });
});
