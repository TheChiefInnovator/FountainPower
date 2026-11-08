"""Unit tests for CPU / memory / disk resource collection and validation."""
import datetime as dt
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    result = importlib.util.module_from_spec(spec)
    loader.exec_module(result)
    return result


agent = module("resources_agent", ROOT / "agent/fountain-temps")
collector = module("resources_collector", ROOT / "collector/fountain-temps-collector")
AT = "2026-11-08T12:00:00Z"
TOKEN = "resource-unit-test-" + "y" * 32
KIB = 1024


def stats(frsize, blocks, bfree, bavail):
    return type("Statvfs", (), dict(f_frsize=frsize, f_bsize=4096, f_blocks=blocks, f_bfree=bfree, f_bavail=bavail))()


def resource_payload():
    return dict(schema=1, collected_at=AT, virtualized=False, uptime_s=10, load1=0.2, warnings=[], readings=[],
                resources=dict(cpu=dict(usage_percent=12.5, cores=8, window_s=0.25),
                               memory=dict(total_bytes=1_000_000, used_bytes=400_000, available_bytes=600_000,
                                           swap_total_bytes=200_000, swap_used_bytes=50_000),
                               disks=[dict(mount="/", device="/dev/sda1", fstype="ext4",
                                           total_bytes=1_000_000, used_bytes=400_000, available_bytes=600_000)]))


class AgentResourceTests(unittest.TestCase):
    VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1000.
