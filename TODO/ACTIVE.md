# Active

Open work for `@macha/core`. Items land here when they are decided-but-undone, or undecided-and-blocking. Anything finished moves to [COMPLETED.md](COMPLETED.md) with the version it shipped in.

An item says who it is waiting on. "Tom" means a decision rather than an implementation; "core" means it is mine to build; a client name means the evidence has to come from there before this can move.

---

## Start here if you are new to this

**Where things stand.** Released `0.8.1`, tagged on `main`. Work happens on `develop`; a release is an annotated bare-semver tag (`0.8.1`, never `v0.8.1`) on `main`, and the version bump goes *inside* the release commit so the tag points at exactly what ships. Sixteen tags exist, `0.2.0` through `0.8.1`, one per release.

**How to check you have not broken anything:** `npm run typecheck`, `npm run lint:platform` (the no-DOM gate — this is the one that catches a browser global sneaking into core), `npx vitest run`, `npm run build`, `npm run dist:check`. The suite is **618 tests in 57 files, all passing** as of 2026-09-13.

**Four clients consume this package** — a web/TV app, a Samsung Tizen build of the same, a React Native phone app, and a React Native Android TV app — and they resolve it through a `file:` link, so they pick up whatever `dist` holds. Build after changing source or you silently block their test suites. Most of the defects below were found *from outside*, by those clients; that is the normal way this package learns it is wrong.

**Two clients do not use `PlaybackCoordinator` at all.** The phone client calls `ClusterPlaybackResolver.failover` directly and never prepares an alternate. So a fix landed in the coordinator reaches three clients of four, and a defect on the coordinator path does not reach the phone. **Check which layer a client actually uses before telling it a fix matters to it.**

**Where these findings came from.** A full review on 2026-09-12 (five reviewers, one subsystem each, over the CodeGraph index) produced 5 high, 18 medium and 28 low findings. Four were fixed in `0.8.0`; the rest are below, folded into this file. The standalone review document was folded in here on 2026-09-13 and deleted — it is in git history if you want the original form.

**Two findings in that review were wrong**, both because a difference was inferred rather than checked, and both caught by client sessions. Before writing "these two disagree", read or run both. `codegraph_explore` returns both bodies in one call, so there is no excuse.

---

## P0 — open defects with a cluster-wide cost

Four of the original five are fixed and unreleased — see [COMPLETED.md](COMPLETED.md). What remains is the one that is not core's to decide.

### The connection gate cannot accept any endpoint against the live cluster
**Waiting on:** server (which of two fixes), then core. `src/connection/connectionConfiguration.ts:63-98`, `src/api/SessionAuth.ts:129-150`. **Measured.**

`checkEndpointConfiguration` requests `/api/v1/catalogue/status` unauthenticated and counts an endpoint available only on `response.ok`. **All three of Tom's nodes answer 401 unauthenticated** (measured by the web client), so `available` comes back empty and the result carries *"No configured endpoint accepted these connection details."* A caller that refuses to save on an empty list cannot accept any endpoint a viewer types: no endpoint saved, so no session ever minted, so the client cannot be configured at all. Same path is the post-outage reconnect.

It has survived because it is invisible to anyone whose endpoints arrive from build configuration — the reference client is `.env`-configured and never reaches the gate. **It predates the users/roles work** rather than being caused by it.

The doc comment at `:56-62` is the sharp part: it says the check "asks whether an address answers at all, which needs no credentials". That reasoning is right and the implementation contradicts it, because `response.ok` asks a stricter question. **A 401 is an answer.**

Scope: reaches callers of this function. The phone client is **not** affected — its own `firstReachable` already accepts a 401, reaching outside core the conclusion core's own comment states. That the correct version of this rule currently lives in a client is itself the finding.

Two candidate fixes, with the server session:
1. **Accept any HTTP answer as proof of life** — one line, matches the stated intent, but also accepts a 401 from something that is not Macha, which matters exactly when a viewer mistypes an address.
2. **Point the check at a genuinely unauthenticated liveness route** — unambiguous, and confirms it is really talking to Macha. Costs the server a route it does not expose.

Resolve together with the role-gating item below. The tests here exercise only 200 and a `TypeError`; a 401 case would have caught it.

---

## P1 — correctness

### Failover double-charges the failed endpoint, and two teardown policies coexist
**Waiting on:** Tom (which policy), then core. `src/playback/ClusterPlaybackResolver.ts:189-191`, `:294-304`; `src/playback/PlaybackCoordinator.ts:1447-1453`, `:1531-1553`, `:1601`.

