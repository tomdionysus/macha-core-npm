# Choosing how to play something

The server does not choose. It reports what the media is and performs what it is told. There is no `auto`: `preferences.mode` is required and must be `direct`, `remux` or `transcode`.

So something has to look at the media facts and the device's real capabilities and conclude what to ask for. That decision lives **here**, once, in `@machafoundation/core` — not in the web client, the TV client and the phone client separately. Three clients deciding independently is three clients that disagree about the same file, and the disagreement shows up as a black screen on whichever one got it wrong.

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
const facts = new MachaPlaybackFactsApi(baseUrl, sessionManager);

new PlaybackRuntime(platform, resolver, {
  facts: async (media) => (await facts.facts({ itemId: media.id }))[0],
  policyOverrides: { excludeContainers: ['webm'] },
});
```

## What the node can do is a fact too

`operations` — from the facts endpoint — says what *this build* can perform for *this source*: whether it can serve it whole, copy each stream into fragmented MP4, or re-encode either. It is an **input**, not a validation step. As a check it could only explain a failure the viewer has already suffered; as an input it stops the instruction being formed.

This is a real failure, not a hypothetical one: a client asked to copy an E-AC-3 track that the host genuinely listed, against a build that could not yet copy E-AC-3 into fragmented MP4. The instruction was correct about the media and correct about the device, and the viewer got nothing, because nothing described the executor. Container-versus-codec compatibility is the server's knowledge to hold; the chooser should be told, not guess.

An absent operation reads as **cannot**, never *can*. An optimistic unknown would defeat the point. Omit `operations` entirely and the chooser assumes the node can do whatever it is asked, which is how it behaved before the facts endpoint existed.

### Fetch the facts per call, never from a pinned endpoint

`operations` describes what **one node's build** can perform. A client that binds an endpoint once and reuses it will eventually reason about a node that is not the one executing the instruction.

That is not hypothetical: during a partial cluster upgrade — some nodes fixed, some not — a chooser reading a pinned node's abilities will confidently instruct a copy that the executing node refuses. It is the same failure as the E-AC-3 case, one level up, and a green typecheck cannot see it.

Use `services.playbackFactsApi` (a `ClusterPlaybackFactsApi`), which resolves the preferred endpoint on every call:

```ts
facts: async (media) => (await services.playbackFactsApi.facts({ itemId: media.id }))[0],
```

Construct `MachaPlaybackFactsApi` against a fixed base URL only when the host genuinely has one endpoint and always will.

## The three modes are a contract, not a description

- **direct** — no container change, nothing re-encoded.
- **remux** — the container changes and **every** stream is copied. Any re-encode and it is not a remux.
- **transcode** — at least one stream is re-encoded. The others may still be copied, which is why `mode: 'transcode', video: 'copy'` is legal and means "transcode the audio only".

`transcode` is the general mode that *permits* per-stream copies; `remux` is the strict one that *requires* them. So `mode: 'remux'` with `audio: 'transcode'` is not a nuance, it is illegal — and the server refuses it **by contract, not by capability**, which means it fails on every node however healthy and no amount of `operations` will save it.

That distinction cost an evening. The refusal reads:

    requested remux requires copy-compatible video and AAC audio without quality conversion

which is the server stating this contract, and was read instead as a node missing an E-AC-3 copy fix. `operations` had just been added, `copy_into_fmp4.audio` was a reachable cause, and so it became the accepted one — nobody asked whether the mode was legal in the first place. **A new diagnostic that explains a symptom is a good way to stop looking.**

The ordering matters: the chooser must not form an illegal instruction, and `operations` then narrows a legal one. An invariant test asserts no returned instruction ever pairs `remux` with a re-encoded stream, over the whole combination space rather than the paths that happen to reach it today — including after `degradeInstruction`, which must promote the mode when it gives up the audio copy.

### Naming a mode restates the whole transform

On an update, `mode` is not one field among several — it is the whole transform, and from server 0.34.0 naming it clears `video`, `audio`, `max_height` and `max_bitrate` unless the same request names them again.

This is the fix for a contradiction the client could not see. Per-stream overrides used to outlive the mode they belonged to, so a session created as `transcode` with `video: 'copy'` refused a later bare `{"mode":"direct"}` with *direct copies every stream* — the illegal pairing judged against an instruction the client had not sent in that request. That is every session the chooser starts with a copy in it, which was most of the library, so Direct and Remux were broken for viewers from a control that looked like it worked.

So a PATCH naming `mode` alone is now safe and means what it says. What it costs is that a quality ceiling set from a different control for a different reason disappears when the viewer touches the Mode picker — a full-height transcode nobody asked for. `restatePreferencesClearedByMode` fills the caps back in from the confirmed session, and only into a transform that can carry one: `direct` and `remux` copy the encoded stream through untouched, so there is genuinely no step at which a cap could apply and letting it clear is right, not lossy. The same goes for a `video: 'copy'` the request itself just asked for.

It restates the segment container too, which is not necessary and is done deliberately anyway. `container` is parsed separately from `mode` and is not in the cleared set — confirmed in 0.34.0's code and on a live node, where a session created as MPEG-TS and then PATCHed with `mode` alone still serves MPEG-TS. The reason to send it regardless is that the two failure postures are not symmetric, and that asymmetry does not go away because the server currently behaves: a redundant field costs one line of JSON, while a device handed fragmented MP4 where it asked for MPEG-TS shows a black picture and reports nothing. Only absent fields are filled, so anything the request names — including a value merged in from an earlier mutation that never reached the wire — always wins.

Creating a session is unaffected: there is nothing yet to clear.

## The rules, and why they are these rules

**Copy whatever can be copied.** Repackaging is cheap and lossless; re-encoding costs the viewer quality and the node its CPU. A container mismatch must never escalate to a full transcode, and an audio codec the host listed must never be silently downmixed to AAC.

**An unreported fact is never a reason to transcode.** Servers omit what they could not probe — Matroska does not carry `bits_per_raw_sample` for HEVC, and colour transfer needs an SPS a bounded probe may not reach. Treating silence as incapacity would transcode most of a library, and a needless transcode costs the viewer quality and the node its CPU.

**There is no second opinion.** Capabilities are not sent to the server at all: it never acted on them, so asking implied a check that did not exist. The server performs what it is told and refuses only what is impossible for this file on this build — an unknown mode or stream instruction, a copy into a container that cannot carry that codec, a copy combined with `maxHeight`/`maxBitrate`, or a transcode with no encoder. A wrong instruction is *performed*: ask for `direct` on a file the host cannot demux and it returns the file and a black picture, with no error to catch and nothing to retry. So this function must be conservative by construction — `direct` and `remux` only on a positive match, transcode on doubt. There is a test asserting exactly that over several hundred generated combinations, and it is the most important test in the package.

**Over-claiming is the dangerous direction.** An over-claimed capability is a black screen; an under-claimed one is a transcode nobody needed.

## Container identity is not the demuxer name

A probed format names every format its *demuxer* covers, not what the file is. Matroska arrives as `matroska,webm`; MP4 as `mov,mp4,m4a,3gp,3g2,mj2`.

Matching any listed name means a host that supports WebM — as every browser and the Samsung honestly do — accepts every **Matroska** file as directly playable. That is a real corrupt picture that cost a real evening. The client's advertisement was correct throughout; the fault was reading a demuxer name list as a container identity.

`containerIsPlayable` resolves the probed format to a container *family* using the first recognised name, which is ffmpeg's canonical one, and matches only within that family. Newer servers report a single canonical `container` instead, which is strictly better — prefer it when present. **Anywhere else that format string is parsed deserves the same treatment.**

## Delivery is not decoding

A device's HLS decoder is often not its media element's. Samsung Tizen 3 direct-plays HEVC, reports it supported through `MediaSource.isTypeSupported`, and then fails to decode it under hls.js. So a codec list valid for direct play can be invalid for remux or transcode delivery.

Set `hlsVideoCodecs` / `hlsAudioCodecs` when they differ from `videoCodecs` / `audioCodecs`; leave them unset when one decoder serves both paths. They must only ever be *narrower*, never wider.

## Two failure modes, two postures

The chooser reasons about two different things, and they fail in opposite ways.

**Against the device, never guess.** Instruct `direct` for a file the host cannot decode and the server performs it: a working stream and a black picture, with a contradiction reported but nothing thrown. Silent and uncatchable. So `direct` and `remux` require a positive capability match, and doubt means transcode.

**Against the node, a wrong guess announces itself.** Instruct something this node's muxers or encoders will not accept and the server refuses with a 400 naming the reason — it does not quietly substitute a mode it prefers. That is loud and recoverable, which is why `degradeInstruction` exists as a backstop.

Reading `operations` up front and not sending the doomed request is still better than catching the refusal. But the asymmetry is why the two are handled differently, and why conservatism is not the answer to everything: applied to the node it would transcode work the node could have copied.

## When the probe lies

Some devices cannot be probed honestly. That same Samsung answers `true` for HEVC through MSE and then fails. No capability probe catches it, so a host must be able to state the truth directly:

```ts
choosePlaybackInstruction(profile, capabilities, {
  overrides: {
    neverDirect: false,
    excludeVideoCodecs: ['hevc'],   // this panel's MSE lies about HEVC
    excludeContainers: ['matroska'],
  },
});
```

The probe is the general mechanism; the override covers a device that lies. Both are needed, and the override is first-class rather than a fork.

### Preferring a segment container

When a host supports both HLS packagings, `preferSegmentContainer` says which it wants. Without it, fragmented MP4 wins whenever available — a preference hardcoded as an ordering, the rule living in the chooser rather than with the party that knows it.

```ts
overrides: { preferSegmentContainer: 'mpegts' }
```

The case it exists for: a 2017 Samsung carries neither HEVC video nor any audio correctly in fragmented MP4 — on the native path or through MediaSource — while copying both untouched in MPEG-TS. The alternative was excluding the audio codec, which forces a re-encode of audio that needs none on every title.

State it here rather than by denying `hlsFmp4`. The set genuinely *can* do fMP4; denying it would falsify a capability to achieve a policy.

A preference the host has not said it supports is ignored, and the default ordering applies — preferring what you cannot play is a configuration error, not an instruction. The reason `host-policy-prefers-container` appears only when the preference actually changed the outcome, so a host with one available container does not see a preference it never exercised.

**Whether the *node* can copy into the preferred container is a separate question**, and one the node now answers. `operations` reports `copyIntoMpegts` beside `copyIntoFmp4`, because the two carriages take genuinely different codecs: MPEG-TS takes MPEG-2 video and MP3/MP2 audio that fragmented MP4 refuses, fragmented MP4 takes AV1 and Opus that MPEG-TS refuses, and both take H.264, HEVC, AAC, AC-3 and E-AC-3. The chooser asks about whichever carriage the instruction actually names; asking `copyIntoFmp4` about an MPEG-TS session answers a question nobody put.

That answer decides **copy versus transcode inside the chosen container. It does not choose the container.** A host states a carriage preference because the other carriage is broken on the device, so retreating to fMP4 on learning the node cannot copy into TS would trade a transcode the viewer can watch for a copy they cannot. Preferring TS against a node that can copy neither stream into it yields a transcode into TS, which plays.

### Reading back what was actually served

An instruction is a request, and until 0.33.1 the segment container was the one part of it with no confirmation anywhere in the response. `session.output.container` closes that: `fmp4` or `mpegts` for an HLS session, the source file's own container for a direct one.

**How far to trust these fields.** There is no independent witness in a session object: `mode`, `output.container` and the stream mime type are all the server stating its plan, and a plan is not evidence about itself. What 0.33.1 added is narrower than verification — the plan is validated against the mode table before the pipeline starts, and an instruction that cannot be performed as stated is refused rather than quietly performed as something else. So the guarantee is not "the field was checked against reality" but "the field cannot describe a thing the server would not do". Build on that and no more.

Read the delivered container from there and never from the request. A preference the node quietly ignored looks identical on screen to one it honoured, and telling those apart is the entire reason the field exists. `describePlaybackSession` puts it on `PlaybackStatusDescription.container`, and the DIRECT/REMUX badge is derived from what was served rather than from the mode: what arrived decides the badge, what was asked for does not.

That badge is also what the stream lines say when nothing was transcoded. A session where every selected stream is copied or omitted labels both lines `DIRECT` or `REMUX`; per-stream words — `VIDEO COPY`, `AUDIO TRANSCODE` — are spent only where the streams actually differ from one another, which is the case they exist to tell apart. Calling a direct hand-off `AUDIO COPY` was true of the instruction and false of the operation: the server copied no stream anywhere, it served the file. Two clients arrived at that complaint independently, one of them from a panel that shares none of this code, so it is worth stating as a rule rather than fixing per screen. **In prose about a session, `copy` describes a stream repackaged while a sibling was not; the whole-session transforms are named `direct` and `remux`.**

The badge asks whether the viewer was handed the file or something built from it, and a manifest settles that on its own — an MPEG-TS source packaged into MPEG-TS segments changes no container and is still a playlist. Container equality cannot see that, so `source.isManifest` is checked first and the container comparison decides only among whole files.

The coordinator keeps the two sides together on `PlaybackInstructionReport`: `container` is what the instruction asked for, `servedContainer` is what came back, and `containerHonoured` is the comparison — undefined, not true, when either side is unknown. A host policy preferring MPEG-TS against a node that ignores it otherwise shows a real container on screen that simply is not the one requested, with nothing pointing at the gap. The comparison is made once here rather than at each call site, because the two sides use different vocabularies and it has exactly one correct answer.

A container the server cannot name arrives as `""`, not as an absent key. Six .avi files in the library answered exactly that until 0.34.0, which names AVI, ASF, MPEG-PS, MPEG-TS, WAV, AIFF and ADTS sources; the normalisation stays because it should now never fire, and a `""` arriving today means a format neither side's table knows — worth surfacing rather than smoothing over. The resolver maps it to `undefined` so consumers have one shape to test, and the status line falls back to `output.format`, which is still the server describing its own output rather than a default. Absent stays absent: render nothing rather than a guess, or a node that never answered becomes indistinguishable from one that did.

### A transformed session's timeline is not the media element's

A transformed playlist is a complete VOD list: `#EXT-X-PLAYLIST-TYPE:VOD`, every planned fragment, `#EXT-X-ENDLIST`, arriving whole on the first fetch and byte-identical on every later fetch of the same generation. Nothing needs to re-fetch or diff it. Detect it by that shape rather than by a version string — the change shipped without a version bump, so `0.36.1` names two different contracts depending on when a node was built, and the playlist is the honest witness.

