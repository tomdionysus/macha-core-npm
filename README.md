# @macha/core

The generic, platform-independent client core for Macha — everything a Macha client does that is not presentation.

It is extracted from the React web/TV client so that the web app, the React Native phone app and anything else can share one implementation of the parts that are genuinely the same everywhere: the server API families, cluster endpoint routing and failover, playback resolution and coordination, and persisted client state.

- **Zero runtime dependencies.** The only dev dependencies are TypeScript and Vitest.
- **No browser globals.** Nothing here reaches for `window`, `localStorage`, `document`, `navigator` or `import.meta.env`.
- **ESM, with types.** Built to `dist/` with declarations and source maps.

## What is in it

| Area | What it owns |
| --- | --- |
| `api/` | The Macha REST families — catalogue, media, manage, acquisition, server and cluster status — plus the shared HTTP compatibility layer, error envelope decoding and the anonymous session lifecycle. |
| `cluster/` | The endpoint registry, latency/throughput-ranked routing, failure classification, and the bounded health/discovery loop. |
| `playback/` | Playback resolution against a cluster, the playback coordinator and runtime, buffered timeline maths, technical profiles and status. |
| `state/` | Continue Watching, the playback queue, music playlists and volume, over an injected synchronous storage. |
| `runtime/` | The host environment (storage, clock, id generator, base origin), the connection-state event bus and client configuration. |
| `platform/` | The `Platform`/`Player` interfaces a host implements, and the platform trait table. |

## What is deliberately *not* in it

Presentation and navigation, React hooks and components, the `hls.js` web player, the Service Worker Direct Play read-ahead proxy, and anything that resolves a build mode. Those belong to each consuming app.

Concretely, a host is expected to supply four small bindings of its own, and the web client is a working reference for all four:

- building a `MachaClientConfiguration` from wherever its endpoints come from (`import.meta.env` on the web, app config on native), including whether the build is pinned;
- resolving its own build target to a `PlatformTarget` and applying it, so `platformTraits` stays single-argument at its call sites;
- installing `clientDiagnosticsConsole()` wherever a developer can reach it, plus any clipboard affordance;
- supplying `facts` and `policyOverrides` to `PlaybackRuntime`, so the chooser knows what the media is, what the node can do with it, and what this device gets wrong about itself;
- binding `EndpointHealthMonitor` and `createMachaServices` to its own lifecycle and memoization;
- **telling the runtime when the host is going away**, by calling `PlaybackRuntime.terminateForPageExit()`. Nothing in the core can decide this, and getting it wrong is invisible from the client: nothing breaks locally, the server keeps holding the session, and with one transcode slot per node the *next* viewer gets a 429. `pagehide` alone is correct for a browser tab and useless on a TV — Tizen suspends or replaces an app without ever firing it, so every redeploy during playback orphans a session. The web client pairs it with `visibilitychange` → hidden, gated on platforms without pointer controls, because a backgrounded browser tab is still legitimately playing while a backgrounded TV app is not. A native host needs its own answer from app state.

## Documentation

Two guides in [`docs/`](docs/README.md) cover the work of bringing the core to a new host:

- **[A headless Macha client](docs/headless-client.md)** — the whole core working with no UI at all: session, cluster discovery, catalogue, playback negotiation. [`docs/examples/headless.mjs`](docs/examples/headless.mjs) is runnable against a real node in one command, and doubles as a server smoke test.
- **[Writing a player](docs/writing-a-player.md)** — the one interface a host must implement, and the contracts that are not visible in its type signature. Start from `FakePlayer` in `@macha/core/testing`.

## Installing

Consumers link it from the working tree:

```sh
npm install file:../macha-ts
```

`file:` dependencies are symlinked, and npm does **not** run a linked package's build for you — so build it first, and rebuild it after every change:

```sh
cd macha-ts && npm install && npm run build
```

Consumers import the built `dist/`, not the source, so they need no TypeScript configuration of their own to resolve it. The cost of that is a stale `dist/`: a consumer will typecheck happily against yesterday's API and only fail at runtime, with no indication that the build is behind. Neither repo's `npm install` will catch it for you. If you change this package, rebuild it before you trust a consumer's green typecheck.

## Getting started

Install the host environment once, at application start, before any service is constructed.

```ts
import { configureMachaHost, MachaClientConfiguration } from '@macha/core';

configureMachaHost({
  storage: persistentStorage,       // survives a restart
  ephemeralStorage: runStorage,     // lives as long as one run
  origin: 'http://10.44.1.50:7438', // resolves server-relative URLs
});

const configuration = new MachaClientConfiguration({
  environmentEndpoints: ['http://10.44.1.50:7438'],
});
```