`failover` records the failure once via `recordEndpointFailure` (500 ms cooldown). The fire-and-forget `stop()` then hits the same dead node, throws, and `stop` records again (2 s). Because `sessions.delete` only runs on success the entry survives, so the coordinator's superseded cleanup DELETEs again, records a third (10 s), and retries with backoff — each attempt another record. One observation becomes N failure records. "Racing the coordinator's own cleanup is harmless" is true of the HTTP side and false of the registry side.

Separately: the coordinator defers the old lease's DELETE until the replacement has buffered data, then retries with backoff; the resolver now DELETEs immediately, before the replacement is admitted. With a cluster resolver the coordinator's deferral is dead code and `superseded-session-closed` logs a close that never happened. `ClusterNodeFailover.test.ts:74,88-93` still passes but its single queued 204 is now consumed by the resolver, so **the test no longer exercises the deferral it describes.**

Fix: `releaseFailedSession` should call `owned.resolver.stop` directly and drop the map entry regardless of outcome. Then decide which teardown policy is the paid-for one and delete the other; whichever survives, the integration test must assert it specifically.

### The exclusion set never ages
**Waiting on:** core. `src/playback/ClusterPlaybackResolver.ts:108`, `:127`, `:342-345`, `:272`.

`failedGenerationEndpoints` resets only on `resolve()`. Two nodes, two-hour film: A blips at minute 10, B at minute 90, candidates empty, bare `Error('No untried Macha playback endpoint remains.')`, terminal — while A has been probed healthy for 80 minutes. Fix: when exclusion empties the list, fall back to registry-ordered candidates whose cooldown has expired, or drop an id on `recordSuccess`/`recordProbeSuccess`.

### Watchdog blind spots on the platform it was written for
**Waiting on:** core. `src/playback/MediaWatchdog.ts:324-352`, `:326-332`, `:226-233`.

1. **Backward seek defeats the baseline — take this one first.** `lastBufferedEndMs` is a running max, so after a backward seek buffer growth at the new position never counts as advancing and a healthy below-realtime transcode is evicted 7 s later, which is the eviction the class comment says it exists to avoid. **On Android TV the D-pad *is* the seek affordance** and that client commits a seek after every rewind burst, so it condemns healthy nodes as ordinary viewing, not as an edge case. The observable is a failover roughly 7 s after any rewind. Web and phone have scrubbers people touch rarely, which is what kept it invisible.
2. **No re-arm after `suspend()`.** `lastPositionMs` is kept and only `note()` re-arms, but `note()` returns early unless something advanced. Pause, node dies, resume: nothing advances, nothing arms, frozen forever. Only "paused is not stalled" is tested.
3. **The +1 s margin comment overclaims.** It says the budget only has to outlast the hold, but the watchdog reads only `currentTime`/`buffered` and a `500` carries no bytes; hold + player retry delay + first byte exceeds 7 s. Either record the real relationship or say plainly that holds do trip it and that is accepted.

### Background discovery records real routing evidence
**Waiting on:** core. `src/cluster/EndpointHealthMonitor.ts:230`; `src/services/createMachaServices.ts:67`; `src/cluster/endpointRouting.ts:144-166`.

`clusterStatusApi` routes through `route()`, so each 10 s discovery call does `recordSuccess`/`recordFailure`. A status timeout permanently un-sticks the preferred endpoint — precisely what `recordProbeFailure` exists to avoid — and a success elsewhere steals preference. Contradicts `EndpointHealthMonitor.ts:192` ("owns no server or playback state") and `endpointRouting.ts:21-23`. Fix: an advisory path using the probe variants.

### A storage write error kills the health loop silently
**Waiting on:** core. `src/cluster/EndpointHealthMonitor.ts:237-238`; `src/runtime/configuration.ts:148-151`.

`persistConfirmedEndpoints` → `setItem` is uncaught. A `QuotaExceededError` (TVs) rejects `cycle()`, the `void` swallows it as an unhandled rejection, no reschedule runs, and `running` stays `true`. `EndpointBandwidth.write()` catches for exactly this reason — two copies of one rule, disagreeing. Fix: try/catch the persist, reschedule in a `finally`.

### `Platform.ts:13` inverts the hold status for adapter authors
**Waiting on:** core. One-line doc fix.

