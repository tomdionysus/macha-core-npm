/**
 * A complete Macha client with no user interface.
 *
 * Boots the host environment, mints an anonymous session, discovers the rest
 * of the cluster, lists the catalogue, and negotiates (then stops) a real
 * playback session. Nothing here is a mock: point it at a node and it talks
 * to it.
 *
 *   node docs/examples/headless.mjs http://10.44.1.50:7438
 *
 * Deliberately plain JavaScript against the built `dist/`, so it runs with
 * nothing installed and no compile step — the point is to show that the core
 * needs neither a browser nor a bundler, and a proof that needs a toolchain
 * to run proves less.
 */
import {
  bootstrapEndpoints,
  choosePlaybackInstruction,
  configureClientDiagnostics,
  createMachaServices,
  EndpointHealthMonitor,
  EndpointRegistry,
  configureMachaHost,
  memoryStorage,
  sessionManager,
  subscribeConnectionState,
  technicalProfileFromCatalogue,
} from '../../dist/index.js';

// The client log writes to the console by default, which is right for a real
// app on a device you cannot attach a debugger to, and far too loud here.
// Run with MACHA_DEBUG=1 to see every request the core makes.
configureClientDiagnostics({ console: process.env.MACHA_DEBUG === '1' });

const endpoints = process.argv.slice(2);
if (endpoints.length === 0) {
  console.error('usage: node docs/examples/headless.mjs <node-url> [more-node-urls...]');
  process.exit(2);
}

// 1. The host environment. A headless script has nothing to persist to, so
//    both stores are in memory — this is exactly what a native host does
//    differently, and the only place the platform shows through.
configureMachaHost({
  storage: memoryStorage(),
  ephemeralStorage: memoryStorage(),
});

// 2. Connection state is an event bus, not a browser event. Subscribe before
//    anything can fail, or the first outage goes unheard.
subscribeConnectionState((event) => {
  console.log(`  [connection] ${event.type}${event.message ? `: ${event.message}` : ''}`);
});

// 3. The endpoint registry is the cluster. Seed it with what you were told;
//    discovery finds the rest.
const registry = new EndpointRegistry(bootstrapEndpoints(endpoints));
sessionManager.start(registry);

const services = createMachaServices({ endpointRegistry: registry, auth: sessionManager });

// 4. The health monitor keeps the registry honest and learns sibling nodes.
//    It owns its own timer, so it must be stopped or the process will not exit.
const health = new EndpointHealthMonitor({
  registry,
  clusterStatusApi: services.clusterStatusApi,
  serverApi: services.serverApi,
});
health.start();

async function main() {
  const server = await services.serverApi.status();
  console.log(`server:    ${server.version ?? 'unknown version'}`);

  const catalogue = await services.mediaApi.status();
  console.log(`catalogue: ${catalogue.items} items, ready=${catalogue.ready}`);

  const movies = await services.mediaApi.movies();
  console.log(`movies:    ${movies.length}`);
  for (const movie of movies.slice(0, 5)) {
    console.log(`  - ${movie.title}${movie.year ? ` (${movie.year})` : ''}`);
  }

  console.log(`endpoints: ${registry.candidates().map((c) => c.endpoint.baseUrl).join(', ')}`);

  // 5. Playback negotiation, with no player anywhere in sight. `resolve`
  //    carries an instruction to a node and returns what that node did with
  //    it — mode, stream URL, which streams it copied — which is the whole of
  //    what a Player is handed. It is not a decision coming back: the
  //    decision is made below, here, and the response is the server stating
  //    how it performed it. Advertise capabilities honestly to the chooser:
  //    over-claiming is how you get a black screen.
  const [first] = movies;
  if (!first) return;

  const advertised = {
    platform: 'web',
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
    containers: ['mp4'],
    hlsFmp4: true,
    dash: false,
    hdr: [],
    videoBitDepth: 8,
  };
  // The server does not choose, and there is no `auto` to ask it to. It
  // reports what the media is and performs what it is told, so deciding is
  // the client's job — from the source facts plus what this host can honestly
  // decode. `choosePlaybackInstruction` is that decision, held once in the
  // core so every client reaches the same answer rather than three clients
  // reaching three.
  const raw = await services.catalogueApi.mediaProfile(first.mediaIds[0]).catch(() => undefined);
  const instruction = raw
    ? choosePlaybackInstruction(technicalProfileFromCatalogue(raw), advertised)
    // No immutable profile (a mutable path identity has none). Transcode is
    // the only instruction that is always performable.
    : { mode: 'transcode', video: 'transcode', audio: 'transcode', reasons: ['no-technical-facts'] };

  console.log(`instruction: ${instruction.mode} (video ${instruction.video}, audio ${instruction.audio})`);
  console.log(`  because:   ${instruction.reasons.join(', ')}`);

  const session = await services.playbackResolver.resolve(first, advertised, undefined, {
    mode: instruction.mode,
    video: instruction.video,
    audio: instruction.audio,
    container: instruction.container,
  });
  try {
    console.log(`playback:  "${first.title}" -> mode=${session.mode} mime=${session.mimeType}`);
    console.log(`           video ${session.transform.video}, audio ${session.transform.audio}`);
    console.log(`           source ${session.sourceInfo.format}, ${session.durationMs} ms`);
    console.log(`           node ${session.endpoint?.baseUrl ?? 'n/a'}`);

    // 6. Claimed vs served. Neither half is diagnostic alone: what arrived
    //    only means something next to what was asked for, because the case
    //    worth seeing is precisely when they disagree.
    const sourceVideo = session.sourceInfo.streams.find((s) => s.type === 'video');
    const servedVideo = session.output.video;
    const describe = (depth, transfer) =>
      `${depth ? `${depth}-bit` : 'depth unreported'}, ${transfer ?? 'transfer unreported'}`;

    console.log('video:');
    console.log(`  claimed  ${describe(advertised.videoBitDepth, advertised.hdr.join('+') || 'SDR only')}`);
    console.log(`  source   ${describe(sourceVideo?.bitDepth, sourceVideo?.colorTransfer)}`
      + (sourceVideo?.dolbyVisionProfile ? `, Dolby Vision profile ${sourceVideo.dolbyVisionProfile}` : ''));
    console.log(`  served   ${describe(servedVideo?.bitDepth, servedVideo?.colorTransfer)}`
      + ` (${servedVideo?.transform ?? 'unknown'})`);

    if (sourceVideo?.colorTransfer && servedVideo?.colorTransfer
        && sourceVideo.colorTransfer !== servedVideo.colorTransfer) {
      console.log(`  -> the server converted ${sourceVideo.colorTransfer} to ${servedVideo.colorTransfer}`);
    }
    if (!servedVideo?.colorTransfer) {
      console.log('  -> this node does not report served transfer/depth (pre-0.32.12)');
    }
  } finally {
    // A negotiated session is real server-side work. Always give it back.
    await services.playbackResolver.stop(session.sessionId);
    console.log('           session stopped');
  }
}

try {
  await main();
} catch (error) {
  console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  health.stop();
  sessionManager.stop();
}