`storage` is a `StorageLike`: `getItem` / `setItem` / `removeItem`, all **synchronous**. On the web that is `localStorage` (which is also the auto-detected default). React Native's `AsyncStorage` is not synchronous, so a native host must hydrate it into memory at start and write through asynchronously behind that interface — there is a worked implementation in [Async storage on a synchronous interface](docs/async-storage.md).

**Configure the host before constructing any service.** Several module-level singletons (`sessionManager` among them) read the host lazily on first use, so a service built against the default host keeps it. On the web the auto-detected default happens to be the right object and the mistake is invisible; on React Native it means a session cached into a throwaway map and re-minted on every start.

Then bring up the session, the endpoint registry and the services over them:

```ts
import {
  bootstrapEndpoints,
  createMachaServices,
  EndpointHealthMonitor,
  EndpointRegistry,
  sessionManager,
} from '@macha/core';

const registry = new EndpointRegistry(bootstrapEndpoints([
  ...configuration.bootstrapEndpoints(),
  ...configuration.discoveredEndpoints(),
]));
sessionManager.start(registry);

const services = createMachaServices({ endpointRegistry: registry, auth: sessionManager });

const health = new EndpointHealthMonitor({
  registry,
  clusterStatusApi: services.clusterStatusApi,
  auth: sessionManager,
  configuration,
});
health.start();
```

`createMachaServices` is a plain factory — memoize it on `endpointRegistry` and `auth` in whatever your framework offers. Rebuilding the services mid-playback orphans the active generation's node ownership; a token refresh is never a reason to rebuild, since every service authenticates through `auth` at request time.

`EndpointHealthMonitor.start()` / `.stop()` bind to whatever lifecycle the host has — a React effect, a screen focus, a foreground event. `stop()` is idempotent.

## Connection state

Cluster reachability transitions are published once per outage, not once per failed request:

```ts
import { subscribeConnectionState } from '@macha/core';

const unsubscribe = subscribeConnectionState(({ type, message }) => {
  // 'unreachable' once when the cluster goes away, 'reachable' once when it returns.
});
```

The web client bridges these onward as `window` `CustomEvent`s under the exported `SERVER_UNREACHABLE_EVENT` / `SERVER_REACHABLE_EVENT` names.

## Playback

`PlaybackResolver` is an interface, and every consumer of one — `PlaybackCoordinator`, `createMachaServices`'s `playbackOverride` — takes the interface rather than a concrete class. A resolver can therefore be composed in front of another, decorator style, to answer what it can and delegate the rest:

```ts
class OfflineFirstResolver implements PlaybackResolver {
  constructor(private readonly downloads: DownloadRegistry, private readonly online: PlaybackResolver) {}
  get available() { return true; }
  async resolve(media, capabilities, seekMs, preferences) {
    const local = this.downloads.find(media);
    return local
      ? localPlaybackSession(local, media, seekMs)
      : this.online.resolve(media, capabilities, seekMs, preferences);
  }
  // update / stop / failover delegate, or no-op for a local session.
}
```

The core resolves a playback session against the cluster, **decides what to ask for**, and coordinates transport, failover and progress. The server chooses nothing — it reports what the media is and performs what it is told, and there is no `auto` — so `choosePlaybackInstruction` holds that decision once for every client. See **[Choosing how to play something](docs/choosing-playback.md)**. It never touches a media element or a native view: it drives a `Player` that the host implements.

```ts
import type { Platform, Player } from '@macha/core';
```

`Player.attach(host)` takes a `PlaybackHost`, which the core treats as opaque — a DOM element on the web, a native view handle or component ref on React Native.

Implementing one is the main cost of a new platform, and several of its contracts are not visible in the types — see **[Writing a player](docs/writing-a-player.md)**. `@macha/core/testing` exports `FakePlayer`, the fixture the core's own playback suites run against, as a working skeleton and a control to test against:

```ts
import { createFakePlayer } from '@macha/core/testing';
```

## Tests

```sh
npm test
```

The suite runs in Vitest's `node` environment with no DOM. `src/test/setup.ts` gives every test a fresh in-memory host, so persisted client state never leaks between tests.

## Tuning constants

Several defaults — request timeouts, retry cooldowns, throughput thresholds — are tuned against a deliberately non-uniform cluster (a wired node, one behind flaky wifi, one across a WAN). They carry comments explaining what they are for. They look arbitrary and are not.

## Why the name is scoped

`@macha/core` rather than `macha-client`, on clarity grounds only: the web app's own package is `macha-client`, and a dependency with the same name as its dependant is hard to read in a lockfile or a stack trace. The scope also leaves room for further `@macha/*` packages if the core ever splits.

It is **not** a workaround for a Metro/haste-map collision. That concern was raised and then tested — two same-named packages, one `file:`-linked, in Metro 0.84.5 / React Native 0.86 — and it bundled clean. Renaming back would be safe and would still be a step backwards for readability.

## Licence

GPL-3.0-or-later.