It says a hold answers `503 segment_not_ready`, while `streamProtocol.ts:42` says 503 is a broken generation and terminal, and `:54` maps 503 with 404 to `stream`. **Not merely inconsistent — inverted.** An author following the public seam makes both mistakes at once and in opposite directions: retrying the terminal status, and condemning the node on the benign one. Both shipped adapters are already right (`PlayerEngine.kt:450` retries 500), so this is a trap for the next author rather than a live defect. Fix the comment, not the docs: `docs/writing-a-player.md` is already correct and is what people actually read.

### Session manager state gaps, and the roles work landing on them
**Waiting on:** core. `src/api/SessionManager.ts`. **Take these four together — they are all the mint and re-mint paths, and fixing them twice would be worse than once.**

1. `:165-168` — `authorization()` hands out the dead token during a reactive re-mint, because `mint()` never clears the rejected token. The doc at `:31-34` claims the opposite.
2. `:123-130`, `:241-243` — `start()` during an in-flight bootstrap adopts the *old* registry's result and never contacts the new one; `mintNow` then reports the corrected config as unreachable. The doc "safe to call again if the registry changes" is false in that window.
3. `SessionAuth.ts:55-57`, `SessionManager.ts:270-277` — mint refusals (403/404/429/malformed) charged as endpoint failures and reported as "unreachable", real error discarded. Contradicts *a node refusal is a loud, recoverable error*. **Partly addressed in 0.8.1** for the credential path, which now proves a refused password does not mark the node unhealthy; the anonymous path still does.
4. `:226`, `:276`, `:296` — refresh timers overwritten without clearing; `stop()` clears only the last.

**And the one the accounts work adds:** a 401 no longer means only "expired". A password or role change bumps `credential_generation` and invalidates every earlier session cluster-wide, deliberately, so a mid-session 401 is now normal. `SessionManager` answers a 401 by re-minting, and a re-mint with no credentials is an *anonymous* mint — so an administrator whose roles change is **silently downgraded to anonymous**: sections vanish, writes fail, and nothing says they were signed out. It disguises an auth event as a UI bug. The session must remember whether it was authenticated: anonymous 401 keeps re-minting invisibly; an authenticated 401 must stop, surface that the session ended, and let the application choose. The cached-session path on reload needs the same distinction.

The phone client has covered the *display* half — it re-reads `currentSession` on every notification so the marker self-corrects — and deliberately did not invent a "you were signed out" event, because the cause is core's.

### The probe endpoint becomes role-gated
**Waiting on:** server. Same question as the connection gate above, from the other side.

`validateAnonymousSession` (`SessionAuth.ts:129`) and `EndpointHealthMonitor` both probe `/api/v1/catalogue/status`, which under the roles model needs `media_viewer`. A user without that role has **every cached token classified dead on reload**, and **every node left permanently ungraded by the health loop** — which silently takes latency sampling and the preemptive swap with it. The ask with the server is one authenticated endpoint needing no role (`whoami` suggested). If they agree, two call-site changes.

### Two clients disagree about what logout means, and core documents no answer
**Waiting on:** Tom. `src/api/UsersApi.ts:128-135` (`logout`), `src/api/SessionManager.ts:148-166` (`signOut`).

They are different operations and both are needed. `logout()` revokes server-side and the revocation propagates; `signOut()` drops the token locally, clears the cache and mints a fresh anonymous session. Core's own comment says dropping the token locally is not a logout.

The phone client calls `logout()` then `signOut()`, and reports a failed revoke rather than swallowing it. The web client calls `logout()` and never `signOut()`, so it holds a revoked token until a later 401 forces a re-mint, and every request in between carries a token the server has already revoked.

One of them is wrong and core is why: it ships two operations whose correct composition is written down nowhere. **Do not merge the behaviours or pick by preference** — compare the cases and state the answer on the API, the only place both clients read. The phone client's reading matches core's own comment, which is the stronger position.

### Playback must be stopped before sign-in and sign-out, and nothing says so
**Waiting on:** core. Doc change at minimum.

Changing identity does not close playback sessions — nothing connects them — and **after the token changes, a session created under the old identity can no longer be closed.** The node then holds it against `max_video_transcodes` until `session_idle`, 30 minutes, on nodes with one slot. The ordering is an obligation on every caller, the fix is cheap, and the failure is invisible from the client that causes it. That combination should not be left for four clients to rediscover. Belongs on the `signIn` and `signOut` doc comments; same slot arithmetic as *Teardown has a ceiling* below.

