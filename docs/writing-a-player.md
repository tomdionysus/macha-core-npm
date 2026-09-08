# Writing a player

`Player` is the one interface a host must implement to bring Macha to a new platform. Everything else the core needs — storage, a clock, an origin — is a few lines of binding; this is the part with real contracts in it.

The core never touches a media element, a decoder or a view. It decides *what* should be playing and *from where*, then hands that to your player and watches what comes back.

## Start from the fake

`@macha/core/testing` ships `FakePlayer`, the same fixture the core's own playback suites run against. It implements every method including the optional ones, so it is both a working skeleton to copy and a control to test against.

```ts
import { createFakePlayer } from '@macha/core/testing';

const player = createFakePlayer();
player.emit({ positionMs: 5_000, durationMs: 600_000, paused: false, ended: false });
player.fail(new Error('source lost'));       // terminal failure channel
player.degrade(new Error('bandwidth drop')); // early warning channel
```

It records what it was asked to do (`playCalls`, `seekCalls`, `stopCalls`, `attachCalls`, …) and lets you drive the event, failure and degradation channels by hand. Use it to write a test for a coordinator behaviour you expect, watch it pass with the fake, then swap in your player and find out which contract you got wrong.

This entry point depends on no test runner. It is plain classes, usable from Vitest, Jest, `node:test`, or a scratch script.

## The contracts that are not in the type signature

**`attach` is not `play`, and `detachHost` is not `detach`.** `attach(host)` binds an existing player to a presentation surface — a DOM element, a native view handle, a component ref. The core never inspects what you pass; it only carries it from your UI to your player. `attach` must not start a session. `detachHost()` unbinds presentation while keeping playback and its resources alive (this is what makes picture-in-picture or a view remount survivable); `detach()` is final destruction. Conflating them means a remount silently kills playback.

**`play()` resolves when dispatched, not when buffering completes.** It reports "I have accepted this source and asked it to play", not "the viewer can see pictures". Waiting for buffering here stalls the coordinator's failover timing, which is the machinery that moves a viewer to a healthy node.

**`localSeekCoverage()` and `seek()` must share one coordinate system.** Both are source-generation-local: positions within the media the player currently holds, not positions in the title. Platforms disagree wildly about timestamp origins — an HLS manifest may start at an arbitrary PTS — so normalise before exposing ranges. Get this wrong and seeks land in the wrong place, or the coordinator negotiates a new server session for a seek you could have served locally.

**Report failures with evidence.** Throw or emit `PlaybackSourceError` with a `kind`:

| kind | Means | Consequence |
| --- | --- | --- |
| `stream` | The bytes stopped arriving | Retried on another node |
| `media` | The container or stream is broken | Not retried elsewhere |
| `unsupported` | This decoder cannot play this | Not retried elsewhere |
| `not-ready` | The node has not produced this fragment yet | Not evidence at all; nothing is retried |
| `unknown` | No evidence | Retried on another node |

`isEndpointRetryablePlaybackFailure` treats a plain `Error` as retryable, for compatibility with players that predate this. That default is safe but expensive: reporting a decoder failure as a stream failure sends the viewer around the whole cluster to fail identically on every node. If you know it was the decoder, say so.

**`not-ready` is the one that is not a failure.** A node producing fragments answers a request for one it has not made yet with a 5xx meaning "not made yet, ask again". That is the node working, and it is the one case where the right response is to retry the same request on the same node. Report it as `stream` or as a plain `Error` and the coordinator prepares a standby elsewhere and can escalate to failover, which cannot help: the next node is producing a different generation and does not have that fragment either.

Only the player can tell a hold from a real fragment failure, and **what it has to tell them apart with depends on the stack.** The core deliberately does not name the discriminator, because the obvious one is often unreachable. hls.js is the worked example: its `XhrLoader` reports a bad status as `{ code: xhr.status, text: xhr.statusText }` and the fragment layer sets `response.data` to `undefined`, so an error envelope in the body never arrives at the error event; it is reachable only through `data.networkDetails`, which is the raw `XMLHttpRequest` and becomes something else entirely under `FetchLoader`. Headers are behind the same object and no better. The HTTP status is the one field both loaders populate identically.

So find what your stack actually exposes before designing around what the server sends, and if the answer is "only the status", say so — that is a constraint on the wire protocol, not a defect in your adapter. What core requires is only that a hold arrives as `not-ready` and a broken generation as `stream`.

Against Macha that constraint has been answered on the wire — the two are split by **status**, both inside 5xx so a player's own retry still applies:

| status | code | means | report as |
| --- | --- | --- | --- |
| `500` | `segment_not_ready` | Not produced yet; ask again | `not-ready` |
| `503` | `stream_failed` | This generation is broken | `stream` |
| `404` | `not_found` | Past the end of the plan | `stream` |

The JSON body still carries the machine code, for operators and for any client that can read it; it is not the discriminator. The `404` is included because it is the one a hold-aware adapter is most likely to get wrong in the other direction: a request beyond the plan is a genuine miss, not something to sit and retry.

**Why the hold is the 500 and not the 503**, since the spec suggests the opposite and someone will eventually try to correct it: `503` is what every proxy, tunnel and load balancer emits for a service that is genuinely down, so the status is not the server's alone to assign. Give the hold `503` and a dead node behind an intermediary reads as a healthy one still producing fragments — no failover, ever, and nothing surfaced. The two mistakes are not symmetric. Misreading a hold as a loss costs an unnecessary failover: wasteful, visible as a hitch, self-correcting. Misreading a dead node as a hold costs failover entirely: silent, permanent, and likeliest exactly where a proxy is involved. A discriminator readable only as a status has to be one nothing else on the path can emit.

That paragraph is the only record of the reasoning anywhere in this repo, and the decision looks like a mistake to anyone who checks it against the spec alone. Keep them together.

**Hold windows and your stack's deadline.** A held request sends no bytes, so if the server holds for longer than your stack's time-to-first-byte deadline, you never receive the status at all — the client aborts first and takes its timeout path, which looks like a network fault and is treated as one. The server holds for 6000 ms, chosen to clear every deadline anyone has actually read. Be precise about what that means, because the figures are uneven in quality and are not going to improve on their own: hls.js's governing deadline is `fragLoadPolicy.default.maxTimeToFirstByteMs` at 10000 (the deprecated `fragLoadingTimeOut` is inert unless a config sets it), and media3's `DEFAULT_READ_TIMEOUT_MILLIS` is 8000. Both were read out of shipped artifacts. **Neither has ever been confirmed against a running client, nobody is scheduled to confirm them, and AVFoundation's has not been read at all** — the native measurements need hardware this project does not have. Treat that as the standing state rather than a caveat awaiting resolution: the 6000 clears 8000 by 2000 ms of margin that is inferred, not observed.

So if you are writing a player on a platform whose deadline is not listed above, find it and say what you find — nobody else is going to. A platform whose number nobody knows is the one most likely to be sitting just under the hold.

Retry the hold on the same node — the next node is producing a different generation and does not have that fragment either — and back off exponentially rather than hammering at a fixed interval; a `Retry-After` on the hold is a hint, and hls.js ignores it on the fragment path anyway.

**Optional methods are genuinely optional.** `prepare`, `setSubtitle`, `addDirectSourceAlternative`, `preflightSource`, `detachHost`, `subscribeFailure` and `subscribeDegradation` may all be omitted; the core checks before calling. Start with the required set — `attach`, `detach`, `play`, `pause`, `resume`, `seek`, `localSeekCoverage`, `setVolume`, `stop`, `subscribe` — and add the rest when you want the behaviour they buy.

**An HLS stream URL points at a master playlist.** From server 0.32.12 the transcode `master.m3u8` is a real master playlist — `EXT-X-STREAM-INF` entries with `BANDWIDTH`, `CODECS` and `RESOLUTION`, pointing at `media.m3u8` — rather than a media playlist directly. A library player (hls.js, ExoPlayer, AVPlayer) follows that indirection for you and needs no change. A hand-rolled fetch-and-parse player must follow it. The core is unaffected either way: it passes `source.url` and `source.mimeType` through untouched and never parses a manifest.

**Never sniff manifest versus progressive — the source states it.** `PlaybackSource.isManifest` is `true` when `url` is a playlist to be parsed and `false` when it is media bytes to be decoded. Native players do not guess: hand ExoPlayer an `.m3u8` without declaring it and it parses the playlist as a media file and reports a source error. Do not infer it from the extension or from `mode` either — the server is free to change URL conventions, and did (0.32.12 turned `master.m3u8` from a media playlist into a real master playlist without renaming it).

**If you have two player engines, guard listeners in both directions.** A native host often needs two — video on one engine, music on another, because a real music player needs a media session the video engine will not provide. The moment there are two, every event listener needs to know which engine it belongs to. Guarding only the newly active engine is not enough: in `macha-client-rn` the idle video player kept reporting position 0 into shared state and the progress bar oscillated between the real time and zero. The core sees one `Player`; composing two behind it is the host's job, and the seam between them is where this bug lives.

