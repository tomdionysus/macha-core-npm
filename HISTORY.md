# History

Why this package looks the way it does. The README says what it is; this says how it got here, and which decisions were paid for rather than reasoned out.

Every release below is in `git log` with the full argument in its commit message. This file is the shape of the story, not a changelog.

## Where it came from

The core was extracted from the React web/TV client. The test of what belonged was not "is this reusable" but "would two clients otherwise write it twice and drift" — which is a different question, and the one that has held up. The parts that came across are the server API families, cluster routing and failover, playback resolution and coordination, and persisted client state. Presentation, navigation and media elements stayed behind.

Four clients now consume it: the web/TV app, a Samsung Tizen build of the same, a React Native phone app, and a React Native Android TV app.

## The decision the server does not make

`0.3.0` moved the playback decision from the server into the client, and it is the single idea most of the package is arranged around. **The server reports what the media is and performs what it is told.** There is no `auto`. So something on the client has to conclude "play this one as it is, repackage that one, re-encode the other" — and if each client concluded it separately they would diverge on the same library.

`choosePlaybackInstruction` makes that decision once, from three facts: what the file is, what the device can decode, and what the node being asked can actually perform. It returns the reasons with the verdict, because *"why is this transcoding?"* is a question an operator asks and the answer has to come from the code that decided rather than from reconstructing it afterwards.

`docs/choosing-playback.md` is the long form and is worth reading before touching playback.

## Carriage, and a television that reported nothing

Releases `0.3.1` through `0.5.0`, and again `0.6.3`, are almost entirely one problem seen from different angles: **which container a stream is packaged in, and whether anyone can tell.**

A Samsung set that asked for MPEG-TS and was handed fragmented MP4 fetches nothing and reports nothing — no error, no event, a frozen frame. So the client learned to read back what was actually served rather than trusting what it asked for (`output.container`, `servedContainer`, `containerHonoured`), to distinguish a manifest from a direct hand-off regardless of container, and finally to carry the served carriage into every replacement generation.

That last one hid for a long time because `container` is not among a session's confirmed preferences: rebuilding from those silently dropped it, so every failover asked for whatever the node defaulted to. Each silent starvation was then charged to a healthy node until the candidate list emptied — surfacing as "no untried endpoint remains" with three working nodes.

## Routing on evidence

`0.6.0` replaced "the order endpoints were typed into a config file" with a ranking cascade: availability, sticky preference, failures, throughput, latency, capacity, configured order — and `selectionAxis()` says which one decided.

It exists because the client spent an afternoon routing every session to a deliberately flaky wireless node, and produced a whole afternoon of "the transcode is slow" measurements that were really "we picked the worst node". Throughput evidence only ever accrues for the endpoint already in use, so with no record for anyone the comparison abstained and the cascade fell through to configuration.

Two orderings in it are deliberate and counter-intuitive:

- **Latency outranks capacity.** The fault this prevents is a healthy, lightly loaded node behind a bad wireless hop, and no server-reported metric can see a path. Rank capacity first and the axis that is blind to the fault decides before the one that can see it.
- **Capacity abstains without a core count.** `load1: 2.67` is a struggling two-core box and an idle eight-core one, and this cluster is deliberately non-uniform hardware. A comparison between machines of unknown size is not a comparison.

**The cascade is evaluated as filters against the best, not as a comparator.** Each measured axis keeps everything within threshold of the best value still in contention and puts the rest behind it. The first shape — a pairwise threshold inside `sort` — was not an order at all, because threshold indifference is not transitive: at 20/65/110 ms against a 50 ms floor, A ties B and B ties C while A beats C. Handed that cycle, `sort` returns whatever its implementation returns, so the WAN node reached the head of a three-node cluster on nothing but the order the nodes were typed in, and `selectionAxis()` reported that no measurement had decided it — the exact fault the cascade exists to prevent, arriving through the comparator. Two endpoints hide it completely, which is where every test lived. Against a single reference the same threshold is a total preorder, and the deciding axis is read off the ranking rather than recomputed from the top two afterwards, so it cannot disagree with the list it describes.

## A dying source keeps its pixels and loses its vote

