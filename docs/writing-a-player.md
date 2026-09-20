# Writing a player

`Player` is the one interface a host must implement to bring Macha to a new platform. Everything else the core needs — storage, a clock, an origin — is a few lines of binding. This is the part with real contracts in it.

The core never touches a media element, a decoder or a view. It decides *what* should be playing and *from where*, hands that to your player, and reasons about what comes back.

## Start from the fake

`@machafoundation/core/testing` ships `FakePlayer`, the fixture the core's own playback suites run against. It implements every method including the optional ones, so it is both a working skeleton and a control to test against.

```ts
import { createFakePlayer } from '@machafoundation/core/testing';

const player = createFakePlayer();
player.emit({ positionMs: 5_000, durationMs: 600_000, paused: false, ended: false });
player.fail(new Error('source lost'));       // terminal failure channel
player.degrade(new Error('bandwidth drop')); // early warning channel
```

It records what it was asked to do (`playCalls`, `seekCalls`, `stopCalls`, `attachCalls`, …) and lets you drive the event, failure and degradation channels by hand. Write a test for the coordinator behaviour you expect, watch it pass against the fake, then swap in your player to find which contract you got wrong.

The entry point depends on no test runner — plain classes, usable from Vitest, Jest, `node:test` or a scratch script.

## Contracts the type signature does not show

### `attach` is not `play`, and `detachHost` is not `detach`

`attach(host)` binds an existing player to a presentation surface: a DOM element, a native view handle, a component ref. The core never inspects what you pass; it carries it from your UI to your player. `attach` must not start a session.

`detachHost()` unbinds presentation while keeping playback and its resources alive, which is what makes picture-in-picture and a view remount survivable. `detach()` is final destruction. Conflating them means a remount silently kills playback.

### `play()` resolves when the source is presented, not when buffering completes

It reports that this source is the one now being presented — for a host that tears the old element down, the moment it is dispatched; for a host that prepares a replacement alongside, the moment it cuts. Until it resolves, the core goes on describing the source still playing. Never resolve on buffering completing: that stalls the failover timing that moves a viewer to a healthy node.

### `localSeekCoverage()` and `seek()` share one coordinate system

Both are source-generation-local: positions within the media the player currently holds, not positions in the title. Platforms disagree about timestamp origins and an HLS manifest may start at an arbitrary PTS, so normalise before exposing ranges. Get this wrong and seeks land in the wrong place, or the coordinator negotiates a new server session for a seek you could have served locally.

### Report failures with evidence

Throw or emit `PlaybackSourceError` with a `kind`:

| kind | Means | Consequence |
| --- | --- | --- |
| `stream` | The bytes stopped arriving | Retried on another node |
| `media` | The container or stream is broken | Not retried elsewhere |
| `unsupported` | This decoder cannot play this | Not retried elsewhere |
| `not-found` | This node no longer has the source | Recovered without tearing down |
| `not-ready` | The node has not produced this fragment yet | Not evidence; nothing is retried |
| `unknown` | No evidence | Retried on another node |

`isEndpointRetryablePlaybackFailure` treats a plain `Error` as retryable, for players that predate this. Safe but expensive: reporting a decoder failure as a stream failure sends the viewer around the whole cluster to fail identically on every node. If you know it was the decoder, say so.

A `not-found` adapter must **not** tear the presentation down. The buffer the element already holds is unaffected and still playable, and the core may have a replacement generation waiting — destroying the loader throws away exactly the cover the recovery was going to spend.

### `not-ready` is the one that is not a failure

A node answers a request for a fragment it has not produced yet with a `500` meaning "not made yet, ask again". That is the node working, and it is the one case where the right response is to retry the same request on the same node. Report it as `stream` and the coordinator prepares a standby elsewhere and may escalate to failover, which cannot help: the next node is producing a different generation and does not have that fragment either.

**Do not implement the status mapping yourself.** `playbackFailureKindForStatus(status)` is exported for it. Report the status your stack gave you and let the core say what it means; the split is protocol, not platform.

| status | code | means | kind |
| --- | --- | --- | --- |
| `500` | `segment_not_ready` | Not produced yet; ask again | `not-ready` |
| `503` | `stream_failed` | This generation is broken | `stream` |
| `404` | `not_found` | Past the end of the plan, or the node has reaped the session | `not-found` |

The JSON body carries the machine code for operators; it is not the discriminator.

**The hold is `500` and not `503` deliberately.** Every proxy, tunnel and load balancer emits `503` for a service that is genuinely down, so that status is not the server's alone to assign. Give the hold `503` and a dead node behind an intermediary reads as a healthy one still producing fragments — no failover, ever, and nothing surfaced. The two mistakes are not symmetric: misreading a hold as a loss costs one unnecessary failover, visible as a hitch and self-correcting; misreading a dead node as a hold costs failover entirely, silently and permanently, and is likeliest exactly where a proxy is involved.

