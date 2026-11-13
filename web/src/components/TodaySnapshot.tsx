import { useEffect, useState } from "react";
import { fetchTodaySnapshot } from "../api";
import type { TodaySnapshot as TodaySnapshotData } from "../types";
import SnapshotTiles, { SnapshotSkeletonTiles } from "./SnapshotTiles";

const REFRESH_MS = 60_000;

export default function TodaySnapshot() {
  const [snapshot, setSnapshot] = useState<TodaySnapshotData | null>(null);

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchTodaySnapshot()
        .then((d) => !cancelled && setSnapshot(d))
        .catch(() => {});
    }
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="card">
      <h2>
        Today's snapshot
        {snapshot?.location ? ` — ${snapshot.location.city}, ${snapshot.location.state}` : ""}
      </h2>
      {!snapshot ? (
        <SnapshotSkeletonTiles />
      ) : snapshot.sampleCount === 0 ? (
        <div className="empty-state">No data yet today.</div>
      ) : (
        <SnapshotTiles snapshot={snapshot} />
      )}
    </div>
  );
}