A source being failed away from is never stopped to quieten it. The tail it has already buffered is the thing covering the gap, and a client that cannot do seamless failover on its own hardware still gets those seconds for free — stopping the element to silence it produces exactly the black screen the mechanism exists to prevent (Law 2).

What it loses is standing as a witness. It goes on emitting while the replacement is negotiated, and two of those emissions are actively harmful: a second fatal error, which reads as a fresh outage and used to go terminal while a working replacement was seconds away, and a position of zero as the element tears down, which used to become the position the replacement was activated at — the viewer thrown back to the start of the film with nothing to point at.

So during a failover: an endpoint-retryable failure is logged and dropped, because recovery for that outage is already running, and a reported position may move the resume point forward but never back. Forward still counts — the tail it plays out is real progress and the replacement should start after what the viewer actually saw. A viewer seek is exempt, because that is a position someone chose rather than one a dying source reported.

The general form: **evidence from a component already given up on is not evidence.** It is the same rule the ranking cascade follows when it takes the best value only from endpoints still in contention, and the same one `failoverExclusion` follows when it asks whether anything outside the exclusion is *ready* rather than whether the list is non-empty.

## Who closes an abandoned session

Teardown after a failover belongs to `ClusterPlaybackResolver`, immediately, with its own retry ladder. The coordinator's deferred cleanup — hold the old lease until the replacement has buffered data, then DELETE with backoff — was deleted.

Two policies had grown up in parallel and the pair behaved worse than either alone: the resolver's fire-and-forget `stop()` charged the registry for a DELETE to a node that had just died, left the map entry in place because it only deleted on success, and the coordinator's cleanup then found that entry and charged again, with backoff, once per attempt. One observation became N failure records, walking a cooldown ladder built for a node failing repeatedly.

The resolver won on reach. Two of the four clients call `failover` directly and never build a coordinator, so teardown that lives in the coordinator is teardown half the consumers do not get — and the cost of not doing it is not local: a node counts a session against `max_video_transcodes` from admission until the record is erased at `session_idle`, thirty minutes later, so on a one-slot node the next viewer is refused and nothing points at the client that caused it. The deferral it replaced was also protecting nothing: the old session is on the node that just stopped serving, so there is no fallback to hold it for.

What it costs: the retry ladder is bounded at five attempts over roughly half a minute, because nothing can cancel those timers, and a node that comes back later than that keeps the lease until `session_idle`. That case is logged rather than hidden.

## Two failure postures

A recurring rule, stated once here because it decides a lot of small things: **a device contradiction is performed silently and a node refusal is a loud, recoverable error.** Given a choice between the two, take the error.

It is why a redundant field is preferred over an omitted one, why absent stays absent rather than defaulting (`output.container`, capacity figures, a stall with no buffer measurement), and why `500 segment_not_ready` — a fragment a node has not produced yet — is not treated as endpoint evidence at all.

## Numbers calibrated against other numbers

Five times this project has been bitten by two independently chosen constants that had to relate and did not:

| Client side | Server or platform side | What went wrong |
| --- | --- | --- |
| Standby window, 30 s | hls.js retry ladder, ~31 s | The rescue always expired before anything asked for it. |
| Segment hold, 12 s | hls.js `maxTimeToFirstByteMs`, 10 s | Client aborted before the hold answered. |
| Segment hold, 8 s | media3 `DEFAULT_READ_TIMEOUT_MILLIS`, 8 s | Exact tie. |
| Stall budget, 5 s | Segment hold, 6 s | Only visible at the production frontier, but real. |
| Standby window, 30 s | `pipeline_idle_ms`, 60 s | A standby that outlived the node's reclaim would be promoted onto a cold engine. |

Each pair was individually defensible. The lesson is not "choose better numbers" — it is that a constant must record *what it is calibrated against*, not only its own value. `ALTERNATE_RECOVERY_WINDOW_MS` and `MEDIA_STALL_TIMEOUT_MS` both do.

## Getting the DOM out

`0.7.0`. The package had claimed "no browser globals" since the beginning, and it was checked by grepping for `window`, `document`, `localStorage` and `navigator`.

That check found nothing while `HTMLElement` sat in an exported signature on `PlaybackRuntime.attach` — a type React Native does not have — and `DOMException` sat in twelve call sites. The second was worse than a wrong type: `signal.reason ?? new DOMException(...)` meant the fallback almost never ran on the web and *always* ran on React Native, so cancelling a request there raised `ReferenceError` instead of an `AbortError`. Both compiled, and both passed the full test suite.