**The frontier still exists; it moved into the fragment responses.** A fragment or `init.mp4` that has not been produced yet answers `500 segment_not_ready` immediately — a hold, not a fault, and not evidence about the node. A broken generation answers `503 stream_failed` and is terminal. A request past the end of the plan answers `404`, which is a genuine miss and neither of the above. Read all three from the status: the body's machine code is unreachable on a fragment error in every stack checked. See `not-ready` in [writing-a-player.md](writing-a-player.md) for why, and for why the hold is the `500` despite the spec pointing the other way.

**Why the earlier EVENT list is not the answer to come back to.** From 0.32.14 until this shipped, transformed playlists were EVENT lists with segments appended as they were generated. That existed for a real, measured reason: a VOD list of 1,517 planned fragments made a native player prefetch far ahead, and each request for an unproduced segment *blocked on the encoder* for about three seconds — a 98-second black screen before the first frame. What changed is not the playlist shape's safety but the answer to a premature request: a hold now returns in well under a millisecond instead of occupying a connection until the encoder catches up. The list was never the fault; blocking was. Anyone proposing to revert to EVENT lists is treating the symptom this project already diagnosed.

Two consequences hold under both shapes and are worth knowing before diagnosing anything:

- **The duration comes from the session, never from the media element.** `session.durationMs` is the title; `video.duration` is whatever the element currently believes. The coordinator already prefers the session, so a scrubber reading 8 seconds into a 92-minute film is a client reading the wrong field, not a server reporting a wrong number.
- **A seek past the generated frontier is a `seekMs` PATCH, not a media-element seek.** It is satisfied by moving the frontier rather than waiting for it, which is why `seek()` consults `localSeekCoverage()` first and replaces the source generation when the target falls outside it. That in turn is why a `Player` must report coverage honestly rather than returning the title's length: claim a target is locally reachable and the resulting `player.seek()` is silently ignored — no request, no error, and a seek that lands somewhere other than where it was asked for.

