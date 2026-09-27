import { describe, expect, it } from 'vitest';
import type { MediaTechnicalStream, PlaybackCapabilities } from '../types.js';
import { deviceQualityClass, offeredModes, playbackVersions, qualityCeiling, qualityClass } from './playbackVersions.js';

const web: PlaybackCapabilities = {
  platform: 'web', videoCodecs: ['h264'], audioCodecs: ['aac'], containers: ['mp4'], hlsFmp4: true, dash: false, hdr: [],
};

function file(mediaId: string, width: number, height: number, codec = 'h264', container = 'mp4') {
  const streams: MediaTechnicalStream[] = [
    { index: 0, type: 'video', codec, profile: '', language: '', default: true, forced: false, width, height },
    { index: 1, type: 'audio', codec: 'aac', profile: '', language: 'eng', default: true, forced: false },
  ];
  return { mediaId, profile: { mediaId, format: container, container, durationMs: 60_000, bitrate: 1_000, streams } };
}

describe('qualityClass', () => {
  it('classes by either dimension, with 10% to spare', () => {
    expect(qualityClass(3840, 2160)).toBe(2160);
    expect(qualityClass(3840, 1600)).toBe(2160); // scope film
    expect(qualityClass(3840, 2076)).toBe(2160); // cropped short
    expect(qualityClass(1920, 800)).toBe(1080);
    expect(qualityClass(1440, 1080)).toBe(1080); // 4:3
    expect(qualityClass(1280, 720)).toBe(720);
    expect(qualityClass(720, 576)).toBe(576); // PAL DVD
    expect(qualityClass(720, 480)).toBe(480); // NTSC DVD
    expect(qualityClass(640, 360)).toBe(360);
    expect(qualityClass(320, 240)).toBe(360);
  });
});

describe('qualityCeiling', () => {
  const uhdPanel = { width: 3840, height: 2160 };
  const fhd = { width: 1920, height: 1080 };

  it('caps unset automatic play at the display, and a setting overrides it either way', () => {
    expect(qualityCeiling({ display: fhd })).toEqual({ quality: 1080, reason: 'ceiling-display' });
    expect(qualityCeiling({ display: fhd, preference: { wifi: 2160 } })).toEqual({ quality: 2160, reason: 'ceiling-preference' });
    expect(qualityCeiling({ display: uhdPanel, preference: { wifi: 720 } })).toEqual({ quality: 720, reason: 'ceiling-preference' });
    expect(qualityCeiling({})).toBeUndefined();
    // Upright or on its side, a 20:9 phone is a 1080 screen: a 1440p picture
    // would be scaled down to fit its 1080 rows.
    expect(qualityCeiling({ display: { width: 1080, height: 2400 } })).toEqual({ quality: 1080, reason: 'ceiling-display' });
    expect(qualityCeiling({ display: { width: 2400, height: 1080 } })).toEqual({ quality: 1080, reason: 'ceiling-display' });
    expect(qualityCeiling({ display: { width: 1366, height: 768 } })).toEqual({ quality: 720, reason: 'ceiling-display' });
    expect(qualityCeiling({ display: { width: 2560, height: 1600 } })).toEqual({ quality: 1440, reason: 'ceiling-display' });
  });

  it('holds mobile data lower, by its own setting or the default, and counts an unknown connection as Wi-Fi', () => {
    expect(qualityCeiling({ display: fhd, connection: 'cellular' })).toEqual({ quality: 720, reason: 'ceiling-cellular' });
    expect(qualityCeiling({ display: fhd, connection: 'cellular', preference: { cellular: 480 } })).toEqual({ quality: 480, reason: 'ceiling-cellular' });
    expect(qualityCeiling({ display: fhd, connection: 'unknown' })).toEqual({ quality: 1080, reason: 'ceiling-display' });
    // A Wi-Fi ceiling already below mobile data's is the one that binds.
    expect(qualityCeiling({ display: { width: 854, height: 480 }, connection: 'cellular' })).toEqual({ quality: 480, reason: 'ceiling-display' });
  });
});