Only the player can tell a hold from a real fragment failure, and what it has to tell them apart with depends on the stack. The core does not name the discriminator, because the obvious one is often unreachable: hls.js reports a bad status as `{ code, text }` and sets `response.data` to `undefined`, so an error envelope in the body never reaches the error event — it is available only through `data.networkDetails`, which is the raw `XMLHttpRequest` and becomes something else under `FetchLoader`. The HTTP status is the one field both loaders populate identically. Find what your stack exposes before designing around what the server sends.

### Hold windows and your stack's deadline

A held request sends no bytes. If a node holds for longer than your stack's time-to-first-byte deadline, you never receive the status at all: the client aborts first and takes its timeout path, which looks like a network fault and is treated as one.

The node reports its own hold as `segment_timeout_ms`, and the core passes it to you on `PlaybackSource.budgets.segmentHoldMs` — use it rather than assuming. Known stack deadlines, read from shipped artifacts: hls.js governs on `fragLoadPolicy.default.maxTimeToFirstByteMs` at 10000 (the deprecated `fragLoadingTimeOut` is inert unless a config sets it); media3's `DEFAULT_READ_TIMEOUT_MILLIS` is 8000. AVFoundation's has not been established. If your platform is not listed, find its deadline and record it here — a platform whose number nobody knows is the one most likely to sit just under the hold.

Retry a hold on the same node, backing off exponentially rather than at a fixed interval. `Retry-After` is a hint, and hls.js ignores it on the fragment path.

### Deadlines come from the node, not from your constants

`PlaybackSource.budgets` carries what the serving node will wait for:

- `deadlineMs` — how long you may spend acquiring this source before giving up on this node. The core's figure, derived from what the node states plus the measured distance to it. Do not shorten it on your own authority: of two deadlines the shorter silently wins, and the other layer then looks broken.
- `segmentHoldMs` — that node's fragment hold, so you can tell an expected refusal at the production frontier from a node that is not working.

Absent means the core could not learn them — an older node, streaming disabled, or no status call yet — and your own conservative default applies. **The core owns when to stop; you own what happens until then**: retry cadence, `Retry-After` handling, and distinguishing a transfer that never became a response.

`MediaStallWatchdog.useSourceBudgets(source)` adopts the node's hold for the stall budget. Call it where you attach a source.

### Check the host provides what the core assumes

`checkPlatformSurface()` probes at runtime and returns findings rather than throwing, so a host can render them on a diagnostics screen. `missingRequiredSurface()` returns only the failures, and empty is the expected answer.

The compile-time gate and a host's runtime are different facts. `npm run lint:platform` proves the core reaches for nothing outside `types/platform-neutral.d.ts`; it cannot prove your host supplies it. Run the probe once on a real device before believing a green build.

### Other required behaviour

- **Optional methods are genuinely optional.** `prepare`, `setSubtitle`, `addDirectSourceAlternative`, `preflightSource`, `detachHost`, `setVolume`, `subscribeFailure` and `subscribeDegradation` may all be omitted; the core checks before calling. Start with `attach`, `detach`, `play`, `pause`, `resume`, `seek`, `localSeekCoverage`, `stop` and `subscribe`.
- **`subscribe` returns its own unsubscribe.** The core calls it. A player that returns nothing leaks listeners across playback generations.
- **Never sniff manifest versus progressive.** `PlaybackSource.isManifest` is `true` when `url` is a playlist to be parsed and `false` when it is media bytes to be decoded. Hand ExoPlayer an `.m3u8` without declaring it and it parses the playlist as a media file. Do not infer it from the extension or from `mode`; URL conventions are the server's to change.
- **An HLS stream URL points at a master playlist.** A library player follows the indirection for you; a hand-rolled fetch-and-parse player must. The core passes `source.url` and `source.mimeType` through untouched and never parses a manifest.
- **With two player engines, guard listeners in both directions.** A native host often needs one engine for video and another for music. Guarding only the newly active engine is not enough — an idle engine still reporting position 0 into shared state makes the progress bar oscillate. The core sees one `Player`; composing two behind it is the host's job.

## What to emit

Emit `PlaybackEvent` on every meaningful transport change, and at a steady tick during playback:

```ts
{ positionMs, durationMs, paused, ended,
  seeking?, buffering?, bufferedRangesMs?, forwardBufferMs?, streamOrigin? }
```

The first four are required and drive the visible transport. The rest are how the coordinator reasons about health: `forwardBufferMs` and `bufferedRangesMs` tell it whether a degradation warning is survivable, and `streamOrigin` tells it which node is actually serving bytes, which can differ from the node that negotiated the session after a direct-source promotion. A player emitting only the first four works; one emitting all of them fails over better.

