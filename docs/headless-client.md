# A headless Macha client

The core has no user interface and no opinion about one. The clearest proof is a client with no interface at all: [`examples/headless.mjs`](examples/headless.mjs) mints a session, discovers the cluster, lists the catalogue and negotiates a real playback session, in about eighty lines of plain JavaScript.

```sh
npm install && npm run build
node docs/examples/headless.mjs http://your-node:7438
```

Against a live cluster it prints:

```
server:    0.32.11
catalogue: 973 items, ready=true
movies:    98
  - 28 Days Later (2002)
  - 28 Years Later (2025)
  - A Clockwork Orange (1971)
endpoints: http://10.44.1.50:7438, http://10.34.1.50:7438, http://10.44.1.51:7438
playback:  "28 Days Later" -> mode=transcode mime=application/vnd.apple.mpegurl
           video transcode, audio transcode
           source matroska,webm, 6787615 ms
           node http://10.44.1.50:7438
video:
  claimed  8-bit, SDR only
  source   depth unreported, transfer unreported
  served   depth unreported, transfer unreported (transcode)
  -> this node does not report served transfer/depth (pre-0.32.12)
           session stopped
```

Note the `endpoints:` line. It was started with **one** URL and ended with three — the health monitor found the siblings on its own. That is the cluster behaviour a host gets for free.

The example is deliberately plain JavaScript importing the built `dist/`, so it runs with nothing installed and no compile step. A demonstration that the core needs neither a browser nor a bundler proves less if it needs a toolchain to run.

## What each step is for

**1 — Install the host environment before anything else.** Storage, clock, id generator and base origin all arrive through `configureMachaHost`. Headless has nothing to persist to, so both stores are in memory; this is the only place the platform shows through, and the only part a native host must genuinely think about. Do it before constructing any service — several singletons read the host lazily on first use, and a service built against the default host keeps it.

**2 — Subscribe to connection state before anything can fail.** `subscribeConnectionState` is an ordinary event bus, not a DOM event, so a host bridges it to whatever it uses. Subscribe early or the first outage goes unheard.

**3 — The endpoint registry *is* the cluster.** Seed it with what you were told and let discovery find the rest. `sessionManager.start(registry)` mints an anonymous session against whichever node answers first; a session from any node is valid cluster-wide, so one dead node cannot block a cold start.

**4 — The health monitor owns a timer.** `health.start()` keeps the registry ranked and learns sibling nodes. It must be stopped, or a headless process will never exit — the example stops it in a `finally`.

**5 — Playback negotiation happens with no player in sight.** The exchange has two halves, and only the first is a decision. `choosePlaybackInstruction()` decides — mode, per-stream copies, segment container, and the `reasons` it decided that way — from the media's own facts plus what this host says it can decode. `playbackResolver.resolve()` then carries that instruction to a node and returns what the node did with it: mode, stream URL, which streams were copied. The server chooses nothing; there is no `auto` to ask it to. What comes back is the entire input to a `Player`, which is why the core can negotiate playback on a machine that cannot decode video. Advertise capabilities honestly to the chooser — over-claiming is how you get a black screen, and under-claiming only costs an unnecessary transcode. See [Choosing how to play something](choosing-playback.md).

**6 — Claimed against served is the diagnostic, not either half alone.** What the client advertised, what the source carries, and what the server actually served are three different answers, and the interesting case is when they disagree. A served `bt709` next to a source `smpte2084` is a successful downconvert; a served transfer identical to a PQ source's, for a client that never claimed PQ, is a gate that did nothing. Reading only what arrived cannot tell those apart.

Servers before 0.32.12 do not report served depth or transfer at all, and the example says so rather than printing a confident blank — which incidentally makes it a quick way to tell which build a node is running, independently of its version string.

**A negotiated session is real server-side work.** It has a transcode behind it. Always `stop()` it, including on the failure path.

## Debugging with it

Set `MACHA_DEBUG=1` and every request the core makes is printed, including the exact wire body sent to the server:

```sh
MACHA_DEBUG=1 node docs/examples/headless.mjs http://your-node:7438
```

This is the fastest way to answer "is the client sending what I think it is?" without a browser, a bundler or a device in the loop. It is also a usable server smoke test: point it at a node after a deploy and it exercises session minting, catalogue reads, endpoint discovery and a full playback session admission and teardown.

Client logs redact bearer tokens and signed capability URLs, so the output is safe to paste into a bug report.

## The failure path

Given an address with nothing behind it, the example reports the outage through the same bus a real client uses, and exits non-zero:

```
  [connection] unreachable: All configured API endpoints are unreachable.
failed: All configured API endpoints are unreachable.
```