### Smaller correctness items
**Waiting on:** core.

- **README seeding snippet defeats discovered-endpoint persistence.** `README.md:89-92` seeds discovered endpoints through `bootstrapEndpoints([...])`, labelling them `bootstrap`, so `applyAdvertisement` never marks them `discovered`, `persistConfirmedEndpoints` persists `[]`, and discovered history is wiped on every second start. Fix: `bootstrapEndpoints(discovered, 'discovered')`, plus a seed-then-persist round-trip test.
- **An emptied bootstrap set is persisted and treated as configured.** `runtime/configuration.ts:78`, `:88-93`, `:102-106`. `setBootstrapEndpoints([])` writes `{urls: []}`; `[]` is truthy, so `environmentEndpoints` is never consulted again and the client is permanently unconfigured after a "clear". `setDiscoveredEndpoints` already removes the key when empty — the two setters disagree.
- **`TorrentJob.catalogue` is declared required but version-gated.** `api/AcquisitionApi.ts:72`, "since 0.28.1", and the package supports mixed-version endpoint sets with no runtime check. Make it optional; absent stays absent.
- **Success bodies are assumed to be the envelope.** `MachaCatalogueApi.ts:61-62,127-128,191-203`, `MachaAcquisitionApi.ts:41-52,99-109`, `MachaManageApi.ts:32-33`. A 200 with HTML throws a raw `SyntaxError` the router treats as non-retryable, so "Unexpected token <" reaches the viewer with no failover; a JSON 200 missing `items`/`jobs` throws `TypeError` at `.map`, which the router treats as a *transport* failure and cools down the node for a schema mismatch. Fix: validate shape and throw a typed `invalid_response`, as `mediaProfile` already does at `:88`.
- **`ClusterPlaybackFactsApi` records per-title faults as endpoint evidence.** `:63-67` lacks the `!isPerTitleFailure(error)` guard `ClusterPlaybackResolver.create:268` has, so one unreadable extent demotes the node for every title.

---

## P1 — design and contract

### Speaker layout is not a concept core has
**Waiting on:** Android TV client (measurement), then core.

`choosePlaybackInstruction` decides audio purely on codec and never reads `channels`. `PlaybackCapabilities` has a field for what a device can *decode* and none for what its output can *render*. So a 5.1 track on a device that lists `eac3` is copied through untouched, and whether it is folded down to two speakers is entirely the device's business.

There is a live report of exactly that — 5.1 playing into stereo with no downmix — and it is unresolved. The Android TV client is the best evidence available: it builds capabilities from `MediaCodecList`, so it correctly reports `ac3`/`eac3`/`ac4`, and it will show whether Media3 folds down cleanly. Either answer is useful. If it does not, this is core's gap rather than a device setting.

If it becomes real work, the shape is roughly: a render-capability field on `PlaybackCapabilities`, and a channel target on the instruction — which needs the server to accept one, so it is a wire question too.

### Four state stores are not safe for a reactive caller
**Waiting on:** Tom.

`PlaylistStore` exposes `getSnapshot()` with a stable reference, as `useSyncExternalStore` requires. `playbackQueue`, `continueWatching`, `musicPlaylist` and `volume` return a fresh array or object on every call. Fine for imperative callers, wrong for reactive ones, and **all four clients are reactive**.

The failure is not theoretical and is not merely untidy: a hook that subscribes to a revision counter and then calls `list()` memoises on the store, whose identity never changes, so the list freezes at whatever it first computed. Code that looks correct, producing a list that silently stops updating. The web client's playlist controller works today only because exactly one component owns it — a second consumer would diverge with nothing to point at.

One store doing this right and four not is worse than none doing it, because a caller cannot tell which is which.

### Three gaps in the `Platform`/`Player` contract
**Waiting on:** core, with design against the web client. **Now has a consumer waiting rather than being speculative.**

Found by the React Native clients pushing on the contract from outside. All three are defects in what core ships, not in their discipline:

1. **`Platform.createPlayer(): Player` assumes one player per platform.** React Native switches engines per queue item — expo-video for video, react-native-track-player for `kind === 'track'`, which is what gives background audio and lock-screen controls. A mixed queue of episodes and music cannot be expressed as one player created once. Preferred fix: let the coordinator tolerate the player instance changing between source generations, rather than passing a kind to `createPlayer` — the latter moves the assumption into an argument. **The Android TV client's Tier 3 needs exactly this**: a second `VideoPlayer` rendering into an off-screen view, then swapping which instance the view holds. Confirmed achievable on expo-video — `VideoView`'s player setter checks `hasSentFirstFrameForCurrentMediaItem` on the incoming player and holds the shutter open for a pre-warmed one, and `preflightSource` via fetch needs no player cooperation at all. **"React Native cannot do seamless failover" is false and should not be repeated.**
2. **`attach(host)` / `detachHost()` is imperative surface ownership.** A React Native video surface is a declarative `<VideoView player={...}>` owned by the render tree. The DOM *type* is gone; the shape is still wrong.
3. **No channel for OS transport commands.** Lock-screen play/pause/next/seek are queue-level commands and `Player.subscribe` carries player-to-client events only. This is a hole rather than a mismatch, and it would have stayed missing indefinitely because the web client never needed it.

---

## P2

### Probe a standby before promoting it
**Waiting on:** core.

Specified, not built. `GET /api/v1/playback/sessions/{id}` returns `engine_running` and `segments_ready` **only when an engine is present**, so their absence is the "reclaimed, needs a cold start" signal — one cheap round trip, and the same GET renews the 30-minute session timer without touching the 60 s pipeline clock.

Promotion should expect a cold start rather than counting the promotion as failed. Deferred because the standby path was changing rapidly and one thing at a time was worth more than speed.

### `find` cannot distinguish absence from partial failure
**Waiting on:** core.

`ClusterEndpointRouter.find` returns `undefined` both when every node says "not available" and when some said that while another failed with a 5xx. Deliberate — it stops optional metadata blocking playback on an unrelated node failure — but for playback facts the two are different answers, because absent means *transcode everything*, silently.

Shape: report whether the walk ended on unanimous absence or on absence-plus-failure, without changing the return for callers that do not care.

### The accounts layer shipped under-tested
**Waiting on:** core.

`UsersApi`, `MachaUsersApi` and `ClusterUsersApi` shipped in `0.8.0` with no test file at all and no review. `0.8.1` added the first coverage on the credential path and `MachaUsersApi.test.ts` followed. **`ClusterUsersApi` still has none** — it is the routing wrapper, so the untested part is exactly the failover-and-record-evidence behaviour that the rest of the cluster wrappers have been bitten by (see the per-title-fault item above, which is that same bug in a sibling).

### Coverage, and where the remainder is
**Waiting on:** Tom, on whether to spend it.

Was 93.4% statements and 84.4% branches at 600 tests; now 615 tests, not re-measured. The gap is concentrated in `PlaybackCoordinator` and `PlaybackRuntime`, whose uncovered branches are the failure paths that only fire in specific combinations — failover racing a seek, a promotion during a pending mutation. Each needs a scenario built rather than an assertion added, which is why it is the slow part and also why it is the part worth having.

**The specific gaps the review named**, each tied to an item above: `canSeek: false`; watchdog resume after suspend and after a backward seek; degrade during failover; discovery failure demoting the sticky endpoint; persist throwing; restart mid-bootstrap; reactive re-mint; refusal versus unreachable; a 401 on the pre-save check; malformed success bodies; an empty bootstrap list; malformed continue-watching entries. `ClientLog` has one test.

---

## P3

### Music library state should move into core
**Waiting on:** Tom to sequence.

Favourites, play counts with a commit threshold, recently-played with a cap. It exists once, in the phone client, and nothing platform-specific is in it. **One implementation is the cheapest moment to move something** — two is a negotiation about constants nobody wants, and the failure is silent: the same library ranking differently in two clients is not something anyone reports.

### Offline and cache policy needs a seam, not a move
**Waiting on:** Tom, then design.

Four decisions are common to the phone's downloads and the web's read-ahead worker: content-addressed identity as the key, always the original bytes, a bounded frontier, and a failed speculative read treated as non-terminal. The transfer mechanism can never be shared.

One correction already established: "a failed speculative read is not a playback failure" is **already** core's `subscribeDegradation`/`subscribeFailure` split, which gained `not-ready` for exactly that case. It should feed that seam rather than build a parallel one.

The real work is deciding, per constant, whether it is a rule (shared) or a tuning (per host). Getting that wrong is how a shared module grows a `platform === 'ios'` branch.

### Teardown has a ceiling no client can close
**Waiting on:** server (raised, undecided).

