# @machafoundation/core

*v0.18.0*

The platform-independent half of a Macha client: everything a client does that is not presentation.

Macha is a self-hosted media server that runs as a cluster of nodes. This package is the shared client library four apps are built on — a React web/TV app, its Samsung Tizen build, a React Native phone app and a React Native Android TV app. It holds what is genuinely the same on all of them, so they cannot drift apart.

| Area | What it owns |
| --- | --- |
| `api/` | The Macha REST families — catalogue, media, manage, acquisition, users, server and cluster status — plus HTTP compatibility, error-envelope decoding and the session lifecycle. |
| `cluster/` | The endpoint registry, evidence-ranked routing, failure classification, and the bounded health and discovery loop. |
| `playback/` | Deciding how to play something, resolving a session against the cluster, coordinating transport and failover, and the stall and start watchdogs. |
| `state/` | Continue Watching, the play queue, playlists and volume, over an injected synchronous storage. |
| `runtime/` | The host environment — storage, clock, id generator, base origin — the connection-state bus, and client configuration. |
| `platform/` | The `Platform` and `Player` interfaces a host implements. |

- **The server chooses nothing.** It reports what the media is and performs what it is told; there is no `auto`. The client decides whether to play a file as it is, repackage it, or re-encode it, and this package makes that decision once for every client. See [Choosing how to play something](docs/choosing-playback.md).
- **No runtime dependencies.**
- **No browser assumed.** `npm run lint:platform` compiles the package against no DOM library at all, over the surface declared in [`types/platform-neutral.d.ts`](types/platform-neutral.d.ts). A host that lacks anything on that list must supply it.
- **ESM with type declarations**, built to `dist/`.

## Installing

```sh
npm install @machafoundation/core
```

## Getting started

Install the host environment once, at application start, **before any service is constructed**. Several module-level singletons read it lazily on first use and keep whatever they find.

```ts
import { configureMachaHost, MachaClientConfiguration } from '@machafoundation/core';

configureMachaHost({
  storage: persistentStorage,       // survives a restart
  ephemeralStorage: runStorage,     // lives as long as one run
  origin: 'http://10.44.1.50:7438', // resolves server-relative URLs
});

const configuration = new MachaClientConfiguration({
  environmentEndpoints: ['http://10.44.1.50:7438'],
});
```

`storage` is a `StorageLike`: `getItem` / `setItem` / `removeItem`, all **synchronous**. React Native's `AsyncStorage` is not, so a native host hydrates it into memory at start and writes through behind that interface — see [Async storage on a synchronous interface](docs/async-storage.md).

Then bring up the session, the registry and the services over them:

```ts
import {
  bootstrapEndpoints, createMachaServices, EndpointHealthMonitor,
  EndpointRegistry, sessionManager,
} from '@machafoundation/core';

const registry = new EndpointRegistry([
  ...bootstrapEndpoints(configuration.bootstrapEndpoints()),
  // Seeded under their own source, or the health cycle sees nothing it is
  // allowed to persist and writes the remembered set back as empty: the
  // discovered history is wiped on every second start.
  ...bootstrapEndpoints(configuration.discoveredEndpoints(), 'discovered'),
]);
sessionManager.start(registry);

const services = createMachaServices({ endpointRegistry: registry, auth: sessionManager });

new EndpointHealthMonitor({
  registry, clusterStatusApi: services.clusterStatusApi,
  auth: sessionManager, configuration,
}).start();
```

Memoize `createMachaServices` on `endpointRegistry` and `auth`. Rebuilding services mid-playback orphans the active generation's node ownership, and a token refresh is never a reason to — every service authenticates through `auth` at request time.

`EndpointHealthMonitor` feeds routing its evidence: endpoint ranking, sibling discovery, and the per-node playback budgets. Without it running, ranking has nothing to rank on and falls back to configured order. `start()` and `stop()` bind to whatever lifecycle the host has; `stop()` is idempotent.

## Playback

The core drives a `Player` the host implements, and never touches a media element or a native view. It decides what should be playing and from where, hands that to the player, and reasons about what comes back.

`Player.attach(host)` takes a `PlaybackHost`, treated as opaque: a DOM element on the web, a native view handle on React Native. Implementing a `Player` is the main cost of a new platform, and several of its contracts are not visible in the types — read [Writing a player](docs/writing-a-player.md) and start from `FakePlayer` in `@machafoundation/core/testing`.

`PlaybackResolver` is an interface, and every consumer takes the interface rather than a concrete class, so a resolver can be composed in front of another to answer what it can and delegate the rest.

### Telling a viewer what went wrong

Four accessors, and a host should need nothing else. `playbackFailureCode` and `playbackFailureStatus` walk the cause chain for what the server said; `isAccountSessionLimit` names the one refusal a viewer can genuinely act on; and `playbackFailureDetail` returns the sentence to show them.