Four noun-shaped names were never going to catch a type or an exception constructor. So the boundary is now mechanical: `tsconfig.nodom.json` compiles the package against `ES2022` and `types/platform-neutral.d.ts` alone, run as `npm run lint:platform` and part of `build`.

That declaration file is the more interesting artefact. It states what the package may assume, with members written as the package uses them, so quietly widening the requirement fails rather than passes. It records measured behaviour rather than guesses — three hosts were probed on real hardware:

- `cache: 'no-store'` sends a directive on a browser, **rewrites the URL** on React Native, and **does not exist at all** on Tizen 3. The health probe now busts its own URL, because a unique URL is the only mechanism every host honours — and the only one that also defeats an intermediary cache, which no request directive can.
- `keepalive` is browser-only, so page-exit teardown is best-effort and platform-dependent.
- `AbortController` is absent entirely on Chromium 47 and supplied there by the web client's own shim. The honest framing of the whole file is that it states what the package *requires*, and a host lacking something must bring it.

## What the group taught the package

Four client sessions and a server session work on this project alongside this one, and most of the significant defects in this package were found from outside it. Three habits came out of that and are worth keeping:

**Surface a divergence rather than merge one.** When two copies of a rule disagree, write out the cases where they differ and reason about each. `isGatewayConnectionFailure` is the worked example: one version had `503` (which HAProxy answers for a dead backend) and the other had unconditional `502`/`504` and the non-JSON `500`. Neither was right, merging would have shipped a bug, and only the comparison exposed the rule.

**A check that has never been seen fail is not evidence.** A guard on the seamless Direct Play swap was written, judged worthless and deleted — because the "prove it fails" step edited `src/testing/FakePlayer.ts` while that suite has its own local fake. The test was fine; the verification could not fail. The same shape appeared three more times the same day, in different costumes.

**Ask whether the data exists before migrating it.** "Removing a feature is not the same as removing its data" is a good rule, and it was applied to a credential no user had ever typed — nearly costing two repositories a permanent migration for nothing.

## Two clocks, and why saying "durations only" was not enough

`0.8.0` added a sixth entry to the table above in spirit if not in form, and it is a different shape from the other five: not two constants that had to relate, but two *clocks* that must never be confused.

`MachaHost.now()` is monotonic — `performance.now()` wherever the host has it — and its declaration had said "for measuring durations only" since it was written. That sentence did not stop two people in one day. A review finding proposed sweeping three components onto it for consistency, which would have silently disabled `EndpointBandwidth`'s six-hour freshness window: it persists a timestamp and compares it after a restart, and on a clock that restarts near zero every stored record reads as fresh forever. The same confusion was already live in the other direction — the health probe's cache-buster took its never-repeat value from that monotonic clock, so probe URLs restarted with every page load. Measured on the running web client: two consecutive reloads produced 744 and 571, out of a space a few hundred integers wide. A defeated cache-buster reports a dead node healthy.

Both halves of `probeEndpoint` were individually reasonable and the pair was wrong. The rule now sits beside the declaration rather than only in the type: **a duration goes through the host clock, an absolute instant stays on the wall clock, and nothing converts between them** — with the three real cases named, because the abstract version had already failed to carry.

## Release history

