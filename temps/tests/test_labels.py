"""Label API tests use in-memory storage and mocked psql, never infrastructure."""
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from test_temperatures import collector, TOKEN, AT

LABEL_TOKEN = "labels-test-only-" + "y" * 32


def row(**changes):
    return dict(dict(unit=2, outlet=5, label="New label", server="Host description",
                     sortOrder=5, updatedAt=AT), **changes)


class LabelTests(unittest.TestCase):
    def test_validation(self):
        self.assertEqual(collector.validate_label(1, 8, row(label="  Host  "))["label"], "Host")
        for changes in (dict(unit=0), dict(unit=3), dict(unit=True), dict(unit="1"), dict(unit=1.0),
                        dict(outlet=0), dict(outlet=9), dict(outlet=True), dict(outlet="2"),
                        dict(label=""), dict(label=" "), dict(label="x" * 65), dict(label=None),
                        dict(server=""), dict(server="x" * 65), dict(server=1),
                        dict(label="\tHost"), dict(label="host\n"), dict(label="a\0b"),
                        dict(server="bad\x7f"), dict(server="bad\x85"), dict(label="\ud800")):
            data = row(**changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                collector.validate_label(data["unit"], data["outlet"], data)
        for changes in (dict(updatedAt=None), dict(updatedAt="2026-11-07 12:00:00"),
                        dict(sortOrder=True), dict(sortOrder=2**31)):
            data = row(**changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                collector.validate_label(data["unit"], data["outlet"], data, seed=True)

    def test_hostile_strings_encoding_and_roles(self):
        hostile = "'); DROP TABLE fountain.power_outlet_labels; --\\."
        clean = collector.validate_label(2, 5, row(label=hostile, server="quote'\\backslash 雪"), seed=True)
        sql = collector.label_upsert_sql([clean], seed=True)
        self.assertIn(collector.sql_text(hostile), sql)
        self.assertNotIn("DROP TABLE", sql)
        self.assertNotIn("\\.", sql)
        self.assertEqual(bytes.fromhex(hostile.encode().hex()).decode(), hostile)
        self.assertIn("excluded.updated_at > power_outlet_labels.updated_at", sql)
        self.assertIn("power_outlet_labels.updated_by = 'seed'", sql)
        self.assertIn("updated_by=excluded.updated_by", collector.label_upsert_sql([clean]))
        db = collector.Database()
        with patch.object(collector.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, '{}', '')) as run:
            db.labels()
            self.assertIn("fountain_power_labels", run.call_args.args[0])
            db.save_labels([clean], True)
            self.assertIn("fountain_power_labels", run.call_args.args[0])
            self.assertNotIn("fountain_temps_writer", run.call_args.args[0])
            self.assertIn("-q", run.call_args.args[0], "psql command tags must not contaminate JSON")

    def test_seed_conflicts_newest_wins_until_put_in_both_orders(self):
        old = row(updatedAt="2026-11-07T11:00:00Z", label="Old")
        new = row(label="Newest")
        for sequence in ([old, new], [new, old]):
            db = collector.MemoryDatabase()
            first = db.save_labels([sequence[0]], True)
            self.assertEqual(first, dict(inserted=1, updated=0, ignored=0))
            second = db.save_labels([sequence[1]], True)
            self.assertEqual(second["updated"], int(sequence[1] == new))
            self.assertEqual(db.labels()["labels"][0]["label"], "Newest")
            self.assertEqual(db.save_labels([new], True)["ignored"], 1)
            saved = db.save_labels([collector.validate_label(2, 5, row(label="Operator edit"))])
            self.assertEqual(saved["label"], "Operator edit")
            self.assertEqual(db.save_labels([row(updatedAt="2099-01-01T00:00:00Z")], True)["ignored"], 1)
            self.assertEqual(db.labels()["labels"][0]["label"], "Operator edit")
        self.assertEqual(db.save_labels([], True), dict(inserted=0, updated=0, ignored=0))

    def test_optional_private_and_separate_token_config(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            token, labels = root / "temps-token", root / "labels-token"
            token.write_text(TOKEN)
            token.chmod(0o600)
            config = root / "config.json"
            config.write_text(json.dumps(dict(hosts=[], api_token_file=str(token), labels_token_file=str(labels))))
            self.assertIsNone(collector.load_config(config, True)[0]["labels_token"])
            labels.write_text(LABEL_TOKEN)
            labels.chmod(0o600)
            self.assertEqual(collector.load_config(config, True)[0]["labels_token"], LABEL_TOKEN)
            labels.chmod(0o644)
            with self.assertRaises(ValueError):
                collector.load_config(config, True)
            labels.chmod(0o600)
            labels.write_text(TOKEN)
            with self.assertRaises(ValueError):
                collector.load_config(config, True)


class LabelHTTPTests(unittest.TestCase):
    def setUp(self):
        self.service = collector.Collector(dict(hosts=[], labels_token=LABEL_TOKEN), TOKEN, collector.MemoryDatabase(), True)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), collector.handler_for(self.service))
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()

    def request(self, path="/v1/labels", method="GET", token=LABEL_TOKEN, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = Request(self.url + path, method=method, data=data,
                          headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        try:
            response = urlopen(request, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            return response.status, json.load(response)

    def test_separate_tokens_and_unconfigured(self):
        self.assertEqual(self.request("/v1/labels/2/5", "PUT", TOKEN, row())[0], 401)
        self.assertEqual(self.request(token=TOKEN)[0], 401)
        self.assertEqual(self.request(token="")[0], 401)
        self.assertEqual(self.request("/v1/latest")[0], 401)
        self.assertEqual(self.request("/v1/labels/2/5", "PUT", body=row())[0], 200)
        self.assertEqual(self.request()[1]["labels"][0]["label"], "New label")
        self.assertEqual(self.request("/v1/latest", token=TOKEN)[0], 200)
        self.service.labels_token = None
        for method, path in (("GET", "/v1/labels"), ("PUT", "/v1/labels/1/1"), ("POST", "/v1/labels/seed")):
            self.assertEqual(self.request(path, method, body=row() if method != "GET" else None)[0], 503)

    def test_bad_payloads_and_size_limit(self):
        for path, body in (("/v1/labels/3/1", row()), ("/v1/labels/1/9", row()),
                           ("/v1/labels/0/1", row()), ("/v1/labels/1/0", row()),
                           ("/v1/labels/-1/1", row()), ("/v1/labels/1/nope", row()),
                           ("/v1/labels/1/1", row(label="x" * 65)), ("/v1/labels/1/1", row(server="bad\n")),
                           ("/v1/labels/1/1", [])):
            with self.subTest(path=path, body=body):
                self.assertEqual(self.request(path, "PUT", body=body)[0], 400)
        self.assertEqual(self.request("/v1/labels/1/1", "PUT", body=row(label="x" * 4096))[0], 413)
        self.assertEqual(self.request("/v1/labels/seed", "POST", body={"labels": [row(), row()]})[0], 400)
        self.assertEqual(self.request("/v1/labels/seed", "POST", body={"labels": [row(updatedAt="bad")]})[0], 400)
        self.assertEqual(self.service.database.labels(), {"labels": []})

    def test_seed_api_counts_and_put_protection(self):
        self.assertEqual(self.request("/v1/labels/seed", "POST", body={"labels": [row()]})[1],
                         dict(inserted=1, updated=0, ignored=0))
        newer = row(label="Newer seed", updatedAt="2026-11-08T00:00:00Z")
        self.assertEqual(self.request("/v1/labels/seed", "POST", body={"labels": [newer]})[1]["updated"], 1)
        self.assertEqual(self.request("/v1/labels/2/5", "PUT", body=row(label="  Operator edit  "))[1]["label"], "Operator edit")
        self.assertEqual(self.request("/v1/labels/seed", "POST", body={"labels": [newer]})[1]["ignored"], 1)
        self.assertEqual(self.request()[1]["labels"][0]["label"], "Operator edit")

    def test_storage_errors_do_not_leak_details(self):
        with patch.object(self.service.database, "save_labels", side_effect=RuntimeError("secret SQL")):
            status, body = self.request("/v1/labels/1/1", "PUT", body=row())
        self.assertEqual(status, 503)
        self.assertNotIn("secret", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
