import type {
  AlertSettings,
  AlexaStatus,
  Analytics,
  AuthState,
  BillingSettings,
  CalibrationSettings,
  ChannelKind,
  ChannelMeta,
  CostEstimate,
  DailyEmailSettings,
  DailyTotal,
  DaySnapshot,
  HistoryPoint,
  LiveReading,
  SummaryStats,
  TodaySnapshot,
  WeatherCorrelation,
  WeatherDaily,
  WeatherLocation,
} from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `${url} -> HTTP ${res.status}`);
  return data as T;
}

export function fetchChannels() {
  return getJson<{ channels: ChannelMeta[]; mainIndexes: number[] }>("/api/channels");
}

export async function updateChannel(index: number, patch: { label?: string; kind?: ChannelKind; factor?: number }) {
  const res = await fetch(`/api/channels/${index}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update channel ${index} -> HTTP ${res.status}`);
  return res.json() as Promise<ChannelMeta>;
}

export function fetchLive() {
  return getJson<LiveReading>("/api/live");
}

export function fetchTodaySnapshot() {
  return getJson<TodaySnapshot>("/api/today-snapshot");
}

export function fetchDailySnapshots(from: number, to: number) {
  return getJson<{ days: DailyTotal[]; timezone: string; location: { city: string; state: string } | null }>(
    `/api/daily-snapshots?from=${from}&to=${to}`
  );
}

export function fetchDaySnapshot(date: string) {
  return getJson<DaySnapshot>(`/api/day-snapshot?date=${date}`);
}

export function fetchBillingSettings() {
  return getJson<BillingSettings>("/api/settings/billing");
}

export async function setBillingSettings(patch: Partial<BillingSettings>) {
  const res = await fetch("/api/settings/billing", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `set billing settings -> HTTP ${res.status}`);
  return data as BillingSettings;
}

export function fetchCostEstimate(from: number, to: number) {
  return getJson<CostEstimate>(`/api/billing/cost-estimate?from=${from}&to=${to}`);
}

export function fetchCalibrationSettings() {
  return getJson<CalibrationSettings>("/api/settings/calibration");
}

export async function setCalibrationFactor(factor: number) {
  const res = await fetch("/api/settings/calibration", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ factor }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `set calibration factor -> HTTP ${res.status}`);
  return data as CalibrationSettings;
}

export async function setImportCorrection(importGain: number, importOffsetW: number) {
  const res = await fetch("/api/settings/calibration", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ importGain, importOffsetW }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `set import correction -> HTTP ${res.status}`);
  return data as CalibrationSettings;
}

export function fetchHistory(from: number, to: number, points = 300) {
  return getJson<{ from: number; to: number; points: HistoryPoint[] }>(
    `/api/history?from=${from}&to=${to}&points=${points}`
  );
}

export function fetchSummary(from: number, to: number, channel?: number) {
  const suffix = channel !== undefined ? `&channel=${channel}` : "";
  return getJson<SummaryStats>(`/api/summary?from=${from}&to=${to}${suffix}`);
}

export function fetchAnalytics(from: number, to: number) {
  return getJson<Analytics>(`/api/analytics?from=${from}&to=${to}`);
}

export async function fetchMe() {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  return res.json() as Promise<AuthState>;
}

export function adminLogin(email: string, password: string) {
  return postJson<{ ok: true; email: string }>("/api/auth/login", { email, password });
}

export async function adminLogout() {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
}

export function forgotPassword(email: string) {
  return postJson<{ ok: true; message: string }>("/api/auth/forgot-password", { email });
}

export function resetPassword(token: string, newPassword: string) {
  return postJson<{ ok: true }>("/api/auth/reset-password", { token, newPassword });
}

export function fetchWeatherLocation() {
  return getJson<{ location: WeatherLocation | null }>("/api/settings/weather");
}

export async function setWeatherZip(zip: string) {
  const res = await fetch("/api/settings/weather", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ zip }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `set zip -> HTTP ${res.status}`);
  return data as { location: WeatherLocation };
}

export function fetchWeatherCorrelation(from: number, to: number) {
  return getJson<WeatherCorrelation>(`/api/weather-correlation?from=${from}&to=${to}`);
}

export function fetchWeatherDaily(from: number, to: number) {
  return getJson<WeatherDaily>(`/api/weather-daily?from=${from}&to=${to}`);
}

export function fetchVapidPublicKey() {
  return getJson<{ publicKey: string | null }>("/api/push/vapid-public-key");
}

export async function subscribePush(subscription: PushSubscriptionJSON) {
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  });
  if (!res.ok) throw new Error(`subscribe -> HTTP ${res.status}`);
}

export async function unsubscribePush(endpoint: string) {
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export function fetchAlertSettings() {
  return getJson<AlertSettings>("/api/settings/alerts");
}

export function fetchAlexaStatus() {
  return getJson<AlexaStatus>("/api/alexa/status");
}

export async function triggerAlexaRoutine() {
  const res = await fetch("/api/alexa/trigger", { method: "POST", credentials: "include" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `trigger failed -> HTTP ${res.status}`);
  return data as { ok: true };
}

export async function setAlertSettings(patch: Partial<AlertSettings>) {
  const res = await fetch("/api/settings/alerts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `set alert settings -> HTTP ${res.status}`);
  return data as AlertSettings;
}

export function fetchDailyEmailSettings() {
  return getJson<DailyEmailSettings>("/api/settings/daily-email");
}

export async function setDailyEmailSettings(patch: Partial<DailyEmailSettings>) {
  const res = await fetch("/api/settings/daily-email", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `set daily email settings -> HTTP ${res.status}`);
  return data as DailyEmailSettings;
}

export async function sendTestDailyEmail() {
  const res = await fetch("/api/settings/daily-email/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: "{}",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `send test email -> HTTP ${res.status}`);
  return data as { ok: true; date: string; address: string };
}
