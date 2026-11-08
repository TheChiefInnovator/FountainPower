#!/usr/bin/env python3
"""Local dashboard preview with synthetic data. Never connects to fleet/DB."""
import argparse
import datetime as dt
from http.server import ThreadingHTTPServer
import importlib.machinery
import importlib.util
import math
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--port", type=int, default=3097)
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1] / "collector/fountain-temps-collector"
    loader = importlib.machinery.SourceFileLoader("fixture_collector_core", str(source))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    core = importlib.util.module_from_spec(spec)
    loader.exec_module(core)
    token = Path(args.token_file).read_text().strip()
    db = core.MemoryDatabase()
    names = ["FountainOne", "FountainTwo", "HappyBird", "OfflineHost"]
    now = dt.datetime.now(core.UTC)
    now = dt.datetime.fromtimestamp(int(now.timestamp()) // 300 * 300, core.UTC)
    for step in range(288):
        at = core.iso(now - dt.timedelta(minutes=5 * (287 - step)))
        samples = []
        for index, name in enumerate(names):
            readings = []
            resources = None
            failed = name == "OfflineHost" and step > 250
            if not failed:
                if name != "HappyBird":
                    for kind, offset in (("cpu", 0), ("gpu", 18), ("nvme", -10)):
                        readings.append(dict(kind=kind, chip="fixture", device=f"pci-0000:0{index}:00.0", label=f"{kind.upper()} fixture sensor",
                                             celsius=round(53 + offset + 12 * math.sin(step / 15 + index), 1), max=None, crit=95))
                memory_total = 16 * 1024 ** 3
                memory_used = int(min(0.95, max(0.10, 0.50 + 0.30 * math.sin(step / 17 + index))) * memory_total)
                swap_total = 4 * 1024 ** 3
                disks = []
                if name != "HappyBird":
                    for mount, device, total, ratio in (("/", "/dev/nvme0n1p2", 500 * 1024 ** 3, 0.62),
                                                        ("/data", "/dev/nvme1n1p1", 2000 * 1024 ** 3, 0.41)):
                        used = int(min(0.97, max(0.05, ratio + 0.12 * math.sin(step / 23 + index))) * total)
                        disks.append(dict(mount=mount, device=device, fstype="btrfs" if mount == "/" else "xfs",
                                          total_bytes=total, used_bytes=used, available_bytes=total - used))
                resources = dict(
                    cpu=dict(usage_percent=round(min(100.0, max(0.0, 28 + 22 * math.sin(step / 9 + index))), 1),
                             cores=[4, 8, 16, 8][index], window_s=0.25),
                    memory=dict(total_bytes=memory_total, used_bytes=memory_used, available_bytes=memory_total - memory_used,
                                swap_total_bytes=swap_total, swap_used_bytes=int(0.05 * swap_total)),
                    disks=disks)
            samples.append(dict(host=name, status="unreachable" if failed else "ok", error="SSH connection failed" if failed else None,
                                collected_at=None if failed else at, uptime_s=None if failed else 123456, load1=None if failed else 1.23,
                                readings=readings, resources=resources,
                                warnings=["Virtual machine; no temperature sensors"] if name == "HappyBird" else []))
        db.store(samples, at, None)
    service = core.Collector(dict(hosts=[dict(name=name) for name in names]), token, db, True)
    service.last_sweep_at = core.iso(now)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), core.handler_for(service))
    print(f"Synthetic collector listening on 127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
