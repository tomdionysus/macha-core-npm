# Choosing how to play something

The server does not choose. It reports what the media is and performs what it is told. There is no `auto`: `preferences.mode` is required, and must be `direct`, `remux` or `transcode`.

So something has to read the media facts and the device's real capabilities and conclude what to ask for. That decision lives here, once, rather than in the web, TV and phone clients separately — three clients deciding independently is three clients that disagree about the same file, and the disagreement is a black screen on whichever one got it wrong.

## The one function

```ts
import { choosePlaybackInstruction, technicalProfileFromCatalogue } from '@machafoundation/core';

const profile = technicalProfileFromCatalogue(await catalogueApi.mediaProfile(mediaId));
const instruction = choosePlaybackInstruction(profile, capabilities, { overrides });
// { mode, video, audio, container, reasons }
```

`mode` is the shorthand; `video` and `audio` are per-stream `copy` or `transcode`; `container` picks `fmp4` or `mpegts` for HLS delivery. Pass them straight into `resolve`.

**You usually do not need to call it.** `PlaybackCoordinator` and `PlaybackRuntime` call it for you: give them a `facts` supplier and they fill in the instruction whenever the viewer has not chosen a mode. An explicit viewer choice always wins — the Mode control must mean what it says, including when it is wrong, because it is the operator's escape hatch.

```ts
new PlaybackRuntime(platform, resolver, {
  facts: async (media) => (await services.playbackFactsApi.facts({ itemId: media.id }))[0],
  policyOverrides: { excludeContainers: ['webm'] },
});
```

## The three modes are a contract, not a description

- **direct** — no container change, nothing re-encoded.
- **remux** — the container changes and **every** stream is copied. Any re-encode and it is not a remux.
- **transcode** — at least one stream is re-encoded. The others may still be copied, which is why `mode: 'transcode', video: 'copy'` is legal and means "transcode the audio only".

`transcode` is the general mode that *permits* per-stream copies; `remux` is the strict one that *requires* them. So `mode: 'remux'` with `audio: 'transcode'` is illegal, and the server refuses it **by contract, not by capability** — it fails on every node however healthy, and no amount of `operations` will save it. The refusal reads:

    requested remux requires copy-compatible video and AAC audio without quality conversion

The chooser must not form an illegal instruction, and `operations` then narrows a legal one; the ordering matters. An invariant test asserts no returned instruction ever pairs `remux` with a re-encoded stream, over the whole combination space rather than the paths that happen to reach it today — including after `degradeInstruction`, which must promote the mode when it gives up the audio copy.

### Naming a mode restates the whole transform

On an update, `mode` is not one field among several. Naming it clears `video`, `audio`, `max_height` and `max_bitrate` unless the same request names them again, so a PATCH naming `mode` alone means exactly what it says.

The cost is that a quality ceiling set from a different control disappears when the viewer touches Mode. `restatePreferencesClearedByMode` fills the caps back in from the confirmed session, and only into a transform that can carry one: `direct` and `remux` copy the encoded stream through untouched, so there is no step at which a cap could apply and letting it clear is right rather than lossy.

It restates the segment container too. `container` is parsed separately from `mode` and is not in the cleared set, so this is redundant and is done deliberately: the two failure postures are not symmetric. A redundant field costs one line of JSON; a device handed fragmented MP4 where it asked for MPEG-TS shows a black picture and reports nothing. Only absent fields are filled, so anything the request names always wins.

Creating a session is unaffected — there is nothing yet to clear.

## What the node can do is a fact too

`operations`, from the facts endpoint, says what *this build* can perform for *this source*: whether it can serve it whole, copy each stream into fragmented MP4 or MPEG-TS, or re-encode either. It is an **input**, not a validation step. As a check it could only explain a failure the viewer had already suffered; as an input it stops the instruction being formed.

An absent operation reads as **cannot**, never *can*. Omit `operations` entirely and the chooser assumes the node can do whatever it is asked.

### Fetch the facts per call, never from a pinned endpoint

`operations` describes what **one node's build** can perform. A client that binds an endpoint once will eventually reason about a node that is not the one executing the instruction — during a partial cluster upgrade, a chooser reading a pinned node's abilities will confidently instruct a copy the executing node refuses.

Use `services.playbackFactsApi`, a `ClusterPlaybackFactsApi`, which resolves the preferred endpoint on every call. Construct `MachaPlaybackFactsApi` against a fixed base URL only when the host genuinely has one endpoint and always will.

## The rules, and why they are these rules

