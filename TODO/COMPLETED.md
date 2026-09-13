# Completed

Finished work, newest first, with the version it shipped in. Items arrive here from [ACTIVE.md](ACTIVE.md).

This is a record of what was done and what it cost to find. [HISTORY.md](../HISTORY.md) is the same story arranged by decision rather than by date, and is the better read if you want to know *why* rather than *when*.

Anything reverted or retracted stays here, marked, because knowing what was tried and abandoned is the half that otherwise disappears. That includes findings investigated and dismissed — a defect someone has already disproved is worth exactly as much as one someone has fixed, and costs the same to rediscover.

---

## Checked and dismissed — from the 2026-09-12 review

Four findings that did not survive contact with the evidence. Recorded because each looked right, and the reasoning that killed them is the part worth keeping.

**A capability expiry unit mismatch — not a defect.** `expiredCapability` parses `exp` from a signed artwork URL and compares it against `Date.now()`. If the server signed `exp` in *seconds*, as JWT does, every real capability would read as already expired: the re-hosting would never fire, `artworkUrls` would return exactly what it returned before, and the feature would be green in tests and absent in production. The tests could not catch it, because both construct their own URLs in milliseconds.

It is milliseconds. Settled from the server source — `unix_ms()` is a `duration_cast<milliseconds>`, the TTL field is declared `std::chrono::milliseconds`, and verification compares the two with no conversion on either side — and then on the wire, by running core's own parse over 41 live capability URLs: all thirteen digits, all live, all within the 24-hour default TTL. **The gap was real even though the answer was not:** nothing pinned the unit, and a test now does. A digit-count normalisation was deliberately *not* added, because a format that changes units should break loudly rather than be absorbed.

**"Three components should use the host clock" — wrong, and acting on it would have caused a silent bug.** The original finding read as a consistency tidy-up. Two of the three must never move. `MachaHost.now()` is a *duration* clock — `performance.now()`, arbitrary origin, restarting near zero every run — so `EndpointBandwidth`, which persists `updatedAt` and compares it after a restart against a six-hour window, would have had its cutoff go negative and every stored record read as fresh forever. `expiredCapability` compares against an instant another machine signed, which that clock cannot express at all. Both were correct as written. The rule now lives beside the `now()` declaration with its three cases; see `0.8.0`.

**"Two endpoint normalisers disagree" — wrong, they are identical.** `normalizeUrl` and `normalizeBaseUrl` are the same four lines under two names, verified across trailing slash, doubled slash, whitespace, `/`, empty, a path, mixed case and a trailing-slash query, with zero disagreements. The real finding is duplication that could drift, which is a much weaker claim needing a different fix. Both this and the clock item came from inferring a difference from two names instead of reading both bodies, and both were caught by client sessions rather than here.

**The standby carriage gap is latent, not live.** `prepareAlternate` does not restate the served container, which looked like the same silent-starvation bug one door over. But `prepareAlternate` has exactly one caller — the coordinator — and the client that would have been bitten does not use the coordinator at all. Downgraded to a trap to close before something starts preparing alternates without one. The unreleased change's claim that the fix "reaches every consumer" was right about `failover` and overstated about the standby path.

---

## Unreleased

**Two ways a failover still trusted what it had given up on.** Both found by auditing the batch above against the thing this package is for, rather than by a failing test.

*The exclusion relaxation only worked in a two-node cluster.* It relaxed when the candidate list was **empty**, which is a different question from whether anything usable is left: with three nodes, one cooling down from failed health probes keeps the list non-empty, so the recovery walked to the endpoint already known to be unwell, failed, and gave up while a node that recovered an hour ago sat excluded and idle. It now relaxes when nothing outside the exclusion is **ready**. That needed `EndpointCandidate.ready`, because `retryAt` is a reading of the registry's own clock and no caller can compare against it — `MachaHost.now()` is a duration clock with an arbitrary origin. Talked myself out of adding that field the first time; it was the whole fix. Nothing waits for a cooldown: an attempt that fails costs one request, and waiting on a timer is not a trade this package makes.

*A source being replaced could still move the resume point.* Dropping its errors fixed the fatal screen and left the assumption in place — the element goes on emitting, and one reporting zero as it tears down became the position the replacement was activated at. Now forward-only while a failover is in flight: real progress through the buffered tail moves the resume point, nothing a dying source says moves it back, and a viewer seek is exempt. It is **not** stopped or unsubscribed, which was the other candidate fix and the wrong one — its buffered tail is what covers the gap, including on clients whose hardware cannot do seamless failover at all. The test reads `+0` against the old code, so the hazard was real rather than theoretical.

