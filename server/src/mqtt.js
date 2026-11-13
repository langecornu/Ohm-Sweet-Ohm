import mqtt from "mqtt";
import { EventEmitter } from "node:events";
import { parseSensePayload } from "./channels.js";

/**
 * Connects to the SEM meter's MQTT broker and emits parsed readings.
 * Emits:
 *   'status' -> { state: 'connecting'|'connected'|'reconnecting'|'error'|'offline', detail? }
 *   'reading' -> parsed reading object (see channels.js#parseSensePayload)
 */
export function startMqttIngest({
  host,
  port,
  username,
  password,
  deviceSn,
  tls = false,
  getCalibrationFactor,
  getCircuitFactors,
}) {
  const bus = new EventEmitter();
  const topic = `SEMMETER/${deviceSn}/#`;
  const url = `${tls ? "mqtts" : "mqtt"}://${host}:${port}`;

  bus.emit("status", { state: "connecting", detail: url });

  const client = mqtt.connect(url, {
    username,
    password,
    clientId: `sem-meter-dashboard-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 4000,
    connectTimeout: 15000,
  });

  client.on("connect", () => {
    bus.emit("status", { state: "connected", detail: `${host}:${port}` });
    client.subscribe(topic, { qos: 0 }, (err) => {
      if (err) bus.emit("status", { state: "error", detail: `subscribe failed: ${err.message}` });
    });
  });

  client.on("reconnect", () => bus.emit("status", { state: "reconnecting" }));
  client.on("close", () => bus.emit("status", { state: "offline" }));
  client.on("error", (err) => bus.emit("status", { state: "error", detail: err.message }));

  client.on("message", (_topic, payloadBuf) => {
    let parsed;
    try {
      parsed = JSON.parse(payloadBuf.toString("utf8"));
    } catch {
      return;
    }
    const factor = getCalibrationFactor ? getCalibrationFactor() : 1;
    const circuitFactors = getCircuitFactors ? getCircuitFactors() : {};
    const reading = parseSensePayload(parsed, factor, circuitFactors);
    if (reading) bus.emit("reading", reading);
  });

  bus.close = () => client.end(true);
  return bus;
}