| Version | What it was about |
| --- | --- |
| `0.2.0` | Capability negotiation, the first docs, and a Tizen playback fix. |
| `0.3.0` | The client instructs and the package decides — the chooser moves here. |
| `0.3.1`–`0.4.3` | Segment carriage: preferring it, reading back what was served, and telling a manifest from a direct hand-off. |
| `0.5.0` | Carriage-aware operations, served container, source failure reasons. |
| `0.6.0` | `api_endpoint`, capacity-aware routing, cancellable reads, `not-ready`, `artworkUrls`. |
| `0.6.1` | Promote a ready standby instead of waiting for a fatal 60 s away. |
| `0.6.2` | `memory_total_bytes`, display-only and documented as such. |
| `0.6.3` | Failover asks for the carriage the generation was created with. |
| `0.6.4` | The manual bearer token removed from every interface. |
| `0.7.0` | Stall detection, and the DOM out of the package. |
| `0.8.0` | Accounts and roles, and the defects a full review found. |
| `0.8.1` | First tests on the credential path; a refusal stops counting as a node fault. |
| `0.9.0` | Liveness without a role, and a failover that stops trusting what it replaced. |
| `0.10.0` | One account model, no special anonymous — one `Session`, one mint, one storage policy. |
| `0.11.0` | Artwork stops renaming itself, and volume leaves core. |
| `0.11.1` | The storage registry admits to a key it owns; the cheap half of the coverage gap. |
| `0.12.0` | What a host's storage owes core, said where it is read rather than only where it is listed. |
| `0.13.0` | A 404 is about one session, not the node that answered it — and the replacement is built where the viewer will arrive. |
| `0.13.1` | Four faults a seamless host made visible: `play()` resolving is not `play()` being called. |
| `0.14.0` | Core reads the node's own deadlines instead of holding compiled-in guesses at them. |
| `0.15.0` | A failure keeps the evidence it arrived with — and a recovery that cannot finish stops waiting for ever. Tagged, never published. |
| `0.16.0` | Tolerance for two statuses no node sends yet. Tagged, never published — superseded within the hour. |
| `0.17.0` | The two statuses and the machine code a host is meant to act on. Tagged, never published; every client pinned it through a link, none from the registry. |
| `0.18.0` | A session closes on the strength of its id, the cap is counted per node, and a viewer choosing a node is not evidence about it. The first publish since `0.14.0`; everything above it ships here. |

## The pause that killed a healthy node

`0.13.0` is one bug seen from four sides, and it is the clearest example this
package has of a client, a core and a server each holding one third of an
answer.

A viewer pauses for half an hour. The node reaps the play session, correctly —
a paused client stops asking for fragments, and `session_idle` exists for
clients that have stopped asking. The viewer comes back, watches their buffer
play out, and gets a failure screen naming a node their session was never on.

**The first third was a status read as the wrong kind of evidence.** A `404`
on a playback route says one session no longer exists. Core read it as
`stream`, `stream` is endpoint evidence, and the only exit from endpoint
evidence was `failover` — whose first act is to record a failure against the
node. So the node that had answered honestly was charged for it, dropped from
the candidate list, and the viewer was sent somewhere else. `not-found` exists
to name what the node actually said, and `sessionAlive` exists because the
status alone cannot tell a reaped session from a fragment past the end of a
plan: both answer `404 not_found`, differing by one word of English in a body
most fragment loaders never surface.

**The second third was measured three times and wrong twice.** Replacing the
generation worked, and the viewer still lost their picture for five seconds,
because attaching a source hands the player a new `MediaSource` and empties an
element holding a minute of playable video. Building the replacement early and
holding it was *worse* — twelve seconds — and the reason offered for that was
also wrong: a held session does not go cold. The pipeline starts inside the
session `POST` and a node reported startup complete in 1,924 ms before
answering. What actually costs the time is the production frontier. A node
produces out to a look-ahead past the last fragment anyone asked for and
parks; a generation held for half a minute leaves the viewer arriving beyond
that, and the encoder walks to them at roughly realtime. So the replacement is
built late, at the position it will be used, and the viewer arrives at the
start of a window rather than past the end of one.

**The third was a number nobody outside the server could know.** The lead has
to stay inside the look-ahead, and the look-ahead was `max_ahead_segments`
times `segment_duration_ms` — two knobs that appeared on no wire and in no
document. A client could only assume the defaults. Server `0.45.0` added
`stream.look_ahead_ms`, derived server-side so that nobody multiplies a count
by a duration, and `null` rather than `0` for direct play so that "no
pipeline" cannot be read as "no look-ahead". Without it the lead was a
constant chosen to sit under a frontier nobody could read: correct on both
live nodes and wrong on any node configured with half the default window.

**What the release is really made of** is three sessions each refusing to take
the others' word. A client that checked its own pin and found it worthless —
it had been hashing the barrel, which is invariant under every implementation
change. A client that came back twice to withdraw its own explanation after
core had already built on it. A core that asserted an obligation and was asked
to prove it was code rather than intention, and found on checking that it was
not: a terminal failure still built immediately, which would have made the
client's half measure nothing at all.