**The exclusion set stops retiring nodes for the rest of the film.** `failedGenerationEndpoints` only ever grew — cleared by `resolve()` and nothing else — so on a long item it eventually named every node. Two nodes and a two-hour film: A blips at minute ten, B at minute ninety, the candidate list is empty, and the viewer gets a bare `No untried Macha playback endpoint remains`, terminal, while A has been probed healthy for eighty minutes. When the set would leave nothing, `failover` now collapses it to the one endpoint that must never be chosen — the one being failed away from this second. Everything else has had a cooldown, and probably a successful probe, since it last misbehaved, and the registry's ordering already puts anything out of cooldown ahead of anything still in it. Standby preparation is deliberately not relaxed: its exclusion holds the endpoint in service, and relaxing it would prepare a rescue on the node the rescue exists to escape. A consequence worth having on its own: there is now always an endpoint left to try, so what reaches the viewer is a real node's real failure rather than a sentence about bookkeeping.

**One failure, one record — and one teardown policy.** `failover` recorded the endpoint failure once, then the fire-and-forget `stop()` hit the same dead node, threw, and recorded it again; because `stop()` deletes the map entry only on success the session survived, so the coordinator's superseded cleanup DELETEd it again, recorded a third time, and retried with backoff — another record per attempt. One observation walked a cooldown ladder meant for a node failing repeatedly.

`releaseFailedSession` now calls the node resolver directly, so nothing is charged for the close, and drops the map entry *before* the first attempt rather than after a success: the session is abandoned whether or not the node ever acknowledges it. It carries its own retry ladder — five attempts over about half a minute, bounded because nothing can cancel those timers, with the give-up logged rather than swallowed.

The coordinator's deferred cleanup is deleted, decided with Tom. The resolver is the only layer all four clients pass through — two call `failover` directly and never build a coordinator — and the deferral was protecting nothing, since the lease being held belongs to the node that just stopped serving. `promoteReadyAlternate` closes the primary it abandons directly, as the silent direct promotion already did. The integration test now asserts the surviving policy specifically: the DELETE lands as the session is abandoned, with no buffered evidence on the replacement asked for first.

**The standby path restates the carriage too, and a mismatched standby is refused.** `withServedSegmentContainer` ran only on `failover`'s fresh-create branch, so a replacement built after the fact asked for the right container and one prepared in advance did not — the same defect through whichever door nobody looked at. `prepareAlternate` now applies it, and `failover` no longer accepts a prepared alternate on endpoint id and `mediaId` alone: a standby whose mode differs, or which reports a different served container while both are transformed, is refused and a fresh generation is created instead. An unreported container is deliberately not a mismatch — a node that does not say what it served gives no grounds to throw away a rescue that is built and ready. Nothing is closed on that path: the coordinator already stops every alternate that is not the session it activates, and a second owner would be worse than the gap.

Latent rather than live when it was found — `prepareAlternate` has one caller and the client that would have been bitten does not use it — and closed on that basis: before something starts preparing alternates without a coordinator, not after.

**The no-facts fallback asks for the host's container.** `instructedPreferences` fell back to `{ ...preferences, mode: 'transcode' }` with no `container`, though `segmentContainer` needs neither the profile nor the node's operations to decide one. A Samsung host with `preferSegmentContainer: 'mpegts'` whose facts lookup failed therefore got transcode with no carriage stated, the node defaulted to fMP4, and failover's `withServedSegmentContainer` faithfully restated fMP4 into every replacement — the silent starvation 0.6.3 already paid for once. `segmentContainer` is now exported and called on that path, and the container is reported on the instruction as well as sent. Carriage is decided by the host and the device alone, which is exactly why a failed facts lookup has no business changing it.

**A retry is seeded from the instruction, not the server echo.** `PlaybackRuntime.retry()` rebuilt its preferences from `session.preferences`, which is wrong twice over. The echo carries no `container`, so the retry asked for no carriage — the same fault as above, one layer up. And its concrete `mode`, arriving as `initialPreferences.mode`, is indistinguishable from a mode the viewer picked: `chosenByViewer: true` was reported to the host for a decision the chooser made, the chooser was skipped on the retry, and the one-shot 400 downgrade in `resolveInstructed` was disabled along with it. A chooser-made decision now retries as `choose` — it should be made again, since a retry usually lands on a different node and the instruction is the thing in question — and only a mode the viewer actually picked is restated, with its carriage. Three tests, all red first.

