/**
 * Test doubles for hosts building on `@macha/core`.
 *
 * Published as the `@macha/core/testing` subpath so that a host writing its
 * own `Player` can check itself against the same fixture the core's own
 * playback suites run on, rather than inferring the interface's contracts
 * from its type signature alone.
 *
 * This entry point deliberately depends on no test runner. It is plain
 * classes, usable from Vitest, Jest, node:test or a scratch script.
 */
export { FakePlayer, createFakePlayer, type FakePlayerPlayCall } from './FakePlayer.js';
