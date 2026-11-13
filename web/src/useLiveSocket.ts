import { useEffect, useRef, useState } from "react";
import { fetchHistory } from "./api";
import type { ChannelMeta, LiveReading, StatusMsg } from "./types";

const ROLLING_WINDOW_MS = 10 * 60 * 1000; // keep last 10 minutes for the live chart

export interface RollingPoint {
  ts: number;
  totalPower: number;
  /** power per channel index, for per-circuit rolling charts */
  powers: number[];
}

export function useLiveSocket() {
  const [reading, setReading] = useState<LiveReading | null>(null);
  const [status, setStatus] = useState<StatusMsg>({ state: "connecting" });
  const [socketUp, setSocketUp] = useState(false);
  const [rolling, setRolling] = useState<RollingPoint[]>([]);
  const rollingRef = useRef<RollingPoint[]>([]);
  const [channelsUpdate, setChannelsUpdate] = useState<ChannelMeta[] | null>(null);

  useEffect(() => {
    let socket: WebSocket;
    let retryTimer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/ws`);

      socket.onopen = () => setSocketUp(true);
      socket.onclose = () => {
        setSocketUp(false);
        if (!cancelled) retryTimer = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket.close();

      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "status") {
          setStatus(msg.data);
        } else if (msg.type === "live") {
          const r: LiveReading = msg.data;
          setReading(r);
          const point: RollingPoint = {
            ts: r.ts,
            totalPower: r.totalPower,
            powers: r.channels.map((c) => c.power),
          };
          const next = [...rollingRef.current, point].filter((p) => p.ts >= r.ts - ROLLING_WINDOW_MS);
          rollingRef.current = next;
          setRolling(next);
        } else if (msg.type === "channels") {
          setChannelsUpdate(msg.data);
        }
      };
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  // The rolling buffer above only grows as live WebSocket messages arrive,
  // so right after a page load/refresh the "last 10 min" chart would only
  // show however long the tab's been open — a few seconds, not 10 minutes.
  // Backfill it once from stored history on mount, then merge in whatever
  // the live socket has already appended (it typically connects faster
  // than this fetch round-trips) so no live samples get dropped.
  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    fetchHistory(now - ROLLING_WINDOW_MS, now, 300)
      .then((r) => {
        if (cancelled) return;
        const backfill: RollingPoint[] = r.points.map((p) => ({ ts: p.ts, totalPower: p.totalPower, powers: p.channels }));
        const lastBackfillTs = backfill.length ? backfill[backfill.length - 1].ts : -Infinity;
        const liveTail = rollingRef.current.filter((p) => p.ts > lastBackfillTs);
        const merged = [...backfill, ...liveTail].filter((p) => p.ts >= Date.now() - ROLLING_WINDOW_MS);
        rollingRef.current = merged;
        setRolling(merged);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return { reading, status, socketUp, rolling, channelsUpdate };
}