**Copy whatever can be copied.** Repackaging is cheap and lossless; re-encoding costs the viewer quality and the node its CPU. A container mismatch must never escalate to a full transcode, and an audio codec the host listed must never be silently downmixed to AAC.

**An unreported fact is never a reason to transcode.** Servers omit what they could not probe — Matroska does not carry `bits_per_raw_sample` for HEVC, and colour transfer needs an SPS a bounded probe may not reach. Treating silence as incapacity would transcode most of a library.

**There is no second opinion.** Capabilities are not sent to the server at all. It performs what it is told and refuses only what is impossible for this file on this build: an unknown mode or stream instruction, a copy into a container that cannot carry that codec, a copy combined with `maxHeight`/`maxBitrate`, or a transcode with no encoder. A wrong instruction is *performed* — ask for `direct` on a file the host cannot demux and it returns the file and a black picture, with no error to catch and nothing to retry. So this function is conservative by construction: `direct` and `remux` only on a positive match, transcode on doubt. A test asserts exactly that over several hundred generated combinations, and it is the most important test in the package.

**Over-claiming is the dangerous direction.** An over-claimed capability is a black screen; an under-claimed one is a transcode nobody needed.

## Container identity is not the demuxer name

A probed format names every format its *demuxer* covers, not what the file is. Matroska arrives as `matroska,webm`; MP4 as `mov,mp4,m4a,3gp,3g2,mj2`.

Matching any listed name means a host that supports WebM — as every browser does — accepts every Matroska file as directly playable, and the picture is corrupt. `containerIsPlayable` resolves the probed format to a container *family* using the first recognised name, which is ffmpeg's canonical one, and matches only within that family. Newer servers report a single canonical `container` instead, which is strictly better; prefer it when present. **Anywhere else that format string is parsed deserves the same treatment.**

## Delivery is not decoding

A device's HLS decoder is often not its media element's. Samsung Tizen 3 direct-plays HEVC, reports it supported through `MediaSource.isTypeSupported`, then fails to decode it under hls.js. So a codec list valid for direct play can be invalid for remux or transcode delivery.

Set `hlsVideoCodecs` / `hlsAudioCodecs` when they differ from `videoCodecs` / `audioCodecs`; leave them unset when one decoder serves both paths. They must only ever be *narrower*, never wider.

## Two failure modes, two postures

**Against the device, never guess.** Instruct `direct` for a file the host cannot decode and the server performs it: a working stream and a black picture, with nothing thrown. Silent and uncatchable. So `direct` and `remux` require a positive capability match, and doubt means transcode.

**Against the node, a wrong guess announces itself.** Instruct something this node's muxers or encoders will not accept and the server refuses with a 400 naming the reason; it does not quietly substitute a mode it prefers. That is loud and recoverable, which is why `degradeInstruction` exists as a backstop.

Reading `operations` up front and not sending the doomed request is still better than catching the refusal. But the asymmetry is why the two are handled differently, and why conservatism is not the answer to everything — applied to the node it would transcode work the node could have copied.

## When the probe lies

Some devices cannot be probed honestly. A host must be able to state the truth directly:

```ts
choosePlaybackInstruction(profile, capabilities, {
  overrides: {
    neverDirect: false,
    excludeVideoCodecs: ['hevc'],   // this panel's MSE lies about HEVC
    excludeContainers: ['matroska'],
  },
});
```

The probe is the general mechanism; the override covers a device that lies. The override is first-class rather than a fork.

### State the limitation at the level the fault is at

An override states a device truth, and stating one at the wrong level narrows the choice into a worse branch that the chooser then defends. It is not fooled — it is obeying, and it will keep obeying.

A codec-level policy against a carriage-level fault can only move the failure around. One 2017 Samsung gives a black screen for copied HEVC, broken audio for copied E-AC-3 and silence for transcoded AAC when handed fragmented MP4, while playing all three progressively and playing h264 in fMP4 perfectly well. The fact is the combination of those codecs with that carriage, not the codecs.

Before adding an override, ask what varies and what is constant across the failures you have. If every failure shares a container and the codecs differ, the container is the fact. `excludeContainers` and `neverDirect` exist for that, and there is deliberately no way to say "this codec is fine except in that container" — if you need that, you have not finished diagnosing.

Prefer one observed failure over a plausible inference. An override added on a guess is indistinguishable from one added on evidence six months later, and the chooser will defend that one too.

### Preferring a segment container

When a host supports both HLS packagings, `preferSegmentContainer` says which it wants. Without it, fragmented MP4 wins whenever available.

```ts
overrides: { preferSegmentContainer: 'mpegts' }
```