`docs/principles-and-laws.md` arrives in this release for the first time. Six
places in `src/` cited it, one of them a test name, and it had never existed
here. Law 2 is why the shape is what it is.

## The parallel server model, and what it cost by construction

`0.14.0` is one idea: **core had been holding compiled-in guesses at server
configuration and computing against them.** The shared principles forbid it in
as many words — *the client must not infer cluster truth, invent a parallel
server model* — and it was not an abstraction violation, it was costing viewers
every time.

`GENERATION_ATTEMPT_BUDGET_MS` was 12,000 against nodes entitled to 15,000. So
core abandoned a working node three seconds inside its own entitlement, **by
construction, on every slow generation**. Measured: a first fragment ready at
11,672 ms, the generation `DELETE`d 1.4 s after it landed, and the identical 4K
HEVC software encode started again on another node while the viewer got a
failure screen instead of a wait. The cluster did the work twice and the viewer
got neither. A budget chosen independently of the number it was bounding, which
is the fault this repository keeps finding under different names.

Server `0.46.2` reports `startup_timeout_ms` and `segment_timeout_ms` per node
on the cluster status payload — which already arrives every ten seconds for
discovery and capacity, and which describes nodes core has never talked to.
That last part is what makes it usable: a failover target needs the figure
*before* first contact, and this costs no new request to get.

Three rules came out of it and they generalise past these two numbers. **The
node's figure is law for that node, including when it asks for less.**
**Absence never shortens a deadline** — a node too old to say gets the
published default, because a missing field must not be read as a small one.
And core adds exactly one term of its own, `ENDPOINT_TRANSPORT_ALLOWANCE_MS`,
the distance between the two machines, which is the one quantity no node can
report about itself; it is documented as a guess with its successor named.

The figures travel on `PlaybackSource.budgets`, so they reach `play()` and
`preflightSource()` without four adapters changing a signature, and they arrive
attached to the thing they describe rather than as ambient configuration.

**Two constants still hold private copies** — `ALTERNATE_RECOVERY_WINDOW_MS`
and `ALTERNATE_TRANSCODE_RECOVERY_WINDOW_MS`, both sized against
`pipeline_idle_ms`, which the server reports and core does not read. The
release ended the class for three budgets and not for five.

The same release implemented the seek contract that had been specified in
`macha/docs/streaming.md` throughout and never read: `seek_ms`,
`seek_offset_ms`, `seek_requested_ms`, with `seek_ms + seek_offset_ms ==
seek_requested_ms` exact. Core had been deriving its own origin and reporting
every position in a remux generation early — measured at 18.12 s out, with the
displayed playhead ahead of the picture, which is what a viewer reported as the
timeline jumping about on its own. **A specification is cheaper to read than
source, and was written so nobody had to infer the contract.**

## A gap in what npm holds

`0.8.1` was published to npm on 2026-09-12 and then three releases happened
without one. **`0.9.0`, `0.10.0` and `0.11.0` exist only as tags here and will
never exist on the registry**, so a client pinning `^0.9.0` cannot resolve it.
`0.11.1` is the next version npm sees, and it jumps straight from `0.8.1`.

Recorded because from outside a version gap and an unpublish look identical,
and one of those is a reason to distrust a package. Nothing was unpublished.
The four clients resolved by `file:` link throughout, so none of them was ever
reading the registry and none was affected.

**It happened again, and for a better reason.** `0.15.0`, `0.16.0` and `0.17.0`
were tagged across 2026-09-20 and 2026-09-21 as waypoints while the work was
proven through links to this tree, and none was published; `0.18.0` is the next
version npm sees after `0.14.0`. This time it was the rule working rather than
lapsing: a version is spent when there is something worth shipping, not on a
turn of a verify-fix-verify loop, and a tag costs nothing to leave behind.
`0.18.0` itself was cut once too early on 2026-09-21, reverted the same
afternoon before anything was published, and cut again that evening after the
gate. The tag has not moved since and cannot.

So a `git tag` here is not a release history. Twenty-one of the twenty-seven tags
have no artefact behind them. **Read the registry** — `npm view
@machafoundation/core versions` — before calling a version released, before
offering one to a client, and before treating a tag as movable.
