// Alexa Routine trigger — lets the app fire a pre-built Alexa Routine (e.g.
// "AC Boost: set thermostat to 72°") without ever touching the thermostat
// itself. Alexa Smart Home Skills can't reach into a device that belongs to
// a *different* integration (here, Amazon's own Alexa-exclusive thermostat
// integration) — so instead this exposes one tiny virtual switch to Alexa.
// The user wires that switch to a real Routine themselves, once, in the
// Alexa app ("when this turns on, set the thermostat"). From then on, this
// server just reports the virtual switch turning on (and back off, like a
// momentary button) — Alexa does the rest with its own native integration.
//
// Three separate OAuth-ish credentials are involved, easy to conflate:
//
// 1. Account linking (this server IS the identity provider): when the user
//    links the skill in the Alexa app, Alexa sends them to our own
//    /oauth/authorize, gated behind the existing admin login (auth.js) —
//    proving "this is the homeowner" reuses the password this app already
//    has, rather than standing up a second identity system. The resulting
//    access/refresh token pair (`alexa_link_tokens`) is ours alone; Alexa
//    never uses it for anything but proving linking succeeded.
// 2. The AcceptGrant token (`alexa_grant_token`): a *separate* handshake
//    Alexa runs right after account linking, handled by the Lambda
//    (alexa-skill/index.js) — it exchanges a one-time grant code with LWA
//    for a token scoped to `alexa::async_event:write`, specific to this
//    user. That token (relayed to us via the internal store-grant
//    endpoint below) is what has to ride along as `endpoint.scope.token`
//    on every event we send, so Alexa knows which user's routines to fire.
// 3. The gateway auth token: the skill's *own* app-level credentials
//    (client_credentials grant, same scope) — proves *this skill* is
//    allowed to call the Event Gateway at all. Fetched fresh (cached
//    briefly) whenever we send an event.
import { db } from "./db.js";

const getSettingStmt = db.prepare("SELECT value FROM app_settings WHERE key = ?");
const setSettingStmt = db.prepare(
  "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);
function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? JSON.parse(row.value) : null;
}
function setSetting(key, value) {
  setSettingStmt.run(key, JSON.stringify(value));
}

// The virtual device's identity — must exactly match what the Lambda's
// Discovery response declares (alexa-skill/index.js). Not a secret, just
// has to agree on both ends.
export const ENDPOINT_ID = "ohm-sweet-ohm-ac-boost";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const EVENT_GATEWAY = process.env.ALEXA_EVENT_GATEWAY || "https://api.amazonalexa.com/v3/events";

import crypto from "node:crypto";

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

// ── 1. Account linking (this server as the OAuth identity provider) ─────
// Authorization codes are short-lived and only ever exist for the seconds
// between the user approving and Alexa's server exchanging the code — an
// in-memory Map is fine; a restart mid-linking just means the user retries.
const authCodes = new Map(); // code -> { redirectUri, expiresAt }
const CODE_TTL_MS = 5 * 60_000;

export function createAuthorizationCode(redirectUri) {
  const code = randomToken(24);
  authCodes.set(code, { redirectUri, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

/** Exchanges an authorization code (or refresh token) for our own access/refresh token pair — the account-linking half of the handshake. Returns null if the code/refresh token is invalid or expired. */
export function exchangeAuthorizationCode(code, redirectUri) {
  const entry = authCodes.get(code);
  authCodes.delete(code); // one-time use regardless of outcome
  if (!entry || entry.expiresAt < Date.now() || entry.redirectUri !== redirectUri) return null;
  return issueLinkTokens();
}

export function refreshLinkToken(refreshToken) {
  const stored = getSetting("alexa_link_tokens");
  if (!stored || stored.refreshToken !== refreshToken) return null;
  return issueLinkTokens();
}

function issueLinkTokens() {
  const tokens = { accessToken: randomToken(32), refreshToken: randomToken(32), issuedAt: Date.now() };
  setSetting("alexa_link_tokens", tokens);
  return tokens;
}

export function isAccountLinked() {
  return !!getSetting("alexa_link_tokens");
}

// ── 2. The AcceptGrant token (user-scoped, used as endpoint.scope.token) ─
export function storeGrantToken({ accessToken, refreshToken, expiresIn }) {
  setSetting("alexa_grant_token", { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 });
}

async function getValidGrantAccessToken() {
  const stored = getSetting("alexa_grant_token");
  if (!stored) throw new Error("Alexa skill not linked yet — no grant token on file");
  if (stored.expiresAt - Date.now() > 60_000) return stored.accessToken; // still fresh enough

  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      client_id: process.env.ALEXA_LWA_CLIENT_ID,
      client_secret: process.env.ALEXA_LWA_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`refreshing Alexa grant token failed: HTTP ${res.status}`);
  const data = await res.json();
  const fresh = { accessToken: data.access_token, refreshToken: data.refresh_token ?? stored.refreshToken, expiresAt: Date.now() + data.expires_in * 1000 };
  setSetting("alexa_grant_token", fresh);
  return fresh.accessToken;
}

// ── 3. The gateway auth token (skill-level, proves the skill to Alexa) ──
let gatewayTokenCache = null; // { token, expiresAt }

async function getGatewayAuthToken() {
  if (gatewayTokenCache && gatewayTokenCache.expiresAt - Date.now() > 60_000) return gatewayTokenCache.token;
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.ALEXA_LWA_CLIENT_ID,
      client_secret: process.env.ALEXA_LWA_CLIENT_SECRET,
      scope: "alexa::async_event:write",
    }),
  });
  if (!res.ok) throw new Error(`fetching Alexa gateway token failed: HTTP ${res.status}`);
  const data = await res.json();
  gatewayTokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return gatewayTokenCache.token;
}

// ── Sending the actual event ─────────────────────────────────────────────
async function sendChangeReport(powerState) {
  const [gatewayToken, userToken] = await Promise.all([getGatewayAuthToken(), getValidGrantAccessToken()]);
  const now = new Date().toISOString();
  const body = {
    event: {
      header: { namespace: "Alexa", name: "ChangeReport", messageId: crypto.randomUUID(), payloadVersion: "3" },
      endpoint: { scope: { type: "BearerToken", token: userToken }, endpointId: ENDPOINT_ID },
      payload: {
        change: {
          cause: { type: "APP_INTERACTION" },
          properties: [{ namespace: "Alexa.PowerController", name: "powerState", value: powerState, timeOfSample: now, uncertaintyInMilliseconds: 500 }],
        },
      },
    },
    context: {
      properties: [{ namespace: "Alexa.EndpointHealth", name: "connectivity", value: { value: "OK" }, timeOfSample: now, uncertaintyInMilliseconds: 0 }],
    },
  };
  const res = await fetch(EVENT_GATEWAY, {
    method: "POST",
    headers: { Authorization: `Bearer ${gatewayToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Alexa Event Gateway rejected ChangeReport: HTTP ${res.status} ${text}`);
  }
}

/**
 * Fires the Routine: reports the virtual switch turning ON, then OFF again
 * a few seconds later — the same "momentary press" shape a physical smart
 * button sends, since Routines trigger on the on-edge, not on sustained
 * state. The OFF report is best-effort (logged, not thrown) so a transient
 * failure there doesn't make the whole trigger look like it failed when
 * the part that actually matters (the ON that fires the Routine) succeeded.
 */
export async function triggerRoutine() {
  await sendChangeReport("ON");
  setTimeout(() => {
    sendChangeReport("OFF").catch((err) => console.warn(`[alexa] reset-to-OFF report failed (routine still fired): ${err.message}`));
  }, 3000).unref();
}
