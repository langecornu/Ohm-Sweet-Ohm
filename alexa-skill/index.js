// AWS Lambda handler for the Ohm Sweet Ohm "AC Boost" Alexa Smart Home
// Skill. This is deliberately tiny: it exposes exactly one virtual switch
// so it can be wired into an Alexa Routine (see server/src/alexaSkill.js
// for the full picture of why — TL;DR, Alexa Smart Home Skills can't reach
// into a device that belongs to a *different* integration, so this is a
// stand-in the user's own Routine triggers off of, not a real control
// surface). Runs as its own Lambda, separate from the main GCP-hosted
// server, because Alexa's Smart Home Skill API requires either a Lambda
// ARN or a specific HTTPS endpoint shape as the skill's registered
// endpoint — Lambda is the standard, zero-maintenance choice here.
//
// Needs Node 18+ runtime (uses the global `fetch` and `crypto.randomUUID`,
// no dependencies to bundle).
//
// Environment variables (set in the Lambda console):
//   ALEXA_LWA_CLIENT_ID / ALEXA_LWA_CLIENT_SECRET — same Login with Amazon
//     security profile credentials as the main server's env.
//   TOKEN_STORE_URL — the main server's internal endpoint, e.g.
//     https://meter.langecornu.com/api/internal/alexa/store-grant
//   TOKEN_STORE_SECRET — shared secret; must match ALEXA_INTERNAL_SECRET
//     in the main server's environment.
const ENDPOINT_ID = "ohm-sweet-ohm-ac-boost";
const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

export const handler = async (event) => {
  const namespace = event?.directive?.header?.namespace;
  const name = event?.directive?.header?.name;

  try {
    if (namespace === "Alexa.Discovery" && name === "Discover") {
      return handleDiscover(event);
    }
    if (namespace === "Alexa.Authorization" && name === "AcceptGrant") {
      return await handleAcceptGrant(event);
    }
    if (namespace === "Alexa.PowerController" && (name === "TurnOn" || name === "TurnOff")) {
      return handlePowerControl(event, name === "TurnOn" ? "ON" : "OFF");
    }
    return errorResponse(event, "INVALID_DIRECTIVE", `Unhandled directive: ${namespace}.${name}`);
  } catch (err) {
    console.error("[alexa-skill] handler error:", err);
    return errorResponse(event, "INTERNAL_ERROR", err.message);
  }
};

/**
 * Declares the one virtual device — a switch, the same device type Amazon's
 * own official smart-home sample skill uses for exactly this "expose a
 * button-like trigger" purpose. It supports PowerController (on/off) and
 * nothing else; there's no real hardware behind it.
 */
function handleDiscover(event) {
  return {
    event: {
      header: { namespace: "Alexa.Discovery", name: "Discover.Response", payloadVersion: "3", messageId: crypto.randomUUID() },
      payload: {
        endpoints: [
          {
            endpointId: ENDPOINT_ID,
            manufacturerName: "Ohm Sweet Ohm",
            friendlyName: "AC Boost",
            description: "Virtual trigger for an Ohm Sweet Ohm Routine — wire this to a real action in the Alexa app.",
            displayCategories: ["SWITCH"],
            capabilities: [
              { type: "AlexaInterface", interface: "Alexa", version: "3" },
              {
                type: "AlexaInterface",
                interface: "Alexa.PowerController",
                version: "3",
                properties: { supported: [{ name: "powerState" }], proactivelyReported: true, retrievable: true },
              },
              { type: "AlexaInterface", interface: "Alexa.EndpointHealth", version: "3", properties: { supported: [{ name: "connectivity" }], proactivelyReported: true, retrievable: true } },
            ],
          },
        ],
      },
    },
  };
}

/**
 * The other half of account linking (see server/src/alexaSkill.js's header
 * comment for the three-token overview). Exchanges the one-time grant code
 * Alexa hands us for a user-scoped LWA token, then relays it to the main
 * server to persist — this Lambda holds no state of its own.
 */
async function handleAcceptGrant(event) {
  const grantCode = event.directive.payload.grant.code;
  const tokenRes = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: grantCode,
      client_id: process.env.ALEXA_LWA_CLIENT_ID,
      client_secret: process.env.ALEXA_LWA_CLIENT_SECRET,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`LWA grant-code exchange failed: HTTP ${tokenRes.status} ${await tokenRes.text().catch(() => "")}`);
  }
  const tokens = await tokenRes.json();

  const storeRes = await fetch(process.env.TOKEN_STORE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": process.env.TOKEN_STORE_SECRET },
    body: JSON.stringify({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresIn: tokens.expires_in }),
  });
  if (!storeRes.ok) {
    throw new Error(`storing Alexa grant token on the main server failed: HTTP ${storeRes.status}`);
  }

  return {
    event: {
      header: { namespace: "Alexa.Authorization", name: "AcceptGrant.Response", payloadVersion: "3", messageId: crypto.randomUUID() },
      payload: {},
    },
  };
}

/**
 * Acknowledges a manual toggle from the Alexa app/voice ("Alexa, turn on AC
 * Boost"). There's no real device to change — this just confirms the
 * (harmless) state change back to Alexa so the app doesn't show an error.
 * The main server's own proactive ChangeReport (server/src/alexaSkill.js)
 * is what actually fires the Routine when *we* initiate it; this path only
 * matters if the user pokes the virtual switch directly.
 */
function handlePowerControl(event, powerState) {
  const now = new Date().toISOString();
  return {
    context: {
      properties: [
        { namespace: "Alexa.PowerController", name: "powerState", value: powerState, timeOfSample: now, uncertaintyInMilliseconds: 500 },
        { namespace: "Alexa.EndpointHealth", name: "connectivity", value: { value: "OK" }, timeOfSample: now, uncertaintyInMilliseconds: 0 },
      ],
    },
    event: {
      header: { namespace: "Alexa", name: "Response", payloadVersion: "3", messageId: crypto.randomUUID(), correlationToken: event.directive.header.correlationToken },
      endpoint: event.directive.endpoint,
      payload: {},
    },
  };
}

function errorResponse(event, type, message) {
  return {
    event: {
      header: { namespace: "Alexa", name: "ErrorResponse", payloadVersion: "3", messageId: crypto.randomUUID(), correlationToken: event?.directive?.header?.correlationToken },
      endpoint: event?.directive?.endpoint,
      payload: { type, message },
    },
  };
}