**Do not render `.message`.** It is a log line, and by the time a playback failure has crossed `endpointFailure` it reads *"Macha endpoint https://node.example failed: Macha playback request failed: …"* — two of core's envelopes and a node address, in front of someone trying to watch a film. Three clients displayed exactly that before these existed.

Do not reconstruct it either. Stripping core's prefixes means matching on core's wording, which goes quiet the first time one is reworded; the server's sentence is carried on the error from the moment it is parsed. `playbackFailureDetail` returning `undefined` means no layer stated one — write your own rather than falling back.

And a host must still decide what to *say*. A session holding no roles is reported faithfully by `sessionLockedOut`, but the remedy is the actionable half: it usually means signing in again, not finding an administrator, and only the host knows which of those its viewer can do.

## What a host supplies

Presentation, navigation, React, the web `hls.js` player and any Service Worker read-ahead stay with the host. Beyond implementing `Player`, a host provides:

- a `MachaClientConfiguration` built from wherever its endpoints come from;
- its own `PlatformTarget`, applied once at start;
- `facts` and `policyOverrides` to `PlaybackRuntime`, so the chooser knows what the media is, what the node can do with it, and what this device gets wrong about itself;
- lifecycle binding for `EndpointHealthMonitor`, and memoization for `createMachaServices`;
- a call to `PlaybackRuntime.terminateForPageExit()` when the host is going away;
- somewhere durable to keep the session ids core hands it, if the host wants its own leftovers closed after a crash.

The last two cannot be decided here and are invisible when wrong. A session nobody closed goes on counting against the node's per-account cap until `session_idle` reaps it, half an hour later, and on a one-slot node an abandoned transcode is felt by the *next* viewer as a `429` with nothing pointing at the client responsible. Server 0.48.1 releases the transcode entitlement after a few minutes of no stream activity, which bounds that half of it; the session record is not bounded, and closing it is the host's.

`pagehide` is right for a browser tab and useless on a television, which suspends without firing it, so a clean exit cannot be the only mechanism. What makes the rest recoverable is that a session id states its own node — core mints `${endpoint.id}::${nodeSessionId}` — so `stop()` acts on an id this process never created, and `sessionAlive()` will say whether it is worth closing. A host that persists the ids it was handed can reconcile them at start; one that does not is relying on the node's timers.

The closing `DELETE` rides on `keepalive`, which is browser-only, so on a native host the exit path alone is best-effort. Reconciliation at start is what closes that gap rather than a better exit hook.

## Documentation

| Guide | Read it when |
| --- | --- |
| [Choosing how to play something](docs/choosing-playback.md) | Always, if you touch playback. |
| [Writing a player](docs/writing-a-player.md) | You are bringing the core to a new platform. |
| [Driving the resolver directly](docs/resolver-direct.md) | You are using `ClusterPlaybackResolver` without a `PlaybackCoordinator`. Several rules elsewhere assume the coordinator is there. |
| [A headless Macha client](docs/headless-client.md) | You want the whole core working with no UI, or a server smoke test. |
| [Async storage on a synchronous interface](docs/async-storage.md) | Your platform's storage returns promises and `StorageLike` does not. |
| [Principles and laws](docs/principles-and-laws.md) | You are changing scheduling, priority or ownership. Shared with the server. |
| [History](HISTORY.md) | You want to know why something is the way it is before changing it. |
| [Active work](TODO/ACTIVE.md) · [Completed](TODO/COMPLETED.md) | You want to know what is open and who it waits on. |

## Contributing

```sh
npm test              # node environment, no DOM
npm run typecheck     # types only
npm run lint:platform # compiles with no DOM library at all
npm run test:coverage # statements and branches, declaration-only files excluded
npm run build         # typecheck, platform gate, emit to dist/
npm run dist:check    # fails when dist/ is older than src/
```

`npm run build` runs `typecheck` and `lint:platform` itself, so a change needs `npm test`, `npm run build` and `npm run dist:check`. `src/test/setup.ts` gives every test a fresh in-memory host, so persisted state never leaks between tests.

Two conventions to keep:

- **Timing defaults carry their derivation.** Request timeouts, retry cooldowns, throughput thresholds and standby windows each state in a comment what they are derived from. Change the derivation, not the number.
- **Deadlines that belong to a node are read from that node.** `startup_timeout_ms` and `segment_timeout_ms` arrive per endpoint on the cluster status payload; the compiled-in constants in `streamProtocol.ts` are the answer only for a node too old to report them. Do not add a new private copy of a server figure.

Releases are cut from `develop`: bump the version with `npm version <x.y.z> --no-git-tag-version` in its own commit, which also stamps the version under this README's title, merge to `main`, annotate a bare-semver tag (`0.14.0`, never `v0.14.0`), push, then `git checkout develop` and build last — `dist:check` compares mtimes, and a branch switch rewrites them.

## Licence

GPL-3.0-or-later.
