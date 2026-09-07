#!/usr/bin/env python3
"""Authenticated LAN bridge for the WTI attached to FountainSeven's USB serial port."""
import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from wti_serial import parse_states, run_command

LOCK = threading.Lock()


class Bridge(BaseHTTPRequestHandler):
    def reply(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def handle_request(self, mutate=False):
        config = self.server.config
        if self.client_address[0] not in config["allowed_clients"] or not hmac.compare_digest(
            self.headers.get("Authorization", ""), "Bearer " + config["token"]
        ):
            self.reply(401, {"error": "Unauthorized"})
            return
        if self.path != ("/action" if mutate else "/status"):
            self.reply(404, {"error": "Not found"})
            return
        try:
            if mutate:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length < 1024:
                    raise ValueError("Invalid request length")
                body = json.loads(self.rfile.read(length))
                outlet, action = body.get("outlet"), body.get("action")
                if type(outlet) is not int or outlet not in range(1, 9) or action not in ("on", "off", "boot"):
                    raise ValueError("Invalid outlet or action")
        except (ValueError, AttributeError):
            self.reply(400, {"error": "Invalid outlet or action"})
            return
        if not LOCK.acquire(timeout=10):
            self.reply(503, {"error": "Serial unit busy; retry shortly."})
            return
        try:
            def command(value):
                return run_command(config["device"], value, config.get("password"))

            identity = command("/SN").lower()
            if config["expected_mac"].lower() not in identity:
                raise RuntimeError("Serial switch identity mismatch; command refused.")
            if mutate:
                raw = command(f"/{action.capitalize()} {outlet},y")
                if "processing" not in raw.lower():
                    raise RuntimeError("Switch did not acknowledge action.")
            states = parse_states(command("/S"))
            if len(states) != 8:
                raise RuntimeError("Incomplete serial status; check the connection.")
            if mutate and action in ("on", "off") and states[str(outlet)] != action:
                raise RuntimeError("Outlet did not reach the requested state.")
            self.reply(200, {"states": states})
        except (OSError, RuntimeError) as error:
            self.reply(502, {"error": str(error)})
        finally:
            LOCK.release()

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request(mutate=True)


if __name__ == "__main__":
    config = json.loads(Path(os.environ["POWER_BRIDGE_CONFIG"]).read_text())
    if len(config["token"]) < 32 or not config.get("expected_mac"):
        raise SystemExit("A strong token and expected switch MAC are required.")
    server = ThreadingHTTPServer((config["bind"], config.get("port", 3041)), Bridge)
    server.config = config
    server.serve_forever()