Pages active:                             2000.
Pages inactive:                           1500.
Pages speculative:                         500.
Pages wired down:                          800.
"Translation faults":                    12345.
Pages copy-on-write:                       100.
Pages purgeable:                           200.
Pages occupied by compressor:              300.
"""

    def test_proc_stat_and_cpu_usage_delta(self):
        self.assertEqual(agent.parse_proc_stat("cpu  100 0 50 850 0 0 0 0 0 0\ncpu0 1 2 3 4\n"), (1000, 850))
        self.assertEqual(agent.parse_proc_stat("cpu  100 0 50 850 0 0 0 0 40 10\n"), (1000, 850),
                         "guest/guest_nice are counted inside user/nice and must not be summed again")
        self.assertIsNone(agent.parse_proc_stat("intr 5\n"))
        self.assertIsNone(agent.parse_proc_stat("cpu  bad value here\n"))
        self.assertIsNone(agent.parse_proc_stat("cpu  1 2\n"))
        self.assertEqual(agent.cpu_usage((1000, 850), (2000, 1700)), 15.0)
        self.assertIsNone(agent.cpu_usage((2000, 1), (2000, 1)), "no elapsed jiffies is not a zero reading")
        self.assertIsNone(agent.cpu_usage(None, (1, 1)))
        self.assertEqual(agent.cpu_usage((0, 0), (1000, 2000)), 0.0, "idle accounting can never yield negative usage")

    def test_linux_cpu_samples_a_real_interval(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "stat"
            path.write_text("cpu  100 0 50 850 0 0 0 0 0 0\n")
            slept = []

            def sleep(seconds):
                slept.append(seconds)
                path.write_text("cpu  200 0 100 1700 0 0 0 0 0 0\n")

            cpu = agent.linux_cpu(path, sleep=sleep, seconds=0.25)
        self.assertEqual(cpu["usage_percent"], 15.0)
        self.assertEqual(cpu["cores"], agent.os.cpu_count())
        self.assertEqual(cpu["window_s"], 0.25)
        self.assertEqual(slept, [0.25], "the agent must sample twice around one bounded interval")
        with tempfile.TemporaryDirectory() as temp:
            missing = Path(temp) / "stat"
            self.assertIsNone(agent.linux_cpu(missing, sleep=lambda _: None))

    def test_meminfo_totals_swap_and_missing_metrics(self):
        text = ("MemTotal:       1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\n"
                "Buffers: 20 kB\nCached: 30 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n")
        memory = agent.memory_from_meminfo(text)
        self.assertEqual(memory["total_bytes"], 1000 * KIB)
        self.assertEqual(memory["available_bytes"], 600 * KIB)
        self.assertEqual(memory["used_bytes"], 400 * KIB, "used = total - available")
        self.assertEqual(memory["swap_total_bytes"], 200 * KIB)
        self.assertEqual(memory["swap_used_bytes"], 50 * KIB)
        fallback = agent.memory_from_meminfo("MemTotal: 1000 kB\nMemFree: 500 kB\nBuffers: 100 kB\nCached: 100 kB\n")
        self.assertEqual(fallback["available_bytes"], 700 * KIB)
        self.assertEqual(fallback["used_bytes"], 300 * KIB)
        self.assertIsNone(fallback["swap_total_bytes"], "no swap is null, never zero")
        self.assertIsNone(agent.memory_from_meminfo("MemFree: 10 kB\n"))
        self.assertIsNone(agent.memory_from_meminfo("MemTotal: 0 kB\n"))
        clamped = agent.memory_from_meminfo("MemTotal: 100 kB\nMemAvailable: 900 kB\n")
        self.assertEqual(clamped["available_bytes"], 100 * KIB)
        self.assertEqual(clamped["used_bytes"], 0)
        self.assertLessEqual(clamped["used_bytes"] + clamped["available_bytes"], clamped["total_bytes"])

    def test_unknown_swap_usage_stays_null(self):
        partial = agent.memory_from_meminfo("MemTotal: 1000 kB\nMemAvailable: 600 kB\nSwapTotal: 200 kB\n")
        self.assertEqual(partial["swap_total_bytes"], 200 * KIB)
        self.assertIsNone(partial["swap_used_bytes"], "a swap total without SwapFree is unknown, not zero")

    def test_mounts_exclude_pseudo_network_loop_and_duplicates(self):
        text = "\n".join([
            "/dev/sda2 / ext4 rw,relatime 0 0",
            "/dev/sda1 /boot/efi vfat rw 0 0",
            "/dev/nvme0n1p1 /data xfs rw 0 0",
            "proc /proc proc rw 0 0",
            "tmpfs /run tmpfs rw 0 0",
            "devtmpfs /dev devtmpfs rw 0 0",
            "overlay /var/lib/docker/overlay2/abc overlay rw 0 0",
            "server:/export /mnt/nfs nfs4 rw 0 0",
            "//host/share /mnt/smb cifs rw 0 0",
            "sshfs#user@host:/ /mnt/ssh fuse.sshfs rw 0 0",
            "/dev/loop0 /snap/core/1 squashfs ro 0 0",
            "/dev/sdb1 /data ext4 rw 0 0",
            "/dev/sda2 /var/lib/data ext4 rw 0 0",
            "/dev/sda3 /mnt/my\\040disk ext4 rw 0 0",
            "/dev/sda4 /mnt/back\\134slash ext4 rw 0 0",
        ])
        self.assertEqual(agent.parse_mounts(text), [
            ("/dev/sda2", "/", "ext4"),
            ("/dev/nvme0n1p1", "/data", "xfs"),
            ("/dev/sda1", "/boot/efi", "vfat"),
            ("/dev/sda3", "/mnt/my disk", "ext4"),
            ("/dev/sda4", "/mnt/back\\slash", "ext4"),
        ])
        self.assertEqual(agent.parse_mounts(""), [])

    def test_parse_mounts_unescapes_octal_for_statvfs(self):
        mounts = agent.parse_mounts("/dev/sda1 /mnt/my\\040disk ext4 rw 0 0\n")
        self.assertEqual(mounts, [("/dev/sda1", "/mnt/my disk", "ext4")])
        seen = []

        def statvfs(path):
            seen.append(path)
            return stats(4096, 100, 40, 30)

        disks = agent.disk_readings(mounts, statvfs)
        self.assertEqual(seen, ["/mnt/my disk"], "statvfs must receive the decoded path")
        self.assertEqual(disks[0]["mount"], "/mnt/my disk")

    def test_disk_readings_identity_dedupe_skip_and_cap(self):
        mounts = [("/dev/sda1", "/", "ext4"), ("/dev/sdb1", "/data", "xfs"),
                  ("/dev/sdc1", "/mnt/twin", "xfs"), ("/dev/sdd1", "/mnt/gone", "ext4")]
        table = {
            "/": stats(4096, 1000, 400, 300),
            "/data": stats(4096, 2000, 1000, 900),
            "/mnt/twin": stats(4096, 2000, 1000, 900),
        }

        def statvfs(path):
            if path not in table:
                raise OSError("permission denied")
            return table[path]

        disks = agent.disk_readings(mounts, statvfs)
        self.assertEqual([disk["mount"] for disk in disks], ["/", "/data", "/mnt/twin"],
                         "independent disks with identical capacity are all reported")
        root = disks[0]
        self.assertEqual(root["total_bytes"], 4096 * 1000)
        self.assertEqual(root["used_bytes"], 4096 * 600)
        self.assertEqual(root["available_bytes"], 4096 * 300)
        for disk in disks:
            self.assertLessEqual(disk["used_bytes"] + disk["available_bytes"], disk["total_bytes"])
        self.assertEqual(len(agent.disk_readings(mounts, statvfs, max_mounts=1)), 1)
        self.assertEqual(agent.disk_readings([("/dev/zero", "/zero", "ext4")], lambda _: stats(0, 0, 0, 0)), [])

    def test_disk_readings_dedupe_same_mount_or_device(self):
        mounts = [("/dev/sda1", "/", "ext4"), ("/dev/sda1", "/bind", "ext4"),
                  ("/dev/sdb1", "/", "xfs")]
        disks = agent.disk_readings(mounts, lambda _: stats(4096, 1000, 400, 300))
        self.assertEqual([disk["mount"] for disk in disks], ["/"],
                         "a repeated device (bind mount) or repeated mount is one disk")

    def test_mac_cpu_memory_and_swap_parsing(self):
        self.assertEqual(agent.parse_top_cpu("CPU usage: 5.00% user, 3.00% sys, 92.00% idle\n"
                                             "CPU usage: 10.00% user, 6.00% sys, 84.00% idle\n"), 16.0)
        self.assertIsNone(agent.parse_top_cpu("no samples yet\n"))
        self.assertEqual(agent.parse_ps_cpu("10.0\n30.0\n", 4), 10.0)
        self.assertEqual(agent.parse_ps_cpu("999.0\n", 1), 100.0, "fallback clamps to 100 percent")
        self.assertIsNone(agent.parse_ps_cpu("", 4))
        self.assertEqual(agent.swap_from_swapusage("total = 4096.00M  used = 1024.00M  free = 3072.00M  (encrypted)"),
                         (4096 * 1024 ** 2, 1024 * 1024 ** 2))
        self.assertEqual(agent.swap_from_swapusage("no swap configured"), (None, None))
        page, pages = agent.parse_vm_stat(self.VM_STAT)
        self.assertEqual(page, 16384)
        self.assertEqual(pages["pages free"], 1000)
        self.assertEqual(pages["translation faults"], 12345)
        memory = agent.memory_from_vm_stat(self.VM_STAT, 100_000_000, (1000, 400))
        self.assertEqual(memory["available_bytes"], 3000 * 16384, "free + speculative + inactive")
        self.assertEqual(memory["used_bytes"], 100_000_000 - 3000 * 16384)
        self.assertEqual(memory["swap_total_bytes"], 1000)
        self.assertEqual(memory["swap_used_bytes"], 400)
        self.assertIsNone(agent.memory_from_vm_stat(self.VM_STAT, None))
        self.assertIsNone(agent.memory_from_vm_stat("", 1000))

    def test_mac_mounts_local_only(self):
        text = "\n".join([
            "/dev/disk3s1s1 on / (apfs, local, read-only, journaled)",
            "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled)",
            "/dev/disk5s1 on /Volumes/Archive (apfs, local, journaled)",
            "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
            "server:/share on /mnt/net (nfs, nodev, nosuid)",
            "/dev/disk7s1 on /Volumes/image (cd9660, local, nodev, nosuid)",
        ])
        self.assertEqual(agent.parse_mac_mounts(text), [
            ("/dev/disk3s1s1", "/", "apfs"),
            ("/dev/disk5s1", "/Volumes/Archive", "apfs"),
        ])

    def test_mac_resources_report_null_when_tools_fail(self):
        with patch.object(agent.subprocess, "run", side_effect=OSError("blocked")):
            resources, warnings = agent.mac_resources()
        self.assertIsNone(resources["cpu"], "unavailable CPU is null, not zero")
        self.assertIsNone(resources["memory"])
        self.assertEqual(resources["disks"], [])
        self.assertEqual(len(warnings), 2)

    def test_collect_payload_includes_resources(self):
        with tempfile.TemporaryDirectory() as temp:
            proc = Path(temp)
            (proc / "meminfo").write_text("MemTotal: 1000 kB\nMemAvailable: 600 kB\n")
            (proc / "self").mkdir()
            (proc / "self/mounts").write_text("/dev/sda1 / ext4 rw 0 0\n")
            with patch.object(agent, "linux_cpu", return_value=dict(usage_percent=7.5, cores=2, window_s=0.25)), \
                 patch.object(agent.os, "statvfs", return_value=stats(4096, 100, 40, 30)):
                resources = agent.linux_resources(proc)
        self.assertEqual(resources["cpu"]["usage_percent"], 7.5)
        self.assertEqual(resources["memory"]["total_bytes"], 1000 * KIB)
        self.assertEqual([disk["mount"] for disk in resources["disks"]], ["/"])


class ResourceValidationTests(unittest.TestCase):
    def test_valid_resources_are_normalised(self):
        resources = collector.validate_resources(resource_payload()["resources"])
        self.assertEqual(resources["cpu"], dict(usage_percent=12.5, cores=8, window_s=0.25))
        self.assertEqual(resources["memory"]["used_bytes"], 400_000)
        self.assertEqual(resources["disks"], [dict(mount="/", device="/dev/sda1", fstype="ext4",
                                                   total_bytes=1_000_000, used_bytes=400_000, available_bytes=600_000)])
        self.assertIsNone(collector.validate_resources(None))
        self.assertEqual(collector.validate_resources({}), dict(cpu=None, memory=None, disks=[]))
        self.assertEqual(collector.validate_resources(dict(disks=[], memory=None, cpu=dict(usage_percent=0))),
                         dict(cpu=dict(usage_percent=0.0, cores=None, window_s=None), memory=None, disks=[]))

    def test_validation_keeps_unknown_swap_used_null(self):
        validated = collector.validate_memory(dict(total_bytes=1_000_000, used_bytes=100_000,
                                                   available_bytes=900_000, swap_total_bytes=200_000,
                                                   swap_used_bytes=None))
        self.assertEqual(validated["swap_total_bytes"], 200_000)
        self.assertIsNone(validated["swap_used_bytes"], "an unknown swap figure must stay null, not become zero")
        known = collector.validate_memory(dict(total_bytes=1_000_000, used_bytes=100_000,
                                               available_bytes=900_000, swap_total_bytes=200_000,
                                               swap_used_bytes=50_000))
        self.assertEqual(known["swap_used_bytes"], 50_000)

    def test_invalid_resources_are_rejected(self):
        base = resource_payload()["resources"]
        disk = dict(mount="/", device="/dev/sda", fstype="ext4", total_bytes=1_000_000, used_bytes=400_000, available_bytes=600_000)
        cases = [
            "not-a-dict",
            [],
            dict(base, cpu="missing"),
            dict(base, cpu=dict(usage_percent=None)),
            dict(base, cpu=dict(usage_percent=float("nan"))),
            dict(base, cpu=dict(usage_percent=float("inf"))),
            dict(base, cpu=dict(usage_percent=True)),
            dict(base, cpu=dict(usage_percent=101)),
            dict(base, cpu=dict(usage_percent=-0.5)),
            dict(base, cpu=dict(usage_percent=1, cores=0)),
            dict(base, cpu=dict(usage_percent=1, cores=5000)),
            dict(base, cpu=dict(usage_percent=1, cores="8")),
            dict(base, cpu=dict(usage_percent=1, window_s=0)),
            dict(base, cpu=dict(usage_percent=1, window_s=61)),
            dict(base, memory="missing"),
            dict(base, memory=dict(total_bytes=0, used_bytes=0, available_bytes=0)),
            dict(base, memory=dict(total_bytes=1_000_000, used_bytes=2_000_000, available_bytes=0)),
            dict(base, memory=dict(total_bytes=1_000_000, used_bytes=0, available_bytes=2_000_000)),
            dict(base, memory=dict(total_bytes=1_000_000, used_bytes=700_000, available_bytes=600_000)),
            dict(base, memory=dict(total_bytes=1_000_000, used_bytes=-1, available_bytes=1)),
            dict(base, memory=dict(total_bytes=1_000_000.0, used_bytes=0, available_bytes=0)),
            dict(base, memory=dict(total_bytes=1_000_000, used_bytes=None, available_bytes=0)),
            dict(base, memory=dict(total_bytes=1_000_000, used_bytes=0, available_bytes=1_000_000, swap_total_bytes=None, swap_used_bytes=5)),
            dict(base, memory=dict(total_bytes=1_000_000, used_bytes=0, available_bytes=1_000_000, swap_total_bytes=10, swap_used_bytes=20)),
            dict(base, disks={"mount": "/"}),
            dict(base, disks=[dict(disk, total_bytes=0)]),
            dict(base, disks=[dict(disk, used_bytes=800_000, available_bytes=800_000)]),
            dict(base, disks=[dict(disk, mount="")]),
            dict(base, disks=[dict(disk, mount="x" * 256)]),
            dict(base, disks=[dict(disk, mount="/a\0b")]),
            dict(base, disks=[dict(disk, fstype=5)]),
            dict(base, disks=[disk] * 33),
        ]
        for value in cases:
            with self.subTest(value=repr(value)[:70]), self.assertRaises(ValueError):
                collector.validate_resources(value)

    def test_payload_without_resources_still_valid(self):
        legacy = resource_payload()
        del legacy["resources"]
        self.assertIsNone(collector.validate_payload(legacy)["resources"], "an older agent must still be accepted")
        empty = resource_payload()
        empty["resources"] = None
        self.assertIsNone(collector.validate_payload(empty)["resources"])
        clean = collector.validate_payload(resource_payload())
        self.assertEqual(clean["resources"]["cpu"]["usage_percent"], 12.5)
        bad = resource_payload()
        bad["resources"] = {"cpu": {"usage_percent": 200}}
        with self.assertRaises(ValueError):
            collector.validate_payload(bad)


class ResourceSqlTests(unittest.TestCase):
    def test_sweep_sql_records_resource_columns_and_disk_rows(self):
        clean = collector.validate_payload(resource_payload())
        sql = collector.sweep_sql([dict(clean, host="HostA", status="ok", error=None)], AT, 180)
        self.assertTrue(sql.startswith("BEGIN;") and sql.endswith("COMMIT;"))
        self.assertEqual(sql.count("INSERT INTO fountain.host_temperature_samples"), 1)
        self.assertIn("cpu_percent,cpu_cores,cpu_window_s", sql)
        self.assertIn("memory_total_bytes,memory_used_bytes,memory_available_bytes,swap_total_bytes,swap_used_bytes", sql)
        self.assertIn("INSERT INTO fountain.host_disk_samples", sql)
        self.assertIn("DELETE FROM fountain.host_temperature_samples", sql)
        self.assertIn("400000::bigint", sql)

    def test_sweep_sql_null_resources_keeps_legacy_shape(self):
        clean = collector.validate_payload(dict(resource_payload(), resources=None))
        sample = dict(clean, host="Old", status="ok", error=None)
        sample["readings"] = [dict(kind="cpu", chip="k10temp", device="pci", label="Tctl", celsius=50.0, max=None, crit=None)]
        sql = collector.sweep_sql([sample], AT, None)
        self.assertNotIn("host_disk_samples", sql)
        self.assertIn("fountain.host_temperature_readings", sql)
        self.assertIn(",NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)", sql, "eight resource columns must be null")
        self.assertNotIn("DELETE FROM", sql)

    def test_hostile_mount_text_is_hex_encoded(self):
        hostile = "mount'); DROP TABLE fountain.host_disk_samples; --\n\\.\\"
        payload = resource_payload()
        payload["resources"]["disks"][0]["mount"] = hostile
        clean = collector.validate_payload(payload)
        sql = collector.sweep_sql([dict(clean, host="H", status="ok", error=None)], AT, None)
        self.assertIn("decode('" + hostile.encode().hex() + "','hex')", sql)
        self.assertNotIn("DROP TABLE", sql)
        self.assertNotIn("\\.", sql)

    def test_resource_history_sql_per_metric(self):
        cpu = collector.resource_history_sql("cpu", AT, AT, "HostA", 300)
        self.assertIn("fountain.host_temperature_samples", cpu)
        self.assertIn("avg(cpu_percent)", cpu)
        self.assertIn("cpu_percent IS NOT NULL", cpu)
        self.assertIn("'kind','cpu'", cpu)
        self.assertIn(collector.sql_text("HostA"), cpu)
        memory = collector.resource_history_sql("memory", AT, AT, "HostA", 300)
        self.assertIn("avg(100.0*memory_used_bytes/NULLIF(memory_total_bytes,0))", memory)
        self.assertIn("memory_total_bytes IS NOT NULL", memory)
        self.assertIn("'kind','memory'", memory)
        disk = collector.resource_history_sql("disk", AT, AT, None, 1800)
        self.assertIn("fountain.host_disk_samples", disk)
        self.assertIn("'mount',mount", disk)
        self.assertIn("floor(extract(epoch FROM sweep_at)/1800)", disk)
        self.assertNotIn("host=", disk, "no host restriction when none was requested")
        self.assertIn("GROUP BY host,mount", disk)

    def test_latest_sql_keeps_legacy_fields_and_adds_resources(self):
        sql = collector.latest_sql()
        for legacy in ("last_good_at", "max_celsius", "'readings'", "warnings", "uptime_s", "load1"):
            self.assertIn(legacy, sql)
        self.assertIn("'resources'", sql)
        self.assertIn("fountain.host_disk_samples", sql)

    def test_history_metric_validation(self):
        self.assertEqual(collector.history_metric({}), "temp")
        self.assertEqual(collector.history_metric({"metric": ["cpu"]}), "cpu")
        self.assertEqual(collector.history_metric({"metric": ["memory"]}), "memory")
        self.assertEqual(collector.history_metric({"metric": ["disk"]}), "disk")
        for query in ({"metric": ["Memory"]}, {"metric": ["reads"]}, {"metric": [""]}, {"metric": ["cpu "]}):
            with self.subTest(query=query), self.assertRaises(ValueError):
                collector.history_metric(query)
        self.assertEqual(collector.history_params({"hours": ["24"]}), (24, None, 300))

    def test_database_rejects_unknown_metric(self):
        with self.assertRaises(ValueError):
            collector.Database().history(AT, AT, None, 300, "bogus")
        with self.assertRaises(ValueError):
            collector.MemoryDatabase().history(AT, AT, None, 300, "bogus")


class MemoryResourceHistoryTests(unittest.TestCase):
    def sample(self, host, cpu, used, available, mock_at):
        return dict(host=host, status="ok", error=None, collected_at=mock_at, uptime_s=1, load1=0.1, warnings=[],
                    readings=[dict(kind="cpu", chip="coretemp", device="d", label="Package", celsius=60.0 + cpu, max=None, crit=None)],
                    resources=dict(cpu=dict(usage_percent=cpu, cores=4, window_s=0.25),
                                   memory=dict(total_bytes=1000, used_bytes=used, available_bytes=available,
                                               swap_total_bytes=None, swap_used_bytes=None),
                                   disks=[dict(mount="/", device="/dev/sda1", fstype="ext4", total_bytes=1000,
                                               used_bytes=used, available_bytes=available)]))

    def test_resource_history_averages_inside_a_bucket(self):
        db = collector.MemoryDatabase()
        now = dt.datetime.now(collector.UTC)
        first_at = dt.datetime.fromtimestamp(int(now.timestamp()) // 300 * 300, collector.UTC)
        at = collector.iso(first_at)
        later = collector.iso(first_at + dt.timedelta(seconds=120))
        db.store([self.sample("HostA", 10.0, 250, 750, at)], at, None)
        db.store([self.sample("HostA", 30.0, 750, 250, later)], later, None)
        start = collector.iso(first_at - dt.timedelta(hours=1))
        end = collector.iso(first_at + dt.timedelta(minutes=10))

        cpu = db.history(start, end, "HostA", 300, "cpu")
        self.assertEqual(cpu["metric"], "cpu")
        self.assertEqual(len(cpu["series"]), 1)
        self.assertEqual((cpu["series"][0]["host"], cpu["series"][0]["kind"]), ("HostA", "cpu"))
        self.assertEqual(cpu["series"][0]["points"][0][0], at)
        self.assertEqual(cpu["series"][0]["points"][0][1], 20.0)
        memory = db.history(start, end, "HostA", 300, "memory")
        self.assertEqual(memory["series"][0]["points"][0][1], 50.0)
        disk = db.history(start, end, "HostA", 300, "disk")
        self.assertEqual(disk["series"][0]["kind"], "disk")
        self.assertEqual(disk["series"][0]["mount"], "/")
        self.assertEqual(disk["series"][0]["points"][0][1], 50.0)

    def test_temperature_history_still_uses_bucket_maxima(self):
        db = collector.MemoryDatabase()
        now = dt.datetime.now(collector.UTC)
        first_at = dt.datetime.fromtimestamp(int(now.timestamp()) // 300 * 300, collector.UTC)
        at = collector.iso(first_at)
        later = collector.iso(first_at + dt.timedelta(seconds=120))
        db.store([self.sample("HostA", 10.0, 250, 750, at)], at, None)
        db.store([self.sample("HostA", 30.0, 750, 250, later)], later, None)
        history = db.history(collector.iso(first_at - dt.timedelta(hours=1)),
                             collector.iso(first_at + dt.timedelta(minutes=10)), "HostA", 300)
        self.assertEqual(history["metric"], "temp")
        self.assertEqual(history["series"][0]["points"][0][1], 90.0, "temperature keeps the interval peak")
        self.assertEqual(db.history(at, at, "Other", 300)["series"], [])

    def test_latest_exposes_resources(self):
        db = collector.MemoryDatabase()
        db.store([self.sample("HostA", 10.0, 250, 750, AT)], AT, None)
        host = db.latest()["hosts"][0]
        self.assertEqual(host["resources"]["cpu"]["usage_percent"], 10.0)
        self.assertEqual(host["resources"]["disks"][0]["mount"], "/")


class ResourceHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        clean = collector.validate_payload(resource_payload())
        db = collector.MemoryDatabase()
        db.store([dict(clean, host="HostA", status="ok", error=None)], collector.iso(dt.datetime.now(collector.UTC)), None)
        cls.service = collector.Collector(dict(hosts=[dict(name="HostA")]), TOKEN, db, True)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), collector.handler_for(cls.service))
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()
        cls.url = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join()

    def request(self, path, token=TOKEN):
        request = Request(self.url + path, headers={"Authorization": "Bearer " + token} if token else {})
        try:
            response = urlopen(request, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def test_history_metric_defaults_and_validation(self):
        status, body = self.request("/v1/history?hours=24")
        self.assertEqual(status, 200)
        self.assertEqual(body["metric"], "temp")
        self.assertEqual(self.request("/v1/history?metric=cpu")[1]["metric"], "cpu")
        self.assertEqual(self.request("/v1/history?metric=memory")[1]["metric"], "memory")
        self.assertEqual(self.request("/v1/history?metric=disk")[0], 200)
        self.assertEqual(self.request("/v1/history?metric=bogus")[0], 400)
        self.assertEqual(self.request("/v1/history?metric=cpu")[0], 200)

    def test_latest_exposes_resources_without_breaking_old_fields(self):
        status, body = self.request("/v1/latest")
        self.assertEqual(status, 200)
        host = body["hosts"][0]
        self.assertEqual(host["resources"]["cpu"]["usage_percent"], 12.5)
        self.assertEqual(host["resources"]["memory"]["total_bytes"], 1_000_000)
        self.assertEqual(host["resources"]["disks"][0]["mount"], "/")
        self.assertIsNone(host["max_celsius"], "legacy temperature fields are unchanged")


if __name__ == "__main__":
    unittest.main()
