import { useEffect, useState } from "react";
import "./styles.css";
import { fetchChannels, fetchMe } from "./api";
import type { AuthState, ChannelMeta } from "./types";
import { useLiveSocket } from "./useLiveSocket";
import StatTiles from "./components/StatTiles";
import ChannelBars from "./components/ChannelBars";
import TodaySnapshot from "./components/TodaySnapshot";
import DailySnapshots from "./components/DailySnapshots";
import BillingSettings from "./components/BillingSettings";
import CalibrationSettings from "./components/CalibrationSettings";
import LiveTotalPowerCard from "./components/LiveTotalPowerCard";
import TimeSlice from "./components/TimeSlice";
import ChannelSettings from "./components/ChannelSettings";
import WeatherSettings from "./components/WeatherSettings";
import ChannelDetail from "./components/ChannelDetail";
import Analytics from "./components/Analytics";
import HowItWorks from "./components/HowItWorks";
import AboutPage from "./components/AboutPage";
import ThemeToggle from "./components/ThemeToggle";
import AdminAuth from "./components/AdminAuth";
import Logo from "./components/Logo";
import NavIcon from "./components/NavIcon";
import NotificationBell from "./components/NotificationBell";
import AlertSettings from "./components/AlertSettings";
import AlexaSettings from "./components/AlexaSettings";
import DailyEmailSettings from "./components/DailyEmailSettings";
import { trackEvent } from "./analytics";

const STATUS_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  connected: "Live",
  reconnecting: "Reconnecting…",
  error: "Error",
  offline: "Offline",
};

type Tab = "live" | "slice" | "analytics" | "daily" | "howto" | "about" | "settings";

const NAV_ITEMS: { tab: Tab; label: string; icon: Parameters<typeof NavIcon>[0]["name"]; adminOnly?: boolean }[] = [
  { tab: "live", label: "Live", icon: "live" },
  { tab: "slice", label: "Slice of time", icon: "clock" },
  { tab: "analytics", label: "Analytics", icon: "chart" },
  { tab: "daily", label: "Daily Snapshots", icon: "calendar" },
  { tab: "howto", label: "How it works", icon: "flow" },
  { tab: "about", label: "About", icon: "info" },
  { tab: "settings", label: "Settings", icon: "gear", adminOnly: true },
];

export default function App() {
  const { reading, status, rolling, channelsUpdate } = useLiveSocket();
  const [channels, setChannels] = useState<ChannelMeta[]>([]);
  const [tab, setTab] = useState<Tab>("live");
  const [selectedChannel, setSelectedChannel] = useState<number | null>(null);
  const [auth, setAuth] = useState<AuthState>({ authenticated: false, email: null });
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    fetchChannels()
      .then((r) => setChannels(r.channels))
      .catch(() => {});
    fetchMe()
      .then(setAuth)
      .catch(() => {});
  }, []);

  // If the session ends (logout, expiry) while Settings is open, bounce to Live.
  useEffect(() => {
    if (!auth.authenticated && tab === "settings") setTab("live");
  }, [auth.authenticated, tab]);

  // Another tab/client renamed or reclassified a channel — pick it up live.
  useEffect(() => {
    if (channelsUpdate) setChannels(channelsUpdate);
  }, [channelsUpdate]);

  function selectTab(name: Tab) {
    setTab(name);
    setSelectedChannel(null);
    setSidebarOpen(false);
    trackEvent("tab_view", { tab_name: name });
  }

  function selectChannel(index: number) {
    const meta = channels.find((c) => c.index === index);
    trackEvent("circuit_detail_view", { circuit_label: meta?.label ?? `#${index}`, circuit_kind: meta?.kind ?? "unknown" });
    setSelectedChannel(index);
  }

  return (
    <div className="app-shell">
      <div className="mobile-topbar">
        <button className="hamburger-btn" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="brand brand-compact">
          <Logo size={24} />
          <span className="brand-name-compact">Ohm Sweet Ohm</span>
        </div>
        <span className={`status-dot ${status.state}`} title={STATUS_LABEL[status.state] ?? status.state} />
      </div>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <Logo size={32} />
          <div className="brand-text">
            <h1>Ohm Sweet Ohm</h1>
            <span className="device-sn">Live consumption data</span>
          </div>
          <button className="sidebar-close-btn" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
            ×
          </button>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.filter((item) => !item.adminOnly || auth.authenticated).map((item) => (
            <button
              key={item.tab}
              className={`sidebar-nav-btn ${tab === item.tab ? "active" : ""}`}
              onClick={() => selectTab(item.tab)}
            >
              <NavIcon name={item.icon} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className="status-pill">
            <span className={`status-dot ${status.state}`} />
            {STATUS_LABEL[status.state] ?? status.state}
          </span>
          <div className="sidebar-footer-controls">
            <AdminAuth auth={auth} onAuthChanged={setAuth} />
            <NotificationBell />
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <div className="app-main">
        <main>
          {tab === "live" &&
            (selectedChannel !== null ? (
              <ChannelDetail
                index={selectedChannel}
                channels={channels}
                reading={reading}
                onBack={() => setSelectedChannel(null)}
              />
            ) : (
              <>
                <TodaySnapshot />
                <div className="card live-now-card">
                  <h2>Live now</h2>
                  <StatTiles reading={reading} />
                </div>
                <LiveTotalPowerCard rolling={rolling} channels={channels} />
                <div className="card">
                  <h2>Channels ({reading?.channels.length ?? 19})</h2>
                  <ChannelBars reading={reading} onSelect={selectChannel} />
                </div>
              </>
            ))}
          {tab === "slice" && <TimeSlice channels={channels} />}
          {tab === "analytics" && <Analytics />}
          {tab === "daily" && <DailySnapshots />}
          {tab === "howto" && <HowItWorks />}
          {tab === "about" && <AboutPage />}
          {tab === "settings" && auth.authenticated && (
            <>
              <AlertSettings />
              <AlexaSettings />
              <DailyEmailSettings />
              <CalibrationSettings />
              <BillingSettings />
              <WeatherSettings />
              <ChannelSettings channels={channels} reading={reading} onChanged={setChannels} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
