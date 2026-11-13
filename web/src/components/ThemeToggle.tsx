import { useEffect, useState } from "react";
import { trackEvent } from "../analytics";

type ThemePref = "auto" | "light" | "dark";
const STORAGE_KEY = "sem-meter-theme";

function readInitial(): ThemePref {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "auto";
}

const ICON: Record<ThemePref, string> = { auto: "◐", light: "☀", dark: "☾" };
const LABEL: Record<ThemePref, string> = { auto: "Auto (follows system)", light: "Light", dark: "Dark" };
const NEXT: Record<ThemePref, ThemePref> = { auto: "light", light: "dark", dark: "auto" };

export default function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>(readInitial);

  useEffect(() => {
    if (pref === "auto") {
      document.documentElement.removeAttribute("data-theme");
      localStorage.removeItem(STORAGE_KEY);
    } else {
      document.documentElement.setAttribute("data-theme", pref);
      localStorage.setItem(STORAGE_KEY, pref);
    }
  }, [pref]);

  return (
    <button
      className="theme-toggle"
      onClick={() =>
        setPref((p) => {
          const next = NEXT[p];
          trackEvent("theme_toggle", { theme: next });
          return next;
        })
      }
      title={`Theme: ${LABEL[pref]} — click to change`}
      aria-label={`Theme: ${LABEL[pref]}`}
    >
      {ICON[pref]}
    </button>
  );
}
