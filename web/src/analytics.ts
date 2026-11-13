// Thin wrapper around gtag.js custom events. Safe to call anywhere,
// anytime — no-ops if gtag hasn't loaded (e.g. offline) and, per the
// hostname guard in index.html, never actually reaches Google Analytics
// outside the production domain.
declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

export function trackEvent(name: string, params?: Record<string, string | number | boolean>) {
  if (typeof window.gtag === "function") {
    window.gtag("event", name, params);
  }
}