State it here rather than by denying `hlsFmp4`: a set that genuinely can do fMP4 but carries HEVC and audio correctly only in MPEG-TS needs a policy, not a falsified capability. A preference the host has not said it supports is ignored. The reason `host-policy-prefers-container` appears only when the preference actually changed the outcome.

**Whether the node can copy into the preferred container is a separate question**, and `operations` reports `copyIntoMpegts` beside `copyIntoFmp4` because the two carriages take different codecs: MPEG-TS takes MPEG-2 video and MP3/MP2 audio that fragmented MP4 refuses; fragmented MP4 takes AV1 and Opus that MPEG-TS refuses; both take H.264, HEVC, AAC, AC-3 and E-AC-3. The chooser asks about whichever carriage the instruction names.

That answer decides **copy versus transcode inside the chosen container. It does not choose the container.** A host states a carriage preference because the other carriage is broken on the device, so retreating to fMP4 on learning the node cannot copy into TS would trade a transcode the viewer can watch for a copy they cannot.

## Reading back what was actually served

Read the delivered container from `session.output.container` — `fmp4` or `mpegts` for HLS, the source file's own container for a direct session — and never from the request. A preference the node ignored looks identical on screen to one it honoured.

**How far to trust it.** There is no independent witness in a session object: `mode`, `output.container` and the stream mime type are all the server stating its plan, and a plan is not evidence about itself. What the server guarantees is narrower than verification — the plan is validated against the mode table before the pipeline starts, so an instruction that cannot be performed as stated is refused rather than quietly performed as something else. The field cannot describe a thing the server would not do. Build on that and no more.

`describePlaybackSession` puts it on `PlaybackStatusDescription.container`, and the DIRECT/REMUX badge derives from what was served rather than from the mode. The coordinator keeps both sides on `PlaybackInstructionReport`: `container` is what was asked for, `servedContainer` is what came back, and `containerHonoured` is the comparison — undefined, not true, when either side is unknown.

**In prose about a session, `copy` describes a stream repackaged while a sibling was not; the whole-session transforms are named `direct` and `remux`.** A session where every selected stream is copied or omitted labels both lines `DIRECT` or `REMUX`; per-stream words like `VIDEO COPY` are spent only where the streams differ from one another. Calling a direct hand-off `AUDIO COPY` is true of the instruction and false of the operation — the server copied no stream anywhere, it served the file.

The badge asks whether the viewer was handed the file or something built from it, and a manifest settles that alone: an MPEG-TS source packaged into MPEG-TS segments changes no container and is still a playlist. `source.isManifest` is checked first, and the container comparison decides only among whole files.

A container the server cannot name arrives as `""` rather than as an absent key; the resolver maps it to `undefined` so consumers have one shape to test. Absent stays absent — render nothing rather than a guess, or a node that never answered becomes indistinguishable from one that did.

## A transformed session's timeline is not the media element's

A transformed playlist is a complete VOD list: `#EXT-X-PLAYLIST-TYPE:VOD`, every planned fragment, `#EXT-X-ENDLIST`, arriving whole on the first fetch and byte-identical on every later fetch of the same generation. Nothing needs to re-fetch or diff it. Detect it by that shape rather than by a version string.

**The production frontier lives in the fragment responses.** A fragment or `init.mp4` not yet produced answers `500 segment_not_ready` immediately — a hold, not a fault, and not evidence about the node. A broken generation answers `503 stream_failed` and is terminal. A request past the end of the plan answers `404`. Read all three from the status. The body's machine code is **awkward rather than unreachable** — corrected 2026-09-20 against hls.js 1.6.18, where it is available through `networkDetails` but not through the error event; see [writing-a-player.md](writing-a-player.md). The status is what every stack populates identically, which is why it is the discriminator. See [writing-a-player.md](writing-a-player.md) for why the hold is the `500`.

Two consequences that catch people out:

- **The duration comes from the session, never from the media element.** `session.durationMs` is the title; `video.duration` is whatever the element currently believes. A scrubber reading 8 seconds into a 92-minute film is a client reading the wrong field.
- **A seek past the generated frontier is a `seekMs` PATCH, not a media-element seek.** It is satisfied by moving the frontier rather than waiting for it, which is why `seek()` consults `localSeekCoverage()` first and replaces the source generation when the target falls outside it. A `Player` must therefore report coverage honestly rather than returning the title's length: claim a target is locally reachable and the resulting `player.seek()` is silently ignored — no request, no error, and a seek that lands somewhere other than asked.

## Where a seek actually starts