describe('playbackVersions', () => {
  it("steps down from the best file's class to 720, a file where one is of the class and a capped transcode where none is", () => {
    const versions = playbackVersions([file('uhd', 3840, 2160, 'hevc', 'matroska'), file('fhd', 1920, 1080)], web);
    expect(versions.steps.map((step) => [step.quality, step.source, step.mediaId])).toEqual([
      [2160, 'file', 'uhd'],
      [1440, 'transcode', 'uhd'],
      [1080, 'file', 'fhd'],
      [720, 'transcode', 'fhd'],
    ]);
    expect(versions.steps[1]).toMatchObject({ maxHeight: 1440, instruction: { mode: 'transcode', video: 'transcode', container: 'fmp4' } });
  });

  it("caps a transcode to the source's shape, not the class's", () => {
    const versions = playbackVersions([file('scope', 1920, 800)], web);
    // 2.39:1 in a 1280-wide frame is 533, taken to the even 534.
    expect(versions.steps.find((step) => step.quality === 720)?.maxHeight).toBe(534);
  });

  it('offers a best file below 720p as its own class, and none above it', () => {
    const versions = playbackVersions([file('dvd', 720, 480)], web);
    expect(versions.steps.map((step) => step.quality)).toEqual([480]);
  });

  it('plays automatically the best file at or below the ceiling, and says the ceiling limited it', () => {
    const facts = [file('uhd', 3840, 2160), file('fhd', 1920, 1080)];
    const free = playbackVersions(facts, web);
    expect(free.automatic).toMatchObject({ quality: 2160, mediaId: 'uhd', source: 'file' });
    expect(free.limitedBy).toBeUndefined();

    const ceiling = { quality: 1080 as const, reason: 'ceiling-display' as const };
    const capped = playbackVersions(facts, web, { ceiling });
    expect(capped.automatic).toMatchObject({ quality: 1080, mediaId: 'fhd', source: 'file' });
    expect(capped.limitedBy).toEqual(ceiling);
  });

  it('transcodes the smallest file down to the ceiling when every file is above it', () => {
    const versions = playbackVersions([file('uhd', 3840, 2160), file('qhd', 2560, 1440)], web, { ceiling: { quality: 720, reason: 'ceiling-cellular' } });
    expect(versions.automatic).toMatchObject({ quality: 720, source: 'transcode', mediaId: 'qhd', maxHeight: 720 });
  });

  it('prefers a larger file that plays without re-encoding, and a smaller one over a larger that needs it', () => {
    const remuxUhd = file('uhd', 3840, 2160, 'h264', 'matroska');
    expect(playbackVersions([file('fhd', 1920, 1080), remuxUhd], web).automatic?.mediaId).toBe('uhd');
    const hevcUhd = file('hevc', 3840, 2160, 'hevc', 'matroska');
    const versions = playbackVersions([hevcUhd, file('fhd', 1920, 1080)], web, { ceiling: { quality: 2160, reason: 'ceiling-display' } });
    expect(versions.automatic?.mediaId).toBe('fhd');
    // The ranking, not the ceiling, passed the larger file over.
    expect(versions.limitedBy).toBeUndefined();
  });
});

describe('limited to what the device can play, unless the viewer offers everything', () => {
  const phone: PlaybackCapabilities = { ...web, maxWidth: 2400, maxHeight: 1080 };
  const facts = () => [file('uhd', 3840, 2160), file('fhd', 1920, 1080)];

  it('classes the device from the size its host stated, and nothing where it stated none', () => {
    expect(deviceQualityClass(phone)).toBe(1080);
    expect(deviceQualityClass({ ...web, maxHeight: 720 })).toBe(720);
    expect(deviceQualityClass(web)).toBeUndefined();
  });

  it('offers no quality above the device, and every one with offerAll', () => {
    expect(playbackVersions(facts(), phone).steps.map((step) => step.quality)).toEqual([1080, 720]);
    expect(playbackVersions(facts(), phone, { offerAll: true }).steps.map((step) => step.quality)).toEqual([2160, 1440, 1080, 720]);
    expect(playbackVersions(facts(), web).steps.map((step) => step.quality)).toEqual([2160, 1440, 1080, 720]);
  });

  it('keeps automatic play within the device even with offerAll, and says so', () => {
    const versions = playbackVersions(facts(), phone, { offerAll: true, ceiling: { quality: 2160, reason: 'ceiling-preference' } });
    expect(versions.automatic).toMatchObject({ quality: 1080, mediaId: 'fhd' });
    expect(versions.limitedBy).toEqual({ quality: 1080, reason: 'ceiling-device' });
  });

  it('offers a device that plays none of the steps its own limit', () => {
    const versions = playbackVersions(facts(), { ...web, maxWidth: 854, maxHeight: 480 });
    expect(versions.steps).toMatchObject([{ quality: 480, source: 'transcode', mediaId: 'fhd' }]);
  });

  it('objects to direct play of a picture larger than the device, where its host stated a size', () => {
    const [uhd] = facts();
    expect(offeredModes(uhd!.profile, phone).map(({ mode, offered }) => [mode, offered])).toEqual([
      ['direct', false], ['remux', false], ['transcode', true],
    ]);
    expect(offeredModes(uhd!.profile, phone)[0]?.reasons).toContain('video-size-exceeds-client');
    // With offerAll every mode is offered, and the reason still says why not.
    expect(offeredModes(uhd!.profile, phone, { offerAll: true })[0]).toMatchObject({ offered: true, reasons: ['video-size-exceeds-client'] });
    expect(offeredModes(uhd!.profile, web).every((mode) => mode.offered)).toBe(true);
  });

  it('offers remux, not direct, for a file the device takes only in a segment container', () => {
    const mkv = file('mkv', 1920, 1080, 'h264', 'matroska');
    expect(offeredModes(mkv.profile, web).map(({ mode, offered }) => [mode, offered])).toEqual([
      ['direct', false], ['remux', true], ['transcode', true],
    ]);
  });
});

describe('a codec whose own decoder is smaller than the device', () => {
  it('is not played directly above its own limit, while other codecs are', () => {
    // The A85: AVC, HEVC and VP9 at 1920x1080, AV1 only at 1280x720.
    const a85: PlaybackCapabilities = { ...web, videoCodecs: ['h264', 'av1'], maxWidth: 1920, maxHeight: 1080, videoCodecMaxSize: { av1: { width: 1280, height: 720 } } };
    const av1 = file('av1', 1920, 1080, 'av1');
    const avc = file('avc', 1920, 1080, 'h264');
    expect(offeredModes(av1.profile, a85)[0]).toMatchObject({ mode: 'direct', offered: false, reasons: ['video-size-exceeds-client'] });
    expect(offeredModes(avc.profile, a85)[0]).toMatchObject({ mode: 'direct', offered: true });
    expect(offeredModes(file('av1-720', 1280, 720, 'av1').profile, a85)[0]).toMatchObject({ offered: true });
  });
});
