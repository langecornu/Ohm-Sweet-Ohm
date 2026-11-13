// Web Push subscription storage + sending. Uses the `web-push` package for
// the VAPID/RFC 8291 crypto — that protocol work isn't reasonable to
// hand-roll the way this project avoids other dependencies (scrypt via
// node:crypto, node:sqlite, etc.) since there's no built-in equivalent.
import webpush from "web-push";
import { db } from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const insertSubStmt = db.prepare(`
  INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
`);
const deleteSubStmt = db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?");
const allSubsStmt = db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions");
const countSubsStmt = db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions");

let ready = false;

/** Call once at startup. No-ops (with a warning) if VAPID keys aren't set,
 * so the rest of the app still runs fine — subscribe/send just do nothing. */
export function initPush({ publicKey, privateKey, subject }) {
  if (!publicKey || !privateKey) {
    console.warn("[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — usage alerts are disabled.");
    return;
  }
  webpush.setVapidDetails(subject || "mailto:admin@example.com", publicKey, privateKey);
  ready = true;
}

export function pushReady() {
  return ready;
}

export function addSubscription(sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error("malformed push subscription");
  insertSubStmt.run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());
}

export function removeSubscription(endpoint) {
  if (endpoint) deleteSubStmt.run(endpoint);
}

export function subscriptionCount() {
  return countSubsStmt.get().n;
}

/**
 * Sends one payload to every registered device. Any subscription the push
 * service reports as gone (404/410 — user uninstalled, cleared data, etc.)
 * is pruned so it isn't retried forever.
 */
export async function broadcastNotification(payload) {
  if (!ready) return;
  const subs = allSubsStmt.all();
  if (subs.length === 0) return;
  const body = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (s) => {
      const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(subscription, body);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          deleteSubStmt.run(s.endpoint);
        } else {
          console.warn(`[push] send failed (${err.statusCode ?? "?"}) for ${s.endpoint.slice(0, 48)}…: ${err.message}`);
        }
      }
    })
  );
}
