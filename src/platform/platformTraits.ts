import type { Platform } from './Platform.js';

/**
 * Named answers to "does this platform want X UI behavior" — the single
 * place that decides, replacing `import.meta.env.MODE === 'samsung'` (or
 * `'android'`, or `platform.name === 'web'`) re-derived independently at
 * each call site. Before this, the same underlying question had drifted
 * into three different, inconsistent groupings across the app (Samsung
 * alone in one place, Samsung+Android combined in another, `platform.name`
 * instead of build mode in a third) with no way to tell whether that was
 * deliberate or drift.
 *
 * Each trait names the UI decision it drives, not the platform itself —
 * two platforms sharing a value today (Samsung and Android both want D-pad
 * navigation) is a fact about them, not a reason to collapse the traits
 * into one, since they can diverge independently later.
 */
export interface PlatformTraits {
  /** D-pad spatial focus navigation instead of pointer/touch (Samsung + Android). */
  usesDpadNavigation: boolean;
  /** Router must live in the URL hash rather than real browser history (Samsung + Android). */
  usesHashRouting: boolean;
  /**
   * A physical remote "Return"/back key arrives as a DOM keydown the app
   * can see and act on. Samsung only: Android's hardware back button is
   * intercepted natively in `platforms/android`'s
   * `MainActivity.onBackPressed` (it calls `WebView.goBack()` directly)
   * before any JS ever runs, so there is no keydown to listen for.
   */
  receivesBackKeyEvents: boolean;
  /**
   * TV-remote media control scheme: no pointer/hover, D-pad-driven seek,
   * hardware volume, a dedicated back-to-minimize key. Samsung only today —
   * Android does not get this treatment yet (tracked separately; it likely
   * should on Android TV, but that's a real behavior change, not part of
   * just naming the existing checks).
   */
  usesRemoteMediaControls: boolean;
  /** A real mouse/touch pointer is available (fullscreen toggle, hover-to-reveal controls). */
  hasPointerControls: boolean;
}

/**
 * The build/runtime target these traits are resolved from.
 *
 * The web build derived this from `import.meta.env.MODE`, which only exists
 * under Vite. The target is named explicitly here instead, so a React Native
 * app (which has no build mode at all) states its own.
 */
export type PlatformTarget = 'web' | 'samsung' | 'android' | 'tizen' | 'native';

/**
 * Traits knowable from the target alone, before any `Platform` instance
 * exists — e.g. choosing a router at boot, which must happen before the
 * platform is detected.
 */
export function buildPlatformTraits(
  target: PlatformTarget,
): Pick<PlatformTraits, 'usesDpadNavigation' | 'usesHashRouting' | 'receivesBackKeyEvents' | 'usesRemoteMediaControls'> {
  const isSamsungBuild = target === 'samsung';
  const isAndroidBuild = target === 'android';
  return {
    usesDpadNavigation: isSamsungBuild || isAndroidBuild,
    usesHashRouting: isSamsungBuild || isAndroidBuild,
    receivesBackKeyEvents: isSamsungBuild,
    usesRemoteMediaControls: isSamsungBuild,
  };
}

export function platformTraits(target: PlatformTarget, platform: Platform): PlatformTraits {
  return {
    ...buildPlatformTraits(target),
    hasPointerControls: platform.name === 'web',
  };
}