A transformed generation rarely begins exactly where it was asked to, and the session says so in three fields:

- `seekMs` — where the generation's media begins; the first sample the client receives.
- `seekOffsetMs` — how far into that generation the requested position sits.
- `seekRequestedMs` — the position the server honoured, after clamping to the title.

`seekMs + seekOffsetMs === seekRequestedMs`, exactly, in integer milliseconds. A remux begins at the last keyframe at or *before* the request and carries the remainder as the offset, because a stream copy has no decoder and a fragment's first sample must be a sync sample. Transcode and direct are frame-accurate and report an offset of `0`.

**The core consumes these; a host must not.** The coordinator converts between the title's timeline and the generation's, and hands a player a generation-local position. A host that also corrects by the offset double-corrects, and the result is self-consistent and wrong. `checkSeekInvariant` verifies the sum once, for every client, and reports a violation without acting on it — a clamp cannot trip it, because the sum balances against the honoured position.

`seekOffsetMs` absent means the node predates the field and cannot say. Read that as unknown, never as zero: older nodes aligned *forward*, so the generation may begin after the request rather than before it.

## Say why

Every decision returns `reasons` — `container-not-playable`, `video-transfer-not-presentable`, `video-codec-not-deliverable-over-hls`, `host-policy-excludes-codec`, and so on. Surface them. "Why is this transcoding?" is a question operators ask, and the answer must come from the code that decided.

### Showing the decision to a viewer

`PlaybackCoordinatorSnapshot.instruction` carries `{ mode, video, audio, container, reasons, assumed, chosenByViewer, withoutFacts }`, plus `servedContainer` and `containerHonoured` once a session comes back. Render it **next to the Mode control, not on a device-status screen**. Device capabilities are a standing property; an instruction belongs to one playback generation and changes the moment the viewer touches Mode.

```
Mode:  [Choose] [Direct] [Remux] [Transcode]
Chosen for you: this device cannot play the container;
                this server cannot repackage the audio.
```

**Do not label that first control `Auto`.** `auto` was a mode that asked the server to decide and it does not exist. What this control sends is `mode: 'choose'`, a client-side sentinel the coordinator replaces with a concrete instruction before anything reaches the wire. The two are opposites wearing similar words: one hands the decision away, the other takes it.

Map the reason slugs to plain sentences. The distinction worth preserving is **who is at fault**, because it separates what a viewer can act on from what they cannot:

| Reasons | What they mean | Fixable? |
| --- | --- | --- |
| `container-not-playable`, `video-codec-not-playable`, `video-transfer-not-presentable`, `video-bit-depth-exceeds-client`, … | This device cannot do it. | No — a permanent property of the hardware. |
| `host-policy-*` | We have chosen not to instruct it here. | Only by changing the policy. |
| `executor-cannot-direct`, `executor-cannot-copy-video`, `executor-cannot-copy-audio` | **This server build** cannot do it. | **Yes — deploy.** |

The `executor-*` reasons are what earn the whole `operations` exercise: "this server cannot repackage the audio" names the node, where silence leaves a viewer to assume their television or the file is at fault.

### Show what had to be assumed

`instruction.assumed` names the optional inputs no host supplied — `operations`, `hlsVideoCodecs`, `hlsAudioCodecs`, `hlsTs`, `videoBitDepth`. Each has a reasonable fallback, which is the problem: a reasonable fallback produces a plausible instruction, so nothing ever looks wrong. `assumed` is the only thing distinguishing "the host considered this and had nothing to say" from "nobody wired it up".

A client that believes it supplies everything should see an empty array. If it does not, something is not connected.

Render `withoutFacts` prominently rather than faintly — it says the decision was not really a decision. State `chosenByViewer` plainly too, so an empty `reasons` array reads as "you chose this" rather than as a bug.

## Failures that name their reason

A failed source carries a `reason` beside the code: `source_unreadable`, `source_unsupported` or `source_read_timed_out`. The code says what went wrong; the reason says whether another node could do better.

`source_unsupported` is a fact about the bytes, and every node holds the same bytes, so it ends the search rather than collecting three identical refusals. The other two are facts about one node's view of the file — a bad extent, a mount gone slow — and the next node is the right thing to try. All three leave the node's health record alone: none says anything about its ability to serve anything else.

## Testing it

This is the highest-consequence logic in the package: get it wrong and someone gets a black screen. It is also pure, so it is exhaustively testable without a device. `choosePlaybackInstruction.test.ts` is table-driven over real media profiles and real capability sets. Add a case there before changing a rule.