**`subscribe` returns its own unsubscribe.** The core calls it. A player that returns nothing leaks listeners across playback generations.

## What to emit

Emit `PlaybackEvent` on every meaningful transport change, and at a steady tick during playback:

```ts
{ positionMs, durationMs, paused, ended,
  seeking?, buffering?, bufferedRangesMs?, forwardBufferMs?, streamOrigin? }
```

The first four are required and drive the visible transport. The rest are how the coordinator reasons about health: `forwardBufferMs` and `bufferedRangesMs` tell it whether a degradation warning is survivable, and `streamOrigin` tells it which node is actually serving bytes — which can differ from the node that negotiated the session after a direct-source promotion. A player that emits only the first four works; one that emits all of them fails over better.

## Capabilities

`Platform.capabilities()` is answered separately, and it is the other half of getting playback right. Advertise only what your pipeline can actually decode *and* present:

- Claim `hdr` transfers (`smpte2084` for PQ, `arib-std-b67` for HLG) only when both a deep decoder and a presentation path exist. A codec probe alone is not evidence.
- Set `videoBitDepth` to the deepest depth you decode. The core sends it verbatim and does not clamp it, so a host deriving it from a parsed device profile must validate at its own boundary.

Over-claiming is the dangerous direction: an over-claimed capability is a black screen, an under-claimed one is a transcode nobody needed.

**Containers are the biggest practical footgun, more than the codec list.** Advertising `mp3` as a *codec* but not as a *container* made a node transcode every MP3 in the library — burning CPU to produce something strictly worse than the original, for a device that plays the original natively. Adding the bare audio containers (`mp3`, `m4a`, `aac`, `wav`, `flac`, plus `ogg`/`oga`/`opus` where supported) flipped a real album from `transcode` to `direct`, verified against a node. A codec list without the container that carries it is not a capability.

**Do not report screen size as a decoder limit.** `maxWidth`/`maxHeight` describe what the decoder can handle. A 1080p panel with a 4K-capable decoder should leave them unset; claiming 1920x1080 forces a transcode that buys nothing.

**Validate the probe before believing it.** Ask first about a codec that cannot exist. An engine that answers "supported" to an impossible string is not discriminating, and every other answer it gives is worthless — treat the whole probe as unusable and fall back to a curated list rather than recording its opinions. A Samsung Tizen 3 set passes this check: it rejects the impossible codec and returns a genuinely narrower list. It is then still wrong about E-AC-3 in fragmented MP4, which is the useful lesson — a discriminating probe can be honestly wrong, and that is what `PlaybackPolicyOverrides` is for, not a reason to distrust probing in general.

**A capability nobody produces is worse than one nobody consumes.** `hlsVideoCodecs` and `hlsAudioCodecs` are optional and fall back to the direct-play lists when unset. That is deliberate, and it is also a trap: the web client declared them, the chooser read them, and for a while nothing populated them — so the element-versus-delivery distinction was silently inert on the one device it exists for, and every delivery decision was answered by the media element's opinion of a progressive file. If you leave them unset, do so knowingly. If you set them, check they are actually narrower than the direct lists on the device you care about, because equal lists and absent lists are indistinguishable in the result.

**Honest enumeration is only half possible, so curate.** Android's `MediaCodecList` gives you codecs but says nothing about containers — that is ExoPlayer's extractor set, fixed at build time — and iOS offers no enumeration API at all. A curated per-platform list, verified against real files, is the honest approach; a probe that cannot answer the question is worse than a list that admits it was written by hand.

A real set, from a Samsung TV running the Tizen client:

Note `hlsFmp4`, not `hls`. The field asks whether you can play HLS with **fragmented-MP4** segments, which is a harder question than whether you can play HLS. `canPlayType('application/vnd.apple.mpegurl')` answers the easier one — Tizen 3 says yes to it, then renders fMP4 video while silently dropping the muxed AAC. Mapping a general HLS probe onto this field asserts something never tested, and the failure is a silent stream rather than an error.

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

That set is honest and still not sufficient, which is the point. The panel claims `hevc` and means it — but it cannot decode one particular 10-bit Dolby Vision HEVC title, and produces a broken picture rather than an error. A codec list answers "which decoders exist", not "will this file play". That gap is why `videoBitDepth` and `hdr` exist as separate fields, and why the server gates on them instead of trusting the codec list: `hevc` plus an unstated bit depth is exactly the combination that decodes to nothing.

## Checking yourself

Once your player runs, the [headless client](headless-client.md) is useful in reverse — it shows you the instruction the core chose for a title and what the node did with it, so you can tell a player bug from a chooser bug before you start debugging on a device.
