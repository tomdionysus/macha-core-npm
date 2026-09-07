import { describe, expect, it } from 'vitest';
import { buildPlatformTraits, platformTraits, type PlatformTarget } from './platformTraits.js';
import type { Platform } from './Platform.js';

function platform(name: Platform['name']): Platform {
  return { name, capabilities: () => { throw new Error('unused'); }, createPlayer: () => { throw new Error('unused'); } };
}

describe('buildPlatformTraits', () => {
  it('gives both TV/remote targets D-pad navigation and hash routing', () => {
    for (const target of ['samsung', 'android'] satisfies PlatformTarget[]) {
      expect(buildPlatformTraits(target)).toMatchObject({ usesDpadNavigation: true, usesHashRouting: true });
    }
  });

  it('reserves back-key events and remote media controls for Samsung', () => {
    // Android's hardware back is intercepted natively before any JS runs, so
    // there is no keydown to listen for; the two traits are not one trait.
    expect(buildPlatformTraits('android')).toMatchObject({
      receivesBackKeyEvents: false,
      usesRemoteMediaControls: false,
    });
    expect(buildPlatformTraits('samsung')).toMatchObject({
      receivesBackKeyEvents: true,
      usesRemoteMediaControls: true,
    });
  });

  it('leaves a plain web or native target with none of the TV traits', () => {
    for (const target of ['web', 'native', 'tizen'] satisfies PlatformTarget[]) {
      expect(buildPlatformTraits(target)).toEqual({
        usesDpadNavigation: false,
        usesHashRouting: false,
        receivesBackKeyEvents: false,
        usesRemoteMediaControls: false,
      });
    }
  });
});

describe('platformTraits', () => {
  it('adds pointer controls from the live platform, not the build target', () => {
    expect(platformTraits('web', platform('web')).hasPointerControls).toBe(true);
    // An Android WebView build reports 'android' even when the target is web.
    expect(platformTraits('web', platform('android')).hasPointerControls).toBe(false);
    expect(platformTraits('samsung', platform('tizen')).hasPointerControls).toBe(false);
  });
});
