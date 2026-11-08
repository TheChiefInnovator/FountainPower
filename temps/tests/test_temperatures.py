import datetime as dt
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    result = importlib.util.module_from_spec(spec)
    loader.exec_module(result)
    return result


agent = module("temps_agent", ROOT / "agent/fountain-temps")
collector = module("temps_collector", ROOT / "collector/fountain-temps-collector")
AT = "2026-11-07T12:00:00Z"
TOKEN = "unit-test-only-" + "x" * 32


def payload():
    return dict(schema=1, collected_at=AT, virtualized=False, uptime_s=1234, load1=1.2,
                warnings=[], readings=[agent.reading("cpu", "coretemp", "pci-test", "Package", 65.1, 80, 95)])


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def hwmon(self, index, chip, device, sensors):
        node = self.root / f"class/hwmon/hwmon{index}"
        node.mkdir(parents=True)
        (node / "name").write_text(chip)
        target = self.root / "devices" / device
        target.mkdir(parents=True, exist_ok=True)
        (node / "device").symlink_to(target, target_is_directory=True)
        for name, value in sensors.items():
            (node / name).write_text(str(value))

    def test_hwmon_two_nvme_gpu_cpu_bogus_and_missing_labels(self):
        self.hwmon(0, "nvme", "pci0000:00/0000:01:00.0/nvme/nvme0", {"temp1_input": 42125, "temp1_label": "Composite", "temp1_max": 85000})
        self.hwmon(1, "nvme", "pci0000:00/0000:02:00.0/nvme/nvme1", {"temp1_input": 51000, "temp1_label": "Composite"})
        self.hwmon(2, "amdgpu", "pci0000:00/0000:03:00.0", {"temp1_input": 60500, "temp1_label": "edge", "temp2_input": 83500, "temp2_label": "junction", "temp2_crit": 95000})
        self.hwmon(3, "coretemp", "platform/coretemp.0", {"temp1_input": 55400, "temp1_label": "Package id 0", "temp2_input": 48000, "temp3_input": 0, "temp4_input": -40000, "temp5_input": 150000, "temp6_input": "bad", "temp7_input": 0, "temp7_label": "Labeled zero"})
        results = agent.linux_readings(self.root)
        self.assertEqual(len(results), 7)
        nvme = [r for r in results if r["kind"] == "nvme"]
        self.assertNotEqual(nvme[0]["device"], nvme[1]["device"])
        self.assertNotIn("hwmon", nvme[0]["device"])
        self.assertEqual(nvme[0]["celsius"], 42.1)
        self.assertEqual(nvme[0]["max"], 85.0)
        self.assertIsNone(nvme[0]["crit"])
        self.assertEqual({r["label"] for r in results if r["kind"] == "gpu"}, {"edge", "junction"})
        self.assertEqual({r["label"] for r in results if r["kind"] == "cpu"}, {"Package id 0", "temp2", "Labeled zero"})
        zone = self.root / "class/thermal/thermal_zone0"
        zone.mkdir(parents=True)
        (zone / "type").write_text("acpitz")
        (zone / "temp").write_text("60000")
        self.assertEqual(len(agent.linux_readings(self.root)), 7, "thermal fallback must not duplicate hwmon")

    def test_thermal_fallback_and_virtualized_no_sensors(self):
        zone = self.root / "class/thermal/thermal_zone0"
        zone.mkdir(parents=True)
        (zone / "type").write_text("acpitz")
        (zone / "temp").write_text("51000")
        self.assertEqual(agent.linux_readings(self.root)[0]["kind"], "board")
        (zone / "temp").unlink()
        dmi = self.root / "class/dmi/id"
        dmi.mkdir(parents=True)
        (dmi / "product_name").write_text("Standard PC (Q35 + ICH9, 2009)")
        (dmi / "sys_vendor").write_text("QEMU")
        self.assertTrue(agent.virtualized(self.root))
        self.assertEqual(agent.linux_readings(self.root), [])

    def test_classification(self):
        for chip, kind in [("k10temp", "cpu"), ("zenpower", "cpu"), ("spd5118", "memory"), ("jc42", "memory"), ("pch_cannonlake", "board"), ("nct6798", "board"), ("it8792", "board"), ("iwlwifi_1", "network"), ("r8169_1", "network"), ("mt7921", "network"), ("mystery", "other")]:
            self.assertEqual(agent.kind_for(chip), kind)

    def test_nvidia_csv_na_and_driver_failure(self):
        readings, warnings = agent.parse_nvidia('0, "GPU, Test", 0000:01:00.0, 75, 90, 250, 30\n1, RTX, 0000:02:00.0, 62, [N/A], [N/A], [N/A]\n')
        self.assertEqual([r["celsius"] for r in readings], [75, 90, 62])
        self.assertIn("GPU, Test", readings[0]["label"])
        self.assertTrue(warnings)
        readings, warnings = agent.parse_nvidia("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\n")
        self.assertEqual(readings, [])
        self.assertTrue(warnings)

    def test_macmon_json_and_missing_path(self):
        self.assertEqual([r["celsius"] for r in agent.parse_macmon('{"temp":{"cpu_temp_avg":52.2,"gpu_temp_avg":45.6}}\n')], [52.2, 45.6])
        self.assertEqual(agent.parse_macmon("broken\n"), [])
        with patch.object(agent.shutil, "which", return_value=None), patch.object(agent.Path, "is_file", return_value=False):
            self.assertEqual(agent.mac_readings(), ([], ["macmon not installed"]))

    def test_macmon_stream_timeout_uses_first_sample(self):
        with patch.object(agent.shutil, "which", return_value="/test/macmon"), patch.object(agent.subprocess, "run", side_effect=subprocess.TimeoutExpired("macmon", 2, output=b'{"temp":{"cpu_temp_avg":55}}\n')) as run:
            readings, warnings = agent.mac_readings()
        self.assertEqual(readings[0]["celsius"], 55)
        self.assertEqual(warnings, [])
        self.assertEqual(run.call_args.kwargs["timeout"], 2)


