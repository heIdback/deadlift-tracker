// v32 — keep the screen on while a workout is being logged (Screen Wake
// Lock API), so the phone doesn't lock between sets. Best effort: browsers
// without the API (or that refuse it, e.g. battery saver) simply behave as
// before. The browser drops the lock whenever the page is hidden, so it is
// requested again each time the page becomes visible. Free, local only.

/**
 * Starts keeping the screen on. Returns a function that stops it.
 * `stillWanted()` (optional) is checked before every (re)request: once it
 * returns false — e.g. the workout logger is no longer on screen — the lock
 * stops for good, even if the stop function was never called.
 */
export function keepScreenOn(stillWanted = () => true) {
  const api = typeof navigator !== 'undefined' ? navigator.wakeLock : null;
  if (!api || typeof api.request !== 'function') return () => {};
  let sentinel = null;
  let stopped = false;
  let acquiring = false;

  async function acquire() {
    if (!stopped && !stillWanted()) { stop(); return; }
    if (stopped || acquiring || document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
    acquiring = true;
    try {
      const s = await api.request('screen');
      if (stopped) s.release().catch(() => {});
      else sentinel = s;
    } catch (err) {
      console.debug('Screen wake lock not available:', err?.name ?? err);
    } finally {
      acquiring = false;
    }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };
  document.addEventListener('visibilitychange', onVisible);
  acquire();

  function stop() {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisible);
    sentinel?.release?.().catch(() => {});
    sentinel = null;
  }
  return stop;
}
