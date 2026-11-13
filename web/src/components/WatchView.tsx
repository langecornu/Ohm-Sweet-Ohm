import { useEffect, useRef, useState } from "react";
import { fetchChannels } from "../api";
import type { ChannelMeta } from "../types";
import { useLiveSocket } from "../useLiveSocket";

/**
 * Ultra-minimal live view for a smartwatch's browser — no sidebar, no nav,
 * no chart, just the 3 numbers someone glancing at a wrist would want,
 * one full-screen metric at a time with a horizontal swipe between them
 * (native CSS scroll-snap, not a JS gesture library — a watch screen is
 * too small for 3 numbers to be readable at once). Reached via a query
 * param on the same origin (`?watch=1`, see main.tsx) rather than a real
 * server route, so it needs no backend changes and stays a
 * bookmarkable/"Add to Home Screen" URL on whatever browser the watch has.
 * Deliberately always-dark (AMOLED-friendly, no light/dark toggle of its
 * own) and self-styled — it doesn't pull in styles.css, since it isn't
 * part of the main app's layout at all.
 */
export default function WatchView() {
  const { reading, status } = useLiveSocket();
  const [channels, setChannels] = useState<ChannelMeta[]>([]);
  const [active, setActive] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchChannels()
      .then((r) => setChannels(r.channels))
      .catch(() => {});
  }, []);

  const producerIndexes = channels.filter((c) => c.kind === "producer").map((c) => c.index);
  const byIndex = new Map((reading?.channels ?? []).map((c) => [c.index, c]));
  const solar = producerIndexes.reduce((s, i) => s + (byIndex.get(i)?.power ?? 0), 0);
  const grid = reading?.totalPower ?? 0; // signed: + pulling from grid, − pushing to grid
  const net = solar + grid; // true household total, right now

  const connected = status.state === "connected";
  const fmt = (n: number) => Math.round(Math.abs(n)).toLocaleString();

  const metrics = [
    { label: "NET", value: fmt(net), sub: reading ? "household now" : "connecting…", color: "#3987e5" },
    { label: "SOLAR", value: fmt(solar), sub: solar > 5 ? "producing" : "idle", color: "#1baf7a" },
    { label: "GRID", value: fmt(grid), sub: reading ? (grid >= 0 ? "pulling" : "pushing") : "", color: grid >= 0 ? "#eda100" : "#1baf7a" },
  ];

  function onScroll() {
    const el = trackRef.current;
    if (!el) return;
    setActive(Math.round(el.scrollLeft / el.clientWidth));
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      <style>{`.watch-track::-webkit-scrollbar{display:none}`}</style>
      <div
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: connected ? "#1baf7a" : "#e0483f",
          zIndex: 1,
        }}
      />
      <div
        ref={trackRef}
        onScroll={onScroll}
        className="watch-track"
        style={{
          display: "flex",
          height: "100%",
          width: "100%",
          overflowX: "auto",
          overflowY: "hidden",
          scrollSnapType: "x mandatory",
          scrollbarWidth: "none",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {metrics.map((m) => (
          <div
            key={m.label}
            style={{
              flex: "0 0 100%",
              scrollSnapAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              WebkitUserSelect: "none",
              userSelect: "none",
              fontFamily: "-apple-system, 'Segoe UI', Roboto, sans-serif",
            }}
          >
            <div style={{ fontSize: "0.85rem", fontWeight: 700, letterSpacing: "0.1em", color: "#888" }}>{m.label}</div>
            <div style={{ fontSize: "clamp(2.6rem, 22vw, 4.5rem)", fontWeight: 700, lineHeight: 1, color: m.color, fontVariantNumeric: "tabular-nums" }}>
              {m.value}
              <span style={{ fontSize: "0.32em", marginLeft: 4, color: "#888", fontWeight: 600 }}>W</span>
            </div>
            <div style={{ fontSize: "0.8rem", color: "#666" }}>{m.sub}</div>
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 10,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          gap: 6,
        }}
      >
        {metrics.map((m, i) => (
          <div
            key={m.label}
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: i === active ? "#fff" : "#3a3a3a",
              transition: "background 0.15s",
            }}
          />
        ))}
      </div>
    </div>
  );
}
