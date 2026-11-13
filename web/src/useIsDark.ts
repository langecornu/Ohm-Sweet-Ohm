import { useEffect, useState } from "react";

/** Effective theme right now: the explicit data-theme ThemeToggle sets, or
 * the OS preference when it's "auto" (no attribute — see ThemeToggle.tsx). */
function computeIsDark(): boolean {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return true;
  if (attr === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(computeIsDark);

  useEffect(() => {
    const recompute = () => setIsDark(computeIsDark());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", recompute);
    // ThemeToggle flips data-theme via direct DOM manipulation, not React
    // state, so watch for that attribute change too.
    const observer = new MutationObserver(recompute);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", recompute);
      observer.disconnect();
    };
  }, []);

  return isDark;
}
