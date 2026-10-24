/**
 * Android / Capacitor shell integration.
 *
 * All functions are no-ops on the regular web build, so the app keeps working
 * everywhere. Native-only behaviour: status bar theming, splash hide, hardware
 * back button, pause-on-background and screen wake lock.
 */
import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as NativeApp } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function isAndroidApp(): boolean {
  return Capacitor.getPlatform() === 'android';
}

/** Theme the native status bar and dismiss the splash once React has mounted. */
export async function setupNativeShell(): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0b0e14' });
  } catch {
    /* status bar is optional */
  }
  // Let React paint the first frame before revealing the WebView, so the splash
  // does not uncover an empty page on slower devices.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolve, 120)));
  });
  try {
    await SplashScreen.hide();
  } catch {
    /* splash already hidden */
  }
}

/**
 * Android hardware back button. The handler returns true when it consumed the
 * press; returning false lets Android exit the app (standard root behaviour).
 */
export function useAndroidBackButton(handler: () => boolean): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!isAndroidApp()) return;
    let disposed = false;
    let remove: (() => void) | null = null;

    NativeApp.addListener('backButton', () => {
      const consumed = handlerRef.current();
      if (!consumed) void NativeApp.exitApp();
    })
      .then((listener) => {
        if (disposed) void listener.remove();
        else remove = () => void listener.remove();
      })
      .catch(() => {
        /* listener unavailable */
      });

    return () => {
      disposed = true;
      remove?.();
    };
  }, []);
}

/** Pause audio when the app goes to the background. */
export function useNativePause(handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!isAndroidApp()) return;
    let disposed = false;
    let remove: (() => void) | null = null;
    NativeApp.addListener('pause', () => handlerRef.current())
      .then((listener) => {
        if (disposed) void listener.remove();
        else remove = () => void listener.remove();
      })
      .catch(() => {
        /* listener unavailable */
      });
    return () => {
      disposed = true;
      remove?.();
    };
  }, []);
}

/**
 * Keeps the screen awake while practising (playback, recording or a game).
 * Uses the Screen Wake Lock API where available; silently degrades elsewhere.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const request = async () => {
      try {
        if (!('wakeLock' in navigator)) return;
        const acquired = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void acquired.release().catch(() => undefined);
          return;
        }
        sentinel = acquired;
        acquired.addEventListener('release', () => {
          sentinel = null;
        });
      } catch {
        /* not supported or denied */
      }
    };

    void request();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !sentinel) void request();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}
