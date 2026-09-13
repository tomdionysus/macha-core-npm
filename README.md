# @machafoundation/core

The platform-independent half of a Macha client: everything a client does that is not presentation.

Macha is a self-hosted media server that runs as a cluster of nodes. This package is the shared client library four apps are built on — the React web/TV app, its Samsung Tizen build, a React Native phone app and a React Native Android TV app. It holds the parts that are genuinely the same on all of them, so they cannot drift apart:

| Area | What it owns |
| --- | --- |
| `api/` | The Macha REST families — catalogue, media, manage, acquisition, server and cluster status — plus HTTP compatibility, error-envelope decoding and the anonymous session lifecycle. |
| `cluster/` | The endpoint registry, evidence-ranked routing, failure classification, and the bounded health and discovery loop. |
| `playback/` | Deciding how to play something, resolving a session against the cluster, coordinating transport and failover, and the stall/start watchdogs. |
| `state/` | Continue Watching, the play queue, playlists and volume, over an injected synchronous storage. |
| `runtime/` | The host environment — storage, clock, id generator, base origin — the connection-state bus, and client configuration. |
| `platform/` | The `Platform` and `Player` interfaces a host implements. |

**The one idea worth knowing before reading anything else:** the server reports what the media is and performs what it is told. It chooses nothing, and there is no `auto`. So the client decides whether to play a file as it is, repackage it, or re-encode it — and this package makes that decision once, for every client. See [Choosing how to play something](docs/choosing-playback.md).

- **No runtime dependencies**, and none planned.
- **No browser assumed.** Enforced, not asserted: `npm run lint:platform` compiles the package with no DOM library at all, against the surface declared in [`types/platform-neutral.d.ts`](types/platform-neutral.d.ts). A host that lacks something on that list must supply it.
- **ESM with type declarations**, built to `dist/`.

## What it deliberately leaves to a host

Presentation, navigation, React, the `hls.js` web player, the Service Worker read-ahead proxy, and anything that resolves a build mode.

Beyond implementing `Player`, a host is expected to supply:

- a `MachaClientConfiguration` built from wherever its endpoints come from;
- its own `PlatformTarget`, applied once at start;
- `facts` and `policyOverrides` to `PlaybackRuntime`, so the chooser knows what the media is, what the node can do with it, and what this device gets wrong about itself;
- lifecycle binding for `EndpointHealthMonitor` and memoization for `createMachaServices`;
- **a call to `PlaybackRuntime.terminateForPageExit()` when the host is going away.** Nothing here can decide this, and getting it wrong is invisible locally: a node holds the session's transcode entitlement for 30 minutes, so on a one-slot node the *next* viewer gets a 429 and nothing points at the client that caused it. `pagehide` is right for a browser tab and useless on a TV, which suspends without firing it. Note the ceiling: the closing `DELETE` rides on `keepalive`, which is browser-only, so on native hosts this is best-effort in a way no client can fully close.

## Documentation

| Guide | Read it when |
| --- | --- |
| [Choosing how to play something](docs/choosing-playback.md) | Always, if you touch playback. |
| [Writing a player](docs/writing-a-player.md) | You are bringing the core to a new platform — the one interface a host must implement, and the contracts its type signature does not show. |
| [A headless Macha client](docs/headless-client.md) | You want the whole core working with no UI, or a server smoke test. [`docs/examples/headless.mjs`](docs/examples/headless.mjs) runs against a real node in one command. |
| [Async storage on a synchronous interface](docs/async-storage.md) | Your platform's storage returns promises and `StorageLike` does not. |
| [History](HISTORY.md) | You want to know why something is the way it is before changing it. |
| [Active work](TODO/ACTIVE.md) · [Completed](TODO/COMPLETED.md) | You want to know what is open, who it waits on, and what has already been tried and abandoned. |

## Installing

Consumers link it from the working tree:

```sh
npm install file:../macha-ts
```

`file:` dependencies are symlinked and npm does not build them for you, so **build it first and rebuild after every change**. A stale `dist/` typechecks green against fresh source and only fails at runtime:

```sh
cd macha-ts && npm install && npm run build
```

Run `npm run dist:check` from a consumer's `pretest` to catch that automatically. It reports a `dist/` older than `src/`; nothing reports a `src/` ahead of its last commit, so read `git log -1` rather than `package.json` when you need to know what a build contains.

## Getting started

Install the host environment once, at application start, **before any service is constructed** — several module-level singletons read it lazily on first use and keep whatever they find.

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

`storage` is a `StorageLike` — `getItem` / `setItem` / `removeItem`, all **synchronous**. React Native's `AsyncStorage` is not, so a native host hydrates it into memory at start and writes through behind that interface; there is a worked implementation in [Async storage on a synchronous interface](docs/async-storage.md).

Then bring up the session, the registry and the services over them:

```ts
import {
  bootstrapEndpoints, createMachaServices, EndpointHealthMonitor,
  EndpointRegistry, sessionManager,
} from '@machafoundation/core';

const registry = new EndpointRegistry(bootstrapEndpoints([
  ...configuration.bootstrapEndpoints(),
  ...configuration.discoveredEndpoints(),
]));
sessionManager.start(registry);

const services = createMachaServices({ endpointRegistry: registry, auth: sessionManager });

new EndpointHealthMonitor({
  registry, clusterStatusApi: services.clusterStatusApi,
  auth: sessionManager, configuration,
}).start();
```

Memoize `createMachaServices` on `endpointRegistry` and `auth`. Rebuilding services mid-playback orphans the active generation's node ownership, and a token refresh is never a reason to — every service authenticates through `auth` at request time.

`EndpointHealthMonitor` is what feeds routing its evidence. Without it running, endpoint ranking has nothing to rank on and falls back to configured order. `start()`/`stop()` bind to whatever lifecycle the host has; `stop()` is idempotent.

## Playback

The core drives a `Player` that the host implements. It never touches a media element or a native view.

`PlaybackResolver` is an interface, and every consumer takes the interface rather than a concrete class — so a resolver can be composed in front of another to answer what it can and delegate the rest, which is how offline playback is meant to work.

`Player.attach(host)` takes a `PlaybackHost`, treated as opaque: a DOM element on the web, a native view handle on React Native. Implementing a `Player` is the main cost of a new platform and several of its contracts are not visible in the types — read [Writing a player](docs/writing-a-player.md), and start from `FakePlayer` in `@machafoundation/core/testing`.

## Tests and checks

```sh
npm test              # node environment, no DOM
npm run test:coverage # statements/branches, with declaration-only files excluded
npm run lint:platform # compiles with no DOM library at all
npm run build         # typecheck, platform gate, emit
```

`src/test/setup.ts` gives every test a fresh in-memory host, so persisted state never leaks between tests.

Several defaults — request timeouts, retry cooldowns, throughput thresholds, the standby window — are tuned against a deliberately non-uniform cluster: a wired node, one behind flaky wifi, one across a WAN. They carry comments saying what they are calibrated *against*, not just what they are. They look arbitrary and are not.

## Why the name is scoped

`@machafoundation/core` rather than `macha-client`, on readability grounds: the web app's own package is `macha-client`, and a dependency sharing its dependant's name is hard to read in a lockfile or a stack trace. It is **not** a workaround for a Metro haste-map collision — that was raised, tested on Metro 0.84.5 / React Native 0.86, and bundled clean.

## Licence

GPL-3.0-or-later.