`PlaybackRuntime.terminateForPageExit()` rides on `keepalive`, which is browser-only. React Native ignores it and Tizen 3 does not have the property. But the missing property is incidental: **the real cause is process death** — a host that is force-quit, crashes or loses power sends nothing by any mechanism, and no client-side change can fix that.

The cost is not local: a node holds a session's transcode entitlement for `session_idle` — 30 minutes — so on a one-slot node the next viewer gets `429 resource_limit` and nothing points at the client that caused it. There is no server-side mitigation today: no shorter idle for a session nothing was ever fetched from, and admission refuses rather than evicting. Both have been raised, and the second changes admission from a guarantee into a lease, so it is not a small ask.

Calling this promptly is the whole of the defence until one exists. Documented on the method and in the README.

### Shared TV navigation has no home
**Waiting on:** Tom.

Two TV clients hold hand-synchronised copies of a spatial D-pad focus scorer whose weights must agree for them to behave the same. Declined for core on the boundary: this package is everything a client does that is **not** presentation, and geometry deciding what a viewer looks at next is presentation. A boundary that bends for a good-enough case stops being able to answer the question at all.

That does not make the duplication fine. The honest options are a second shared package (`@macha/tv`) or accepting it with tests pinning the weights on both sides so a drift is at least loud. Both TV clients currently pin their own.

---

## Low — the register

Verified, each real, none urgent. Grouped by area so a session cleaning one area can take the set.

**Coordinator and playback**
- `PlaybackCoordinator.ts:1153-1189` — `degrade()` does not check `failoverPromise`, so a degradation during failover POSTs a redundant standby on a third node. Churn, not a leak.
- `PlaybackCoordinator.ts:698-718` — `close()` does not await `failoverPromise`, so `closePromise` can resolve while a failover POST is in flight, against the runtime's stated invariant.
- `PlaybackCoordinator.ts:1327` — the transcode standby window is keyed on `alternate.mode === 'transcode'`; if the entitlement is video-only, `transform.video === 'transcode'` is the precise test. The 8 s comment records the slot cost but not the quantity it must exceed.
- `PlaybackCoordinator.ts:1313-1318` — no disposed/revision re-check after the awaited preflight.
- `PlaybackStatus.ts:12` — header says "only ever from `output.container`" while the code falls back to `output.format`.
- `MachaPlaybackResolver.ts:243-253` — `reconcileQualityCaps` skips `mode: 'remux'` and runs on `resolve()` but not `update()`, against its own doc.
- `MediaTechnicalProfile.ts:21-23` — dead ternary with identical branches; `MachaPlaybackFactsApi.ts:45` passes `dolby_vision_profile: 0` through where the other normaliser treats 0 as "not probed".

**Cluster and routing**
- `EndpointRegistry.ts:397-407` — sticky is checked before the both-cooling order, so a sticky node on a 30 s cooldown is walked before a non-sticky one on 0.5 s.
- `EndpointRegistry.ts:495-505` — capacity never expires; `observedAt` is written and never read.
- `EndpointHealthMonitor.ts:136` + `EndpointRegistry.ts:495` — capacity keyed by `api_endpoint` string, so a typed IP versus an advertised hostname yields the same node twice and the in-use bootstrap entry never gets capacity.
- `EndpointRegistry.ts:713-715` — `notify()` does not isolate listeners; a throwing host listener turns a succeeded `route()` into a rejection and can kill the monitor loop. `publishConnectionState` already guards.
- `EndpointHealthMonitor.ts:106-148` — no abort check after `stop()`; an in-flight discovery still applies advertisement and fires listeners.
- `EndpointBandwidth.ts:17-20,124-126` vs `EndpointRegistry.ts:101,563` — restore re-enters at one sample and the threshold is two, so persisted throughput never ranks. `EndpointRegistry.test.ts:266-269` pins the current behaviour.
- `EndpointHealthMonitor.ts:69,164,235` vs `serverConnection.ts:41-44` — a proxy's bodiless 502/503/504 counts as reachable and clears the outage state forever.
- `EndpointRegistry.ts:85` vs `EndpointHealthMonitor.ts:10` — the cooldown ladder (500 ms, 2 s) is uncalibrated against the 10 s probe interval; a probe-failed sticky node is "ready" 0.5 s later. Neither constant records the relation.