### Failures that name their reason

A failed source carries a `reason` beside the code: `source_unreadable`, `source_unsupported` or `source_read_timed_out`. The code says what went wrong; the reason says whether another node could possibly do better.

`source_unsupported` is a fact about the bytes, and every node holds the same bytes — so it ends the search rather than spending the viewer's time collecting three identical refusals. The other two are facts about one node's view of the file, a bad extent or a mount gone slow, and the next node is exactly the right thing to try. All three leave the node's health record alone: none of them says anything about its ability to serve anything else.

### State the limitation at the level the fault is at

An override states a device truth, and stating one **at the wrong level** narrows the choice into a worse branch that the chooser then defends. It is not fooled — it is obeying, and it will keep obeying.

The worked case: a 2017 Samsung was mangling E-AC-3 audio, so `excludeAudioCodecs: ['eac3']` looked like the obvious policy. It forced the AAC transcode instead — and AAC through the same path was *silent*, a failure already proved that evening. The exclusion traded stuttering audio for none, and the chooser defended it perfectly.

The fault was not the codec. Handed as fragmented MP4, that set gives a black screen for copied HEVC, broken audio for copied E-AC-3, and silence for transcoded AAC — while playing all three progressively, and while playing **h264 in fMP4 perfectly well**. So it is not the container wholesale either: it is HEVC video and all audio, in that container, on every delivery path. A codec-level policy against a carriage-level fault can only move the failure around.

