#!/usr/bin/env python3
"""
Validate connectivity to the SEM Meter MQTT integration described in
the vendor's tutorial at https://vs.tumblevd.com/SEM/homeasistant.html
(the "Tutorial on Adding SEM Sensors Based on MQTT in
Home Assistant").

This does NOT hit a REST API -- the SEM Meter integration is MQTT-based.
The device (or the SEM cloud) publishes readings to:

    SEMMETER/<DEVICE_SN>/HA

on the broker mqtt001.tumblevd.com:6000 (SEM's hosted cloud broker), or
to whatever broker you pointed the device at if you chose "Use your own
server" in the SEM app.

This script connects, subscribes to that topic (and its wildcard, in case
the device also publishes to sub-topics), and reports whether a message
with real sensor data arrives within a timeout window. That's the
practical way to "validate it works" for an MQTT-based device.

Credentials are read from environment variables (or prompted for
interactively) -- never pass your password on the command line, since
it would land in shell history / process listings.

Usage:
    export SEMMETER_USER="you@example.com"     # your SEM app login email
    export SEMMETER_PASS="..."                 # your SEM app password
                                                 # (or "semmeter" if you
                                                 # signed up via Apple/Google
                                                 # SSO and never set one)
    python3 validate_semmeter_mqtt.py --sn DCDA0C826ABD

Options:
    --host      MQTT broker host (default: mqtt001.tumblevd.com, SEM's cloud)
    --port      MQTT broker port (default: 6000)
    --sn        Device serial number, as shown in the SEM app device list
                (required)
    --timeout   Seconds to wait for a message before giving up (default: 30)
    --tls       Use TLS (try this if the plain connection is refused)
"""
import argparse
import getpass
import json
import os
import ssl
import sys
import time

try:
    import paho.mqtt.client as mqtt
except ImportError:
    sys.exit(
        "Missing dependency. Install it with:\n"
        "    python3 -m pip install paho-mqtt"
    )

CONNACK_MESSAGES = {
    0: "Connection accepted",
    1: "Connection refused - incorrect protocol version",
    2: "Connection refused - invalid client identifier",
    3: "Connection refused - server unavailable",
    4: "Connection refused - bad username or password",
    5: "Connection refused - not authorised",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="mqtt001.tumblevd.com", help="MQTT broker host")
    parser.add_argument("--port", type=int, default=6000, help="MQTT broker port")
    parser.add_argument("--sn", required=True, help="SEM meter device serial number (e.g. DCDA0C826ABD)")
    parser.add_argument("--timeout", type=int, default=30, help="Seconds to wait for a message")
    parser.add_argument("--tls", action="store_true", help="Connect over TLS")
    args = parser.parse_args()

    username = os.environ.get("SEMMETER_USER") or input("SEM app username/email: ").strip()
    password = os.environ.get("SEMMETER_PASS") or getpass.getpass("SEM app password (blank = try default 'semmeter'): ")
    if not password:
        password = "semmeter"

    topic = f"SEMMETER/{args.sn}/#"

    state = {"connected": False, "connect_rc": None, "messages": []}

    def on_connect(client, userdata, flags, rc, properties=None):
        state["connect_rc"] = rc
        state["connected"] = rc == 0
        if rc == 0:
            print(f"[ok] Connected to {args.host}:{args.port}")
            print(f"[..] Subscribing to {topic}")
            client.subscribe(topic, qos=0)
        else:
            print(f"[fail] CONNACK rc={rc}: {CONNACK_MESSAGES.get(rc, 'unknown error')}")

    def on_message(client, userdata, msg):
        raw = msg.payload.decode("utf-8", errors="replace")
        parsed = None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            pass
        state["messages"].append((msg.topic, parsed if parsed is not None else raw))
        print(f"[msg] {msg.topic}")
        if parsed is not None:
            print(json.dumps(parsed, indent=2)[:2000])
        else:
            print(raw[:500])

    def on_disconnect(client, userdata, *args):
        pass

    client_id = f"sem-meter-validate-{int(time.time())}"
    try:
        client = mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311, callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
    except AttributeError:
        # older paho-mqtt without callback_api_version
        client = mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311)

    client.username_pw_set(username, password)
    client.on_connect = on_connect
    client.on_message = on_message
    client.on_disconnect = on_disconnect

    if args.tls:
        client.tls_set(cert_reqs=ssl.CERT_REQUIRED)

    print(f"[..] Connecting to {args.host}:{args.port} (tls={args.tls}) as user '{username}'")
    try:
        client.connect(args.host, args.port, keepalive=30)
    except Exception as e:
        sys.exit(f"[fail] Could not reach broker {args.host}:{args.port} -> {e}")

    client.loop_start()
    deadline = time.time() + args.timeout
    try:
        while time.time() < deadline:
            if state["connect_rc"] not in (None, 0):
                break
            if state["messages"]:
                # got at least one message; wait a beat more to catch a couple more, then stop
                time.sleep(2)
                break
            time.sleep(0.5)
    finally:
        client.loop_stop()
        client.disconnect()

    print()
    if state["connect_rc"] is None:
        print("[fail] No CONNACK received - broker did not respond (check host/port/network).")
        sys.exit(2)
    if state["connect_rc"] != 0:
        print("[fail] Broker rejected the connection (see CONNACK reason above). Check username/password.")
        sys.exit(2)
    if not state["messages"]:
        print(
            f"[warn] Connected and subscribed to {topic}, but no message arrived within {args.timeout}s.\n"
            "       This usually means: wrong SN, device offline, or device publishing to a different topic."
        )
        sys.exit(1)

    print(f"[ok] Validation succeeded: received {len(state['messages'])} message(s) on topic '{topic}'.")


if __name__ == "__main__":
    main()