**API layer**
- `ClusterCatalogueApi.ts:27` — `ARTWORK_ENDPOINT_TIMEOUT_MS = 8_000` exactly equals the inner `DEFAULT_REQUEST_TIMEOUT_MS`, so which error the caller sees depends on timer ordering. Harmless today; exactly the pattern HISTORY says to record.
- `ClusterCatalogueApi.ts:51-63` — a not-ready catalogue synthesises a 503 that cools down a node that answered.
- `AcquisitionApi.ts:91-104`, `ManageApi.ts:114-128` — no `AbortSignal` on these families, so a polling screen that unmounts still walks every candidate. `MachaAcquisitionApi.request:107-108` also lacks the 204 handling Manage has.
- `connectionConfiguration.ts:78`, `MachaManageApi.ts:32,71` — `cache: 'no-store'` relied on alone, against `platform-neutral.d.ts:108-125`.
- `SessionManager.ts:140-155` — `fetch()`'s JSDoc is attached to `authorization()`.

**State, runtime and docs**
- `state/continueWatching.ts:118-126` — the one store that validates only `Array.isArray`; a `[null]` entry throws on every `list()` until history is cleared.
- `state/musicPlaylist.ts:26` — `MusicPlaylistStore` still exported after being superseded, against the hard-cuts rule.
- `runtime/configuration.ts:140-144` — the self-healing `setItem` sits inside the read's `try`, so a write that throws removes the bootstrap key on a read.
- `runtime/configuration.ts:187` and `api/httpCompat.ts:96` — `normalizeUrl` and `normalizeBaseUrl` are the same four lines under two names, so `normalizeUrls` and `normalizeConnectionEndpoints` return identical arrays. **Duplication to delete before it drifts, not a correctness bug** — verified across nine input shapes. Note the phone client's scan path ends in `new URL(...).origin`, which collapses case and path and is stricter than both; if a pairing payload format ever lands in core, *that* is the difference to reconcile.
- `docs/examples/headless.mjs:64-68` passes `serverApi` to `EndpointHealthMonitor`, which has no such option.
- `README.md:100-103` — "EndpointHealthMonitor feeds routing its evidence" omits that throughput, which outranks latency, is fed only by a host-built `EndpointBandwidth` that nothing in this package calls `record()` on.

**Simplification, where the payoff is real**
- `request`/`throwResponseError` is triplicated across Catalogue, Acquisition and Manage (plus PlaybackFacts) with three shape-identical error classes, and has already drifted on 202/204 handling. One `jsonRequest` in `httpCompat` would collapse ~60 lines and make the malformed-body fix a single change. `objectValue`/`asRecord` is re-implemented three times.
- `route()`/`find()` duplicate the walk skeleton; every `Cluster*Api` repeats the `instanceof ClusterEndpointRouter` constructor; `evaluatePreferredSwap` calls `candidates()` (a re-sort plus an axis side effect) where `snapshot()` would do.
- With the resolver releasing on failover, the coordinator's deferred superseded cleanup is redundant for failover; stopping immediately would delete ~30 lines and close the gap where `close()` never stops `supersededCleanup.oldSessionId`.

---

## Watching, not doing

- **`cpu_cores` and capacity ranking.** Live since server 0.36.7 and the axis switched itself on. Nothing to do unless a node reports stale telemetry — `telemetry_freshness` and `live_age_ms` exist and core does not weigh them. Open question rather than known defect.
- **The platform probe has never run on a device.** `checkPlatformSurface()` ships having produced no runtime truth; its tests run on Node, which supplies everything. `0.8.0` added the three Hermes probes (`Intl.Collator` options, `normalize`, `\p{M}`) so the Android TV hardware run answers both questions at once. Its first real output is due with that 5.1 measurement.
- **No pairing or QR concept exists in core.** The phone client is building a scanner and its payload parse stays local until Tom decides the format. If a format is going to be shared it belongs here, because otherwise four clients invent their own and drift on normalisation edges — but it is a decision, not a defect.
- **Two clients still hold a duration formatter.** `formatPlaybackTime` is in core and the web client has dropped its copy. The phone and Android TV clients can drop theirs whenever convenient; nothing breaks until they do, and nothing improves either.
- **One transient test failure seen on 2026-09-13**, not reproduced in three subsequent runs and coinciding with another session writing to the tree. If a `PlaybackCoordinator` timing test fails intermittently, that suite has several 300 ms+ waits and is the place to look. No evidence of a real flake yet.
