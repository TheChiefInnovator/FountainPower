import json
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
from http.server import ThreadingHTTPServer

import serial_bridge
from wti_serial import parse_states


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), serial_bridge.Bridge)
        self.server.config = {"allowed_clients": ["127.0.0.1"], "token": "test-token",
                              "device": "test", "expected_mac": "00-09-9b-01-12-83"}
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.commands = []

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def command(self, device, command, password):
        self.commands.append(command)
        if command == "/SN":
            return "NETWORK STATUS: 00-09-9b-01-12-83"
        if command == "/S":
            return "\n".join(f" {n} | Outlet {n} | (undefined) | ON | 0.5 Secs | OFF |" for n in range(1, 9))
        return "Processing - please wait ..."

    def request(self, body=None, token="test-token"):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.server.server_port}/" + ("action" if body else "status"),
            data=json.dumps(body).encode() if body else None,
            headers={"Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_authorization_before_serial_access(self):
        with patch.object(serial_bridge, "run_command", side_effect=self.command):
            self.assertEqual(self.request(token="wrong")[0], 401)
            self.assertEqual(self.commands, [])

    def test_wrong_device_never_receives_action(self):
        with patch.object(serial_bridge, "run_command", return_value="00-09-9b-01-50-9b") as command:
            self.assertEqual(self.request({"outlet": 1, "action": "on"})[0], 502)
            self.assertEqual(command.call_count, 1)
            self.assertEqual(command.call_args.args[1], "/SN")

    def test_valid_action_verified_and_invalid_outlet_refused(self):
        with patch.object(serial_bridge, "run_command", side_effect=self.command):
            self.assertEqual(self.request({"outlet": 9, "action": "on"})[0], 400)
            self.assertEqual(self.commands, [])
            status, data = self.request({"outlet": 2, "action": "on"})
            self.assertEqual(status, 200)
            self.assertEqual(data["states"]["2"], "on")
            self.assertEqual(self.commands, ["/SN", "/On 2,y", "/S"])

    def test_status_not_confused_with_default_or_label(self):
        self.assertEqual(parse_states(" 2 | GPU 1 | (undefined) | ON | 0.5 Secs | OFF |"), {"2": "on"})
        self.assertEqual(parse_states("ned) | OFF | 0.5 Secs | ON |"), {})


if __name__ == "__main__":
    unittest.main()
