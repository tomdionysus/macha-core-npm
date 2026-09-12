# Completed

Finished work, newest first, with the version it shipped in. Items arrive here from [ACTIVE.md](ACTIVE.md).

This is a record of what was done and what it cost to find. [HISTORY.md](../HISTORY.md) is the same story arranged by decision rather than by date, and is the better read if you want to know *why* rather than *when*.

Anything reverted or retracted stays here, marked, because knowing what was tried and abandoned is the half that otherwise disappears.

---

## 0.8.0 — accounts, and the defects a review found

**The probe cache-buster no longer restarts every page load.** `cacheBustedProbeUrl` took its value from `machaHost().now()` — `performance.now()` on a browser, so near zero on every load — and the first probe of a load fires at a fixed point in startup. Measured on the running web client: two consecutive reloads gave 744 and 571. A few hundred integers wide, re-entered from the beginning each time, so a cache could answer a probe for a node that is gone and report a dead node healthy. Now the wall clock plus a counter, the counter because two endpoints in a cycle are probed in the same millisecond. The latency half stays monotonic; they are different clocks for different jobs.

**`MachaHost.now()` says what it costs to get wrong.** The declaration already said "for measuring durations only" and that did not stop two people in one day, so the consequence now sits beside it with the three cases: the bandwidth freshness window that would silently stop existing, the signed capability expiry a from-arbitrary-origin clock cannot express, and the cache-buster above, which is the same confusion running the other way.

**`checkPlatformSurface` probes the three built-ins `titleIndex` is built on** — `Intl.Collator` with `sensitivity`/`numeric`, `String.prototype.normalize`, and `\p{M}`. Hermes has shipped `Intl` partially, and a partial `Intl` **degrades to a wrong sort order rather than throwing**, so nothing else would ever report it; on a TV the casualty is the alphabet-jump strip, which is the navigation affordance itself. Each probe asserts a specific answer rather than presence, because presence is what a partial implementation has.

**Promotion on degradation closes the primary it walked away from.** `promoteReadyAlternate` passed a fresh record to `beginSupersededCleanup`, which acts only on the record it already owns — so the call was a no-op and nothing on that path ever closed the promoted-from session. A node counts a session against `max_video_transcodes` until `session_idle`, 30 minutes, so every promotion on a one-slot node stranded the slot. The comment added the same day claiming *"every path here that abandons one calls `resolver.stop()`"* was false for this path when it was written. Found by review, reproduced before fixing: after two degradations and a promotion, `resolver.stop` had zero calls. The test that should have caught it asserted only the play call.

**A refused seek no longer pins intent.** On a stream with `canSeek: false` the guard sat *below* the intent mutation, so `positionRevision`, `seekIntentActive` and the intent/event patch all ran before the refusal. `onPlayerEvent` then ignored real positions until within 1.5 s of a target the player would never reach: `seekBy` built on the phantom, a failover asked the next node to start there, and the runtime recorded it as `startPositionMs`. `rollbackUnfulfilledSeek` never ran because no mutation was ever queued. The return value and the notice are unchanged, so no client needs to do anything.

**Failover closes the session it walks away from.** `ClusterPlaybackResolver.failover` recorded the endpoint failure, created a replacement, and abandoned the old session without a `DELETE`. A node counts a session against `max_video_transcodes` from admission until `session_idle` — 30 minutes — so failing away from a node that is alive but slow closed it to every other viewer's transcode for half an hour. Never awaited: a slow node is exactly where failover fires. Found by the phone client; the decision to abandon is made in the resolver, so closing belongs there.

**Failover asks for the carriage the failed generation was served with.** `withServedSegmentContainer` uses `output.container` — what the node *served* — rather than what the instruction asked for. A PATCH seeds from existing preferences and inherits the container; **creation does not**, defaulting to `fmp4`, and `failover` falls through to `create`. Placed in the resolver rather than the coordinator so it reaches every consumer, not the three that drive a coordinator.

**A transcode standby is held for 8 s, not 30 s.** Prices the window by what the standby costs the node: a transcode holds the only video slot, remux and direct hold a session record and nothing anyone is competing for.

**`SERVER_SEGMENT_HOLD_MS` and `playbackFailureKindForStatus` have one home.** The server's 6 s hold existed as a comment, a test literal and a client constant — three declarations of one server fact. `MEDIA_STALL_TIMEOUT_MS` is now expressed *against* it rather than as a number. The 500/503/404 mapping was specified in prose and implemented once per player, in JavaScript and in Kotlin, putting wire knowledge inside platform adapters.

