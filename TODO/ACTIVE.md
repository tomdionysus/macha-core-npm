# Active

Open work for `@macha/core`. Items land here when they are decided-but-undone, or undecided-and-blocking. Anything finished moves to [COMPLETED.md](COMPLETED.md) with the version it shipped in.

An item says who it is waiting on. "Tom" means a decision rather than an implementation; "core" means it is mine to build; a client name means the evidence has to come from there before this can move.

---

## P1 — Review of 2026-09-12: five high findings, none in the diff's own subject

**Waiting on:** Tom to triage, then core.

A general review of the working tree is in [REVIEW-2026-09-12.md](REVIEW-2026-09-12.md): 5 high, 18 medium, 28 low, ranked with file:line, scenario and fix. The five highs are each a one-place defect with a cluster-wide cost:

1. Promotion on degradation never closes the primary it abandons — the cleanup call is a no-op by identity check — so a one-slot node's transcode is stranded for `session_idle`. Reproduced.
2. A second failure signal during an in-flight failover goes terminal instead of being dropped, discarding the replacement seconds from ready.
3. An admission that succeeds after the 12 s deadline is never tracked or deleted; the slow node the deadline routes around is the one left holding the slot.
4. The ranking comparator uses pairwise thresholds inside `sort`, which is not a consistent order at three endpoints; the WAN node can win while `selectionAxis()` reports configured order. Reproduced.
5. Session minting has no timeout, and every request in the client waits on it during bootstrap and 401 re-mint.

**A measured bootstrap lockout was found after the review** and is written up as H6 (originally M16): `checkEndpointConfiguration` counts an endpoint available only on an OK response, every node answers 401 unauthenticated, so the welcome gate can accept nothing and a fresh install cannot be configured at all. Invisible to `.env`-configured clients, which is why it has survived. Two candidate fixes, one of which needs a server route; both are with the server session.

**H1 and M1 are fixed** (2026-09-12, unreleased — see COMPLETED.md); both were confirmed red before the fix and are now covered. The rest stand. Of what remains, the no-facts fallback dropping the host's container policy is the same class 0.6.3 paid for. The review also finds that the unreleased failover release now coexists with the coordinator's deferred cleanup, and one of the two policies has to go.

## P1 — Speaker layout is not a concept core has

**Waiting on:** Android TV client (measurement), then core.

`choosePlaybackInstruction` decides audio purely on codec and never reads `channels`. `PlaybackCapabilities` has a field for what a device can *decode* and none for what its output can *render*. So a 5.1 track on a device that lists `eac3` is copied through untouched, and whether it is folded down to two speakers is entirely the device's business.

There is a live report of exactly that — 5.1 playing into stereo with no downmix — and it is unresolved. The Android TV client is the best evidence available: it builds capabilities from `MediaCodecList`, so it correctly reports `ac3`/`eac3`/`ac4`, and it will show whether Media3 folds down cleanly. Either answer is useful. If it does not, this is core's gap rather than a device setting.

If it becomes real work, the shape is roughly: a render-capability field on `PlaybackCapabilities`, and a channel target on the instruction — which needs the server to accept one, so it is a wire question too.

## P1 — Four state stores are not safe for a reactive caller

**Waiting on:** Tom.

`PlaylistStore` exposes `getSnapshot()` with a stable reference, as `useSyncExternalStore` requires. `playbackQueue`, `continueWatching`, `musicPlaylist` and `volume` return a fresh array or object on every call. Fine for imperative callers, wrong for reactive ones, and **all four clients are reactive**.

The failure is not theoretical and is not merely untidy: a hook that subscribes to a revision counter and then calls `list()` memoises on the store, whose identity never changes, so the list freezes at whatever it first computed. Code that looks correct, producing a list that silently stops updating. The web client's playlist controller works today only because exactly one component owns it — a second consumer would diverge with nothing to point at.

One store doing this right and four not is worse than none doing it, because a caller cannot tell which is which.

## P2 — Probe a standby before promoting it

**Waiting on:** core.

Specified, not built. `GET /api/v1/playback/sessions/{id}` returns `engine_running` and `segments_ready` **only when an engine is present**, so their absence is the "reclaimed, needs a cold start" signal — one cheap round trip, and the same GET renews the 30-minute session timer without touching the 60 s pipeline clock.

Promotion should expect a cold start rather than counting the promotion as failed. Deferred because the standby path has been changing all day and one thing at a time is worth more than speed here.

## P2 — Three gaps in the `Platform`/`Player` contract

**Waiting on:** core, with design against the web client.

Found by the React Native clients pushing on the contract from outside. All three are defects in what core ships, not in their discipline:

1. **`Platform.createPlayer(): Player` assumes one player per platform.** React Native switches engines per queue item — expo-video for video, react-native-track-player for `kind === 'track'`, which is what gives background audio and lock-screen controls. A mixed queue of episodes and music cannot be expressed as one player created once. Preferred fix: let the coordinator tolerate the player instance changing between source generations, rather than passing a kind to `createPlayer` — the latter moves the assumption into an argument.
2. **`attach(host)` / `detachHost()` is imperative surface ownership.** A React Native video surface is a declarative `<VideoView player={...}>` owned by the render tree. The DOM *type* is gone; the shape is still wrong.
3. **No channel for OS transport commands.** Lock-screen play/pause/next/seek are queue-level commands and `Player.subscribe` carries player-to-client events only. This is a hole rather than a mismatch, and it would have stayed missing indefinitely because the web client never needed it.

## P2 — `find` cannot distinguish absence from partial failure

**Waiting on:** core.

`ClusterEndpointRouter.find` returns `undefined` both when every node says "not available" and when some said that while another failed with a 5xx. Deliberate — it stops optional metadata blocking playback on an unrelated node failure — but for playback facts the two are different answers, because absent means *transcode everything*, silently.

Shape: report whether the walk ended on unanimous absence or on absence-plus-failure, without changing the return for callers that do not care.

## P2 — Coverage is 93.4%, and the remainder is where the value is

**Waiting on:** Tom, on whether to spend it.

600 tests. Statements 93.4%, branches 84.4%. The gap is concentrated in `PlaybackCoordinator` and `PlaybackRuntime`, whose uncovered branches are the failure paths that only fire in specific combinations — failover racing a seek, a promotion during a pending mutation. Each needs a scenario built rather than an assertion added, which is why it is the slow part and also why it is the part worth having.

## P3 — Music library state should move into core

**Waiting on:** Tom to sequence.

Favourites, play counts with a commit threshold, recently-played with a cap. It exists once, in the phone client, and nothing platform-specific is in it. **One implementation is the cheapest moment to move something** — two is a negotiation about constants nobody wants, and the failure is silent: the same library ranking differently in two clients is not something anyone reports.

## P3 — Offline and cache policy needs a seam, not a move

**Waiting on:** Tom, then design.

Four decisions are common to the phone's downloads and the web's read-ahead worker: content-addressed identity as the key, always the original bytes, a bounded frontier, and a failed speculative read treated as non-terminal. The transfer mechanism can never be shared.

One correction already established: "a failed speculative read is not a playback failure" is **already** core's `subscribeDegradation`/`subscribeFailure` split, which gained `not-ready` for exactly that case. It should feed that seam rather than build a parallel one.

The real work is deciding, per constant, whether it is a rule (shared) or a tuning (per host). Getting that wrong is how a shared module grows a `platform === 'ios'` branch.

## P3 — Teardown has a ceiling no client can close

**Waiting on:** server (raised, undecided).

`PlaybackRuntime.terminateForPageExit()` rides on `keepalive`, which is browser-only. React Native ignores it and Tizen 3 does not have the property — precisely the platforms that suspend rather than navigate. A host that is force-quit, crashes or loses power sends nothing at all.

The cost is not local: a node holds a session's transcode entitlement for `session_idle` — 30 minutes — so on a one-slot node the next viewer gets `429 resource_limit` and nothing points at the client that caused it. There is no server-side mitigation today: no shorter idle for a session nothing was ever fetched from, and admission refuses rather than evicting. Both have been raised, and the second changes admission from a guarantee into a lease, so it is not a small ask.

Calling this promptly is the whole of the defence until one exists. Documented on the method and in the README.

## P3 — Shared TV navigation has no home

**Waiting on:** Tom.

Two TV clients hold hand-synchronised copies of a spatial D-pad focus scorer whose weights must agree for them to behave the same. Declined for core on the boundary: this package is everything a client does that is **not** presentation, and geometry deciding what a viewer looks at next is presentation. A boundary that bends for a good-enough case stops being able to answer the question at all.

That does not make the duplication fine. The honest options are a second shared package (`@macha/tv`) or accepting it with tests pinning the weights on both sides so a drift is at least loud. Both TV clients currently pin their own.

---

## Watching, not doing

- **`cpu_cores` and capacity ranking.** Live since server 0.36.7 and the axis switched itself on. Nothing to do unless a node reports telemetry that is stale — `telemetry_freshness` and `live_age_ms` exist and core does not weigh them. Open question rather than known defect.
- **The platform probe has never run on a device.** `checkPlatformSurface()` ships having produced no runtime truth; its tests run on Node, which supplies everything. Its first real output is due with the Android TV 5.1 measurement.
- **Two clients still hold a duration formatter.** `formatPlaybackTime` is in core and the web client has dropped its copy. The phone and Android TV clients can drop theirs whenever convenient; nothing breaks until they do, and nothing improves either.