**A second failure from a dying source no longer discards the recovery.** `failNow` started a failover only when none was already running and otherwise fell through to `failTerminal`. But the old source is neither stopped nor unsubscribed while the replacement is negotiated, so it keeps emitting: a fatal error starts the failover POST, the element plays out its buffered tail and reports `ended` short of duration one to three seconds later, `onPlayerEvent` correctly reads that as a premature end, and the second failure — same source, same outage — went terminal. The coordinator then closed and the freshly created replacement was discarded by the disposed path, so the viewer got the fatal screen with a working node seconds away. An endpoint-retryable failure arriving while a failover is in flight is now logged and dropped, which is the posture `promoteReadyAlternate` already takes for a degradation in the same window.

The test sends two failure signals from one dead source, which nothing did before. Against the old code it fails in the exact shape described: the replacement is built and playing, and `fatalError` is set anyway.

**A generation admitted after the deadline is closed rather than stranded.** `awaitWithEndpointDeadline` rejects at 12 s and deliberately leaves the POST running — cancelling it would tell the node nothing about whether to keep the work — but the late success was then dropped on the floor: never recorded, never returned, never closed. The idempotency key is no help, because sessions are node-local and the retry lands elsewhere. So the slow node the deadline exists to route around was the one left holding a session, on a one-slot node its only transcode slot, until `session_idle` reclaimed it half an hour later. The deadline now hands the late value back to the caller, which closes it against the node that admitted it, using the node-local id — the only identifier that node has ever heard of. It is never recorded as endpoint evidence in either direction: the node did nothing wrong, and the attempt that timed out has already charged it.

**The ranking comparator is an order again.** Every measured axis compared pairs against a threshold inside `sort`, and threshold indifference is not transitive: at 20/65/110 ms against the 50 ms floor, A ties B and B ties C while A beats C. `sort` handed a cycle returns whatever its implementation returns, so the same three nodes with the same evidence produced a different head depending only on the order they were typed in — the WAN node winning, with `selectionAxis()` reporting that no measurement had decided it. Reproduced before the fix, and the test that reproduces it now sits in the suite.

The measured axes are now successive filters: each keeps whatever is within threshold of the best value *still in contention* and puts the rest behind it, re-running the same axis on those so the tail stays ordered rather than becoming a discard. The best is taken within the surviving pool, never globally, so a node in a failure cooldown with the fastest link cannot rank a healthy one behind it. The axes that were already a total order — availability, sticky, the cooldown deadline, the failure count — stay a plain sort key, which is what they always were. `selectionAxis()` is now read off the ranking that produced the list instead of recomputed from the top two afterwards, so it can no longer disagree with the order it describes.

Four tests, all with three endpoints, which is the reason this was invisible: a threshold compared pairwise is only an order when there is one pair, and every existing registry test used two. One of the four is the reproduction and was red before the fix; the other three pin the new behaviour — same head and same axis whichever order the three are configured in, an ordered tail, and the surviving-pool rule.

**Session minting has a deadline.** `mintAnonymousSession` and `validateAnonymousSession` called bare `fetch` with no signal, and they are the one path the whole application waits on: `SessionManager.fetch` holds every request on `inFlight` through bootstrap and through a 401 re-mint. Nothing above could impose the deadline either — a `fetchWithTimeout` wrapped around one of those callers composes a controller the mint never sees — so a node that died without an RST left a half-open socket that cost the OS timeout, per candidate, with the client frozen behind it. Both now go through `fetchWithTimeout` at `DEFAULT_REQUEST_TIMEOUT_MS`, which makes that constant's doc claim true for the first time; it now names this path, because a mint is not part of the layer the comment described.

Three tests, all confirmed red first — and red in the shape that matters: against the old source they do not fail, they hang until the harness kills them. A mint into a black hole now ends as a `MachaConnectionError` at the deadline, the any-node walk reaches the second node and charges the first with a failure, and the warm-reload validation gives up on the same deadline instead of becoming the slowest thing in a reload.

---

## 0.8.1 — the first tests on the accounts work

**`signIn` has coverage.** The three users modules shipped in 0.8.0 with no test file at all. This is the first of it, on the credential path: that credentials go out on the same route as an anonymous mint and the username the server names is kept, that a refused password does **not** mark the node unhealthy and does not walk to the next node, and that a node which cannot answer at all still walks.

The middle one is a review finding caught before it could bite: `mintAnonymousSessionAnyNode` charged every error to the endpoint, so a wrong password would have cooled down every node in the cluster in turn and then reported the cluster unreachable. A refusal is an answer, and answering is what a healthy node does.

Also: the review record narrowed the bootstrap-lockout finding to callers of `checkEndpointConfiguration` after the phone client showed its own probe already accepts a 401, and gained two items the accounts work exposed — the two clients now disagreeing about how `logout()` and `signOut()` compose, and the undocumented obligation to stop playback before changing identity.

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
