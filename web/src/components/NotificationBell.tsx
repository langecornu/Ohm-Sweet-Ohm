import { useEffect, useState } from "react";
import { fetchVapidPublicKey, subscribePush, unsubscribePush } from "../api";
import { trackEvent } from "../analytics";

type State = "unsupported" | "checking" | "off" | "on" | "denied" | "busy";

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const SUPPORTED = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Bell icon, filled when subscribed, outline otherwise. */
function BellIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14 18 8Z" />
      <path d="M10.3 20a1.9 1.9 0 0 0 3.4 0" />
    </svg>
  );
}

export default function NotificationBell() {
  const [state, setState] = useState<State>(SUPPORTED ? "checking" : "unsupported");

  useEffect(() => {
    if (!SUPPORTED) return;
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? "on" : "off"))
      .catch(() => setState("off"));
  }, []);

  async function enable() {
    setState("busy");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "off");
        return;
      }
      const { publicKey } = await fetchVapidPublicKey();
      if (!publicKey) {
        // Server has no VAPID keys configured — nothing to subscribe to.
        setState("off");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      await subscribePush(sub.toJSON() as PushSubscriptionJSON);
      trackEvent("usage_alerts_subscribe", {});
      setState("on");
    } catch {
      setState("off");
    }
  }

  async function disable() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      trackEvent("usage_alerts_unsubscribe", {});
    } finally {
      setState("off");
    }
  }

  if (state === "unsupported") return null;

  const title =
    state === "on"
      ? "Usage alerts on for this device — click to turn off"
      : state === "denied"
        ? "Notifications blocked in your browser settings"
        : "Get notified when usage runs high — click to enable";

  return (
    <button
      className={`theme-toggle ${state === "on" ? "notif-on" : ""}`}
      onClick={state === "on" ? disable : state === "denied" ? undefined : enable}
      disabled={state === "checking" || state === "busy" || state === "denied"}
      title={title}
      aria-label={title}
    >
      <BellIcon on={state === "on"} />
    </button>
  );
}