**`checkPlatformSurface()` and `missingRequiredSurface()`**, from the Android TV client. Probes what a host actually provides at runtime, since the compile gate only proves what core reaches for. Never throws; names the member; `required` derived from one list rather than a boolean per probe.

**`formatPlaybackTime`.** All three clients had a copy and agreed on the entire visual contract; they differed only on non-finite input. The web client recommended against its own version — *"the rule is a good one, it just does not apply to a branch that has never rendered."*

**Documents.** `HISTORY.md` written; README cut to 133 lines and several false claims fixed, including a dev-dependency list, a bullet count, and "no browser globals".

---

## 0.7.0 — stall detection, and the DOM out of core

`MediaStartWatchdog` and `MediaStallWatchdog`, ported from the web client where they were written and measured. Deliberately **not** wired into `PlaybackCoordinator`: a derived stall would be a second source feeding `degrade()` on the one platform that already has a degradation channel, and promotion reloads the element where Direct Play's byte-level swap does not. The 17 ms seamless web failover therefore cannot change, by construction rather than by measurement.

`DOMException` removed from twelve call sites. It is a browser global, not an ECMAScript one, and `signal.reason ?? new DOMException(...)` meant the fallback almost never ran on the web and *always* ran on React Native — so the one platform that could not evaluate it was the one that always reached it.

`PlaybackRuntime.attach/detach` widened from `HTMLElement` to `PlaybackHost`.

Both of those compiled and passed the whole suite while being wrong, so the boundary became mechanical: `tsconfig.nodom.json` plus `types/platform-neutral.d.ts`, run as `lint:platform` and part of `build`.

The health probe busts its own URL, because `cache: 'no-store'` sends a directive on a browser, rewrites the URL on React Native and **does not exist at all** on Tizen 3 — where a cached `catalogue/status` would let a dead node report healthy.

## 0.6.4 — the manual bearer token removed

`apiToken`/`setApiToken` and `checkEndpointConfiguration`'s `bearerToken` argument gone; the pre-save ping is deliberately unauthenticated. `fixedBearerToken` kept — it is `NO_AUTH`'s definition and the test double across ten suites — with its documentation corrected so nobody reintroduces a configuring caller.

**Reverted before shipping:** a storage sweep for the abandoned `macha-api-token` key. The rule was right and the situation was not — Macha has not shipped, so no viewer has ever typed one. It would have put a permanent migration in two repositories to clean up data that was never created.

## 0.6.3 — failover restates the segment container

Tom's. `container` is not among a session's confirmed preferences, so rebuilding from those dropped it and every replacement node handed a Samsung set fMP4 where it had asked for MPEG-TS. Each silent starvation was charged to a healthy node until the candidate list emptied, surfacing as "no untried endpoint remains" with three working nodes.

## 0.6.2 — `memory_total_bytes`

Display only, and the comment says so: ranking on total memory would prefer a large thrashing machine to a small healthy one, which is the axis voting for the wrong node. Available memory was considered and declined — on Linux it is mostly page cache and swings without meaning, on a cluster whose entire workload is serving large files.

## 0.6.1 — promote a ready standby

`degrade()` returned early whenever an alternate existed, so every failure after the first was discarded without even being logged, and the only consumer of the standby ran on terminal failure — roughly sixty seconds away behind a player's retry budget. Measured: ready at 267 ms, discarded unused at 30 s, rebuilt from scratch at 63 s.

**Retracted afterwards:** the theory that a standby aged past the node's reclaim interval and promoted onto a dead session. The reporter's own measurement killed it — promoted in 3 ms, so it cannot have aged into anything — and the two server clocks are independent: `pipeline_idle` reclaims the engine, `session_idle` erases the session. An aged standby is a live session with a cold engine. That standby was dead and the cause is still unknown.

## 0.6.0 — `api_endpoint`, capacity-aware routing, cancellable reads

Endpoint ranking stopped falling through to the order endpoints were typed into a config file. `api_endpoint` replaced `api_host`/`api_port`, deleting the scheme-inference machinery rather than improving it. `AbortSignal` on reads cancels the *walk*, not just the attempt in flight. `not-ready` added for a fragment a node has not produced yet. `artworkUrls` returns sources that say whether they need a header, rather than strings that do not.

## 0.5.0 and earlier

Carriage: preferring a segment container, reading back what was served, telling a manifest from a direct hand-off, and source failure reasons. `0.3.0` moved the playback decision from the server into the client, which is the idea most of this package is arranged around. See [HISTORY.md](../HISTORY.md).