That last qualification was itself a correction. "Every stream as fMP4 fails" was recorded here as established when it had been generalised from three data points, and the h264 result falsified it. Narrowing a claim to what was actually measured is not pedantry when the claim is what a future override will be written against.

Before adding an override, ask what varies and what is constant across the failures you have. If every failure shares a container and the codecs differ, the container is the fact. `excludeContainers` and `neverDirect` exist for that, and there is deliberately no way to say "this codec is fine except in that container" — if you need that, you have not finished diagnosing.

Also: prefer one observed failure over a plausible inference. An override added on a guess is indistinguishable from one added on evidence six months later, and the chooser will defend that one too.

## Say why

Every decision returns `reasons` — `container-not-playable`, `video-transfer-not-presentable`, `video-codec-not-deliverable-over-hls`, `host-policy-excludes-codec`, and so on. Surface them. "Why is this transcoding?" is a question the operator asks, and the answer must come from the code that decided rather than three people reconstructing it afterwards.

## Showing the decision to a viewer

`PlaybackCoordinatorSnapshot.instruction` carries `{ mode, video, audio, container, reasons, assumed, chosenByViewer, withoutFacts }`, plus `servedContainer` and `containerHonoured` once a session comes back. Render it **next to the Mode control, not on a device-status screen**. Device capabilities are a standing property, true whether or not anything is playing; an instruction belongs to one playback generation and changes the moment the viewer touches Mode. On a status screen it is blank most of the time or stale about a film that finished an hour ago. Under the Mode row, the answer appears where the question was asked:

```
Mode:  [Choose] [Direct] [Remux] [Transcode]
Chosen for you: this device cannot play the container;
                this server cannot repackage the audio.
```

**Do not label that first control `Auto`.** `auto` was a mode that asked the server to decide, and it does not exist — the server reports what the media is and performs what it is told, and nothing on it is capable of choosing. What this control sends is `mode: 'choose'`, a client-side sentinel the coordinator replaces with a concrete instruction before anything goes on the wire. The two are opposites wearing similar words: one hands the decision away, the other takes it. A viewer told `Auto` is being told something false about where their picture quality is decided, and an engineer reading that label will look for the decision on the wrong machine.

Map the reason slugs to plain sentences. The distinction worth preserving is **who is at fault**, because it is the difference between something a viewer can act on and something they cannot:

| Reasons | What they mean | Fixable? |
| --- | --- | --- |
| `container-not-playable`, `video-codec-not-playable`, `video-transfer-not-presentable`, `video-bit-depth-exceeds-client`, … | This device cannot do it. | No — a permanent property of the hardware. |
| `host-policy-*` | We have chosen not to instruct it here. | Only by changing the policy. |
| `executor-cannot-direct`, `executor-cannot-copy-video`, `executor-cannot-copy-audio` | **This server build** cannot do it. | **Yes — deploy.** |

The `executor-*` reasons are what earn the whole `operations` exercise. "This server cannot repackage the audio" names the node as the culprit, where silence leaves a viewer to assume their television or the file is at fault. That sentence would have saved an hour on the evening this was written.

### Show what had to be assumed

`instruction.assumed` names the optional inputs no host supplied — `operations`, `hlsVideoCodecs`, `hlsAudioCodecs`, `hlsTs`, `videoBitDepth`. Each has a reasonable fallback, which is precisely the problem: a reasonable fallback produces a plausible instruction, so nothing ever looks wrong.

Three fields in one evening — `operations`, `hlsAudioCodecs` and `hlsTs` — were declared in these types, consumed by this function, defaulted here, and populated by no host anywhere. One of them meant the element-versus-delivery distinction was dead on the only device it exists for. None had a symptom. `assumed` is that symptom: it is the only thing distinguishing "the host considered this and had nothing to say" from "nobody ever wired it up", and a stated `false` from an absent field that produces the identical instruction.

A client that believes it supplies everything should see an empty array. If it does not, something is not connected.

Render `withoutFacts` prominently rather than faintly — it is the one line worth reading, because it says the decision was not really a decision. Say `chosenByViewer` plainly too, so an empty `reasons` array reads as "you chose this" rather than as a bug.

## Testing it

This is the highest-consequence logic in the package: get it wrong and someone gets a black screen. It is also pure, so it is exhaustively testable without a device — `choosePlaybackInstruction.test.ts` is table-driven over real media profiles and real capability sets, including the Samsung's. Add a case there before changing a rule.