class CollectorTests(unittest.TestCase):
    def test_hostile_labels_encoded_losslessly_no_sql_or_psql_injection(self):
        hostile = "quote'\", comma,\n\\.\n\\backslash\n'); DROP SCHEMA fountain CASCADE; --"
        data = payload()
        data["readings"][0]["label"] = hostile
        clean = collector.validate_payload(data)
        sample = dict(clean, host="Test", status="ok", error=None)
        sql = collector.sweep_sql([sample], AT, 180)
        encoded = hostile.encode().hex()
        self.assertIn("decode('" + encoded + "','hex')", sql)
        self.assertEqual(bytes.fromhex(encoded).decode(), hostile)
        self.assertNotIn("DROP SCHEMA", sql)
        self.assertNotIn("\\.", sql)
        self.assertTrue(sql.startswith("BEGIN;"))
        self.assertTrue(sql.endswith("COMMIT;"))
        self.assertIn("DELETE FROM fountain.host_temperature_samples", sql)

    def test_invalid_payload_rejected(self):
        for change in (dict(schema=2), dict(schema=True), dict(collected_at="bad"), dict(collected_at=None), dict(collected_at=123), dict(load1=float("nan")), dict(uptime_s=-1), dict(readings=[dict(payload()["readings"][0], celsius=float("inf"))]), dict(readings=[dict(payload()["readings"][0], label="nul\0")]), dict(readings=[dict(payload()["readings"][0], label="\ud800")])):
            with self.subTest(change=change), self.assertRaises((ValueError, KeyError)):
                collector.validate_payload(dict(payload(), **change))

    def test_probe_success_timeout_ssh_failure_and_bad_response(self):
        host = dict(name="Test", user="tester", host="localhost", port=22, jump="jump@relay:22")
        config = dict(key_path="/private/test-key")
        with patch.object(collector.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, json.dumps(payload()), "")) as run:
            sample = collector.probe(host, config)
        self.assertEqual(sample["status"], "ok")
        self.assertEqual(run.call_args.kwargs["timeout"], 25)
        self.assertIn("-J", run.call_args.args[0])
        self.assertNotIn("shell", run.call_args.kwargs)
        for result, expected in [(subprocess.CompletedProcess([], 255, "", "secret /key/path"), "unreachable"), (subprocess.CompletedProcess([], 1, "", "secret /key/path"), "error"), (subprocess.CompletedProcess([], 0, "bad json", ""), "error")]:
            with patch.object(collector.subprocess, "run", return_value=result):
                sample = collector.probe(host, config)
            self.assertEqual(sample["status"], expected)
            self.assertNotIn("/key/path", sample["error"])
            self.assertEqual(sample["readings"], [])
        with patch.object(collector.subprocess, "run", side_effect=subprocess.TimeoutExpired("ssh", 25)):
            self.assertEqual(collector.probe(host, config)["status"], "unreachable")

    def test_history_clamp_validation_and_buckets(self):
        for hours, clamped, bucket in [("-3", 1, 300), ("6", 6, 300), ("24", 24, 300), ("25", 25, 1800), ("168", 168, 1800), ("169", 169, 7200), ("9999", 720, 7200)]:
            self.assertEqual(collector.history_params({"hours": [hours]}), (clamped, None, bucket))
        self.assertEqual(collector.history_params({}), (24, None, 300))
        self.assertEqual(collector.history_params({"host": ["Fountain-One"]})[1], "Fountain-One")
        for query in ({"hours": ["abc"]}, {"hours": ["1.5"]}, {"host": ["x'; DROP"]}, {"host": ["a\n"]}, {"host": [""]}, {"host": ["a" * 65]}, {"bucket": ["10"]}):
            with self.subTest(query=query), self.assertRaises(ValueError):
                collector.history_params(query)

    def test_docker_roles_input_and_read_queries(self):
        db = collector.Database()
        with patch.object(collector.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, '{"hosts":[]}', "")) as run:
            self.assertEqual(db.latest(), {"hosts": []})
            self.assertIn("fountain_temps_reader", run.call_args.args[0])
            db.store([dict(collector.validate_payload(payload()), host="Test", status="ok", error=None)], AT, None)
            self.assertIn("fountain_temps_writer", run.call_args.args[0])
            self.assertEqual(run.call_args.args[0][-2:], ["-f", "-"])
            self.assertIn("BEGIN;", run.call_args.kwargs["input"])
        sql = collector.history_sql(AT, AT, "Test", 300)
        self.assertIn("floor(extract(epoch FROM sweep_at)/300)", sql)
        self.assertIn(collector.sql_text("Test"), sql)
        self.assertIn("last_good_at", collector.latest_sql())

    def test_memory_history_max_and_last_good_survives_failure(self):
        db = collector.MemoryDatabase()
        at = collector.iso(dt.datetime.now(collector.UTC).replace(second=0, microsecond=0))
        good = dict(collector.validate_payload(payload()), host="Test", status="ok", error=None)
        good["readings"].append(dict(good["readings"][0], celsius=70))
        db.store([good], at, 180)
        history = db.history(collector.iso(collector.parse_time(at) - dt.timedelta(hours=1)), at, "Test", 300)
        self.assertEqual(history["series"][0]["points"][0][1], 70)
        self.assertEqual(db.history(at, at, "Other", 300)["series"], [])
        db.store([dict(good, status="unreachable", readings=[], collected_at=None)], at, None)
        latest = db.latest()["hosts"][0]
        self.assertEqual(latest["last_good_at"], AT)
        self.assertEqual(latest["status"], "unreachable")
        self.assertIsNone(latest["max_celsius"])

    def test_retention_only_once_per_day_and_all_hosts_recorded(self):
        config = dict(hosts=[{"name": "A"}, {"name": "B"}], retention_days=180)
        db = unittest.mock.Mock()
        service = collector.Collector(config, TOKEN, db)
        with patch.object(collector, "probe", side_effect=lambda host, *_: dict(host=host["name"], status="unreachable", readings=[])):
            service.sweep(AT)
            self.assertEqual(len(db.store.call_args.args[0]), 2)
            self.assertEqual(db.store.call_args.args[2], 180)
            service.sweep(AT)
            self.assertIsNone(db.store.call_args.args[2])

    def test_loop_aligns_to_wall_clock_boundary(self):
        service = collector.Collector(dict(hosts=[], interval=300), TOKEN, collector.MemoryDatabase())
        now = collector.parse_time(AT).timestamp() + 17
        service.stop = unittest.mock.Mock()
        service.stop.is_set.side_effect = [False, True]
        with patch.object(collector.time, "time", return_value=now), patch.object(service, "sweep") as sweep, patch("builtins.print"):
            service.loop()
        sweep.assert_called_once_with(AT)
        service.stop.wait.assert_called_once_with(283)

    def test_storage_failure_does_not_advance_health_or_retention(self):
        db = unittest.mock.Mock()
        db.store.side_effect = RuntimeError("not persisted")
        service = collector.Collector(dict(hosts=[], retention_days=180), TOKEN, db)
        with self.assertRaises(RuntimeError):
            service.sweep(AT)
        self.assertIsNone(service.last_sweep_at)
        self.assertIsNone(service.last_retention_day)

    def test_config_token_mode_and_local_transport(self):
        with tempfile.TemporaryDirectory() as temp:
            token = Path(temp) / "token"
            token.write_text(TOKEN)
            token.chmod(0o600)
            config_path = Path(temp) / "config.json"
            config = dict(api_token_file=str(token), hosts=[dict(name="Test", transport="local")])
            config_path.write_text(json.dumps(config))
            self.assertEqual(collector.load_config(config_path, True)[1], TOKEN)
            token.chmod(0o644)
            with self.assertRaises(ValueError):
                collector.load_config(config_path, True)
            token.chmod(0o600)
            with self.assertRaises(ValueError):
                collector.load_config(config_path, False)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.service = collector.Collector(dict(hosts=[{"name": "Test"}]), TOKEN, collector.MemoryDatabase(), True)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), collector.handler_for(cls.service))
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()
        cls.url = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join()

    def request(self, path, token=None, method="GET"):
        request = Request(self.url + path, method=method, headers={"Authorization": "Bearer " + token} if token else {})
        try:
            response = urlopen(request, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            self.assertIn("application/json", response.headers["Content-Type"])
            return response.status, json.load(response)

    def test_auth_missing_wrong_right_and_health(self):
        self.assertEqual(self.request("/health")[0], 200)
        self.assertEqual(self.request("/v1/latest")[0], 401)
        self.assertEqual(self.request("/v1/latest", "wrong")[0], 401)
        self.assertEqual(self.request("/v1/latest", TOKEN), (200, {"sweep_at": None, "hosts": []}))
        self.assertEqual(self.request("/unknown")[0], 401)
        self.assertEqual(self.request("/unknown", TOKEN)[0], 404)
        self.assertEqual(self.request("/v1/latest", method="POST")[0], 401)
        self.assertEqual(self.request("/v1/latest", TOKEN, "POST")[0], 405)
        self.assertEqual(self.request("/v1/latest", method="UNSUPPORTED")[0], 401)

    def test_history_contract_and_invalid_query(self):
        status, body = self.request("/v1/history?hours=99999&host=Test", TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(body["bucket_seconds"], 7200)
        self.assertAlmostEqual((collector.parse_time(body["to"]) - collector.parse_time(body["from"])).total_seconds(), 720 * 3600)
        self.assertEqual(self.request("/v1/history?host=bad%27", TOKEN)[0], 400)
        self.assertEqual(self.request("/v1/history?hours=bad", TOKEN)[0], 400)
        self.assertEqual(self.request("/v1/history?bucket=1", TOKEN)[0], 400)


if __name__ == "__main__":
    unittest.main()
