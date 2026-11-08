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
            failed = name == "OfflineHost" and step > 250
            if name != "HappyBird" and not failed:
                for kind, offset in (("cpu", 0), ("gpu", 18), ("nvme", -10)):
                    readings.append(dict(kind=kind, chip="fixture", device=f"pci-0000:0{index}:00.0", label=f"{kind.upper()} fixture sensor",
                                         celsius=round(53 + offset + 12 * math.sin(step / 15 + index), 1), max=None, crit=95))
            samples.append(dict(host=name, status="unreachable" if failed else "ok", error="SSH connection failed" if failed else None,
                                collected_at=None if failed else at, uptime_s=None if failed else 123456, load1=None if failed else 1.23,
                                readings=readings, warnings=["Virtual machine; no temperature sensors"] if name == "HappyBird" else []))
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