### `buffering` must not be derived from the buffer

`forwardBufferMs` is a measurement and core reads it as one. It is also read as having an *age*: core subtracts the time elapsed since the event carried it before spending the figure, while the viewer is playing. So emitting on a cadence is worth more than emitting one precise number and going quiet.

And while core is recovering a source, a `0` from an event that also says the element is playing — not `buffering`, not `ended`, not `paused` — is treated as a player on its way down rather than as real exhaustion. Core keeps the last figure it had reason to trust, aged, instead. That guard exists because a tearing-down element can report an empty buffer a beat before it admits it is waiting, and the decision it feeds — whether to spend the viewer's remaining media — cannot be taken back.

The consequence for an adapter is one rule: **derive `buffering` from the player's own state, never from the buffer being empty.** `readyState`, or a `status` field, or whatever the platform gives you. An adapter that computes `buffering` *from* an empty buffer can be wrong about both at once and leaves core nothing to cross-check; one that takes it from the player cannot. It also means signalling exhaustion by zeroing `forwardBufferMs` will not work during a recovery — set `buffering`, which is believed immediately and always.

A genuine zero is safe. A buffer that drained by being watched took exactly as long to drain as it was worth, so the aged figure reaches zero at the same moment the real one does; the guard can decline to believe a collapse the clock has not accounted for, but it cannot invent cover you do not have.

## Capabilities

`Platform.capabilities()` is answered separately and is the other half of getting playback right. Advertise only what your pipeline can decode *and* present.

**Over-claiming is the dangerous direction.** An over-claimed capability is a black screen; an under-claimed one is a transcode nobody needed.

- **Containers matter more than the codec list.** Advertising `mp3` as a codec but not as a container makes a node transcode every MP3 in the library — CPU spent producing something strictly worse than the original, for a device that plays the original natively. Include the bare audio containers (`mp3`, `m4a`, `aac`, `wav`, `flac`, and `ogg`/`oga`/`opus` where supported). A codec list without the container that carries it is not a capability.
- **Claim `hdr` transfers** (`smpte2084` for PQ, `arib-std-b67` for HLG) only when both a deep decoder and a presentation path exist. A codec probe alone is not evidence.
- **Set `videoBitDepth`** to the deepest depth you decode. The core sends it verbatim and does not clamp it.
- **Do not report screen size as a decoder limit.** `maxWidth` and `maxHeight` describe the decoder. A 1080p panel with a 4K-capable decoder leaves them unset; claiming 1920x1080 forces a transcode that buys nothing.
- **`hlsFmp4` is not `hls`.** It asks whether you can play HLS with fragmented-MP4 segments, which is the harder question. `canPlayType('application/vnd.apple.mpegurl')` answers the easier one; mapping it onto this field asserts something never tested, and the failure is a silent stream rather than an error.
- **`hlsVideoCodecs` / `hlsAudioCodecs`** are optional and fall back to the direct-play lists. Set them only when a device's HLS decoder is genuinely narrower than its media element's, and check that it is on the device you care about — equal lists and absent lists are indistinguishable in the result.

**Validate a probe before believing it.** Ask first about a codec that cannot exist. An engine answering "supported" to an impossible string is not discriminating, and every other answer it gives is worthless; fall back to a curated list rather than recording its opinions. A discriminating probe can still be honestly wrong about a specific combination, which is what `PlaybackPolicyOverrides` is for.

**Honest enumeration is only half possible, so curate.** Android's `MediaCodecList` gives codecs but says nothing about containers — that is ExoPlayer's extractor set, fixed at build time — and iOS offers no enumeration API. A curated per-platform list verified against real files is the honest approach.

A real set, from a Samsung TV running the Tizen client:

```ts
{
  platform: 'tizen',
  videoCodecs: ['h264', 'hevc', 'vp9'],
  audioCodecs: ['aac', 'opus', 'vorbis', 'ac3', 'eac3', 'mp3'],
  containers: ['mp4', 'webm', 'mp3', 'ogg'],
  hlsFmp4: true,
  dash: false,
  hdr: [],
}
```

That set is honest and still not sufficient. The panel claims `hevc` and means it, but cannot decode one particular 10-bit Dolby Vision HEVC title and produces a broken picture rather than an error. A codec list answers "which decoders exist", not "will this file play" — which is why `videoBitDepth` and `hdr` are separate fields and why the server gates on them rather than trusting the codec list.

## Checking yourself

The [headless client](headless-client.md) is useful in reverse: it shows the instruction the core chose for a title and what the node did with it, so you can separate a player bug from a chooser bug before debugging on a device.
