# TEMPS — Fleet temperature collection + /power/temperatures dashboard

You are the IMPLEMENTER. Write the code yourself. Do NOT delegate, do not launch any other agent CLI (codex, claude, grok, opencode), and do not write a handoff spec instead of code. Any CLAUDE.md/AGENTS.md "delegation policy" you read does not apply to you.

This job is CODE ONLY inside this git worktree (`/Volumes/EXTREME/Worktrees/fountainstack/power-temps`, Next.js 16 app "FountainPower", basePath `/power`). You do NOT deploy anything, do NOT ssh anywhere, do NOT touch any database, do NOT push or commit. The orchestrator deploys after review.

## Context
Fountain fleet = ~15 Linux/macOS hosts. Every 5 minutes we want every machine's temperatures sampled and stored in a NEW table in the Coolify Postgres DB (`coolify-db` container, postgres:15-alpine, on FountainSelf 192.168.1.110, DB `coolify`, reachable only via `docker exec -i coolify-db psql ...` on FountainSelf — it is NOT exposed on the LAN). The Power app runs on FountainOne/FountainTwo (192.168.1.111/.112 :3091) and therefore cannot reach the DB directly; it reads via a small token-protected HTTP read API served by the collector on FountainSelf.

Architecture (pull model):
1. `temps/agent/fountain-temps` — Python 3 stdlib-only script installed on each host at `/usr/local/bin/fountain-temps`. Prints ONE JSON object to stdout and exits 0. Invoked by the collector via SSH with a forced-command key (authorized_keys `command="/usr/local/bin/fountain-temps",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,restrict`), so it must ignore SSH_ORIGINAL_COMMAND and take no args.
2. `temps/collector/fountain-temps-collector` — Python 3 stdlib-only long-running daemon on FountainSelf (systemd service, runs as root because it uses `docker exec`). Loop: every 300 s (aligned to wall-clock 5-min boundaries) SSH to every host in parallel (thread pool, per-host timeout 25 s, `ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -i <key> [-J jump] -p <port> user@host`), parse JSON, insert rows. A host that fails/times out still gets a row recorded with status `unreachable`/`error` (so downtime is visible). Also serves HTTP read API (see contract) on a configured bind address (default `192.168.1.110:3096`), using `http.server.ThreadingHTTPServer`.
3. DB writes/reads through `docker exec -i coolify-db psql -X -v ON_ERROR_STOP=1 -U <role> -d coolify` (subprocess, never shell=True). Inserts via a single transaction per sweep using `\copy ... from stdin with (format csv)` or parametrised-safe literal escaping — must be injection-safe (sensor labels come from hosts; treat as untrusted). Reads via `psql -At -c "<select ... json_agg ...>"` returning JSON. Use dedicated roles (below), not the `coolify` superuser.
4. Dashboard page `/power/temperatures` in the Next app + server route `/power/api/temperatures` that requires the existing Power session (same as other API routes — study `src/lib/auth.ts`, `src/app/page.tsx`, `src/app/api/outlets/route.ts` and replicate their auth exactly) and proxies server-side to the collector API with bearer token from env `POWER_TEMPS_API_URL` (e.g. `http://192.168.1.110:3096`) and `POWER_TEMPS_API_TOKEN`. Token never reaches the browser. Add a nav link between the existing outlets console and the temperatures page.

## Host inventory (config file, not hard-coded logic)
Ship `temps/collector/hosts.example.json` with these entries (name, host, port, user, optional jump, kind):
- FountainSelf 127.0.0.1:50122 omarchy (local; collector may also just run the agent locally for itself — your choice, document it)
- FountainOne 192.168.1.111:50122 omarchy; FountainTwo .112; FountainThree .113; FountainFour .114; FountainFive .115; FountainSix .116; FountainNine 192.168.1.119
- FountainTwenty 192.168.1.130, FountainTwentyOne .131, FountainTwentyTwo .132, FountainTwentyThree .133 (port 50122, omarchy)
- HappyBird 192.168.1.125:50122 omarchy (QEMU VM — no sensors expected; should report status `ok` with zero readings and `virtualized: true`)
- Omen 10.66.66.2:50144? — UNKNOWN port on wireguard; put `"host": "10.66.66.2", "port": 50122, "user": "miles"` and mark `"note": "verify"`
- FountainSeven 192.168.1.117:22 user `mac` (macOS Apple M3 Ultra, kind `macos`)
- FountainEight 192.168.1.118:50122 omarchy (`"note": "Colima VM on FountainSeven; often down"`)
Collector config path `/etc/fountain-temps/collector.json` (hosts list, key path `/etc/fountain-temps/id_ed25519`, bind, api token file `/etc/fountain-temps/api-token` mode 0600, interval). Never log the token.

## Agent output (Linux)
Read `/sys/class/hwmon/hwmon*/` : `name`, every `temp*_input` (millidegree → °C float, 1 decimal), matching `temp*_label`, `temp*_max`, `temp*_crit` when present. Device identity: resolve `device` symlink to stable id (e.g. PCI address / nvme name) so two `nvme` chips are distinguishable. Also `/sys/class/thermal/thermal_zone*/{type,temp}` ONLY if no hwmon readings at all (avoid duplicates). GPUs: if `nvidia-smi` exists and works, `nvidia-smi --query-gpu=index,name,pci.bus_id,temperature.gpu,temperature.memory,power.draw,fan.speed --format=csv,noheader,nounits` (2 s timeout; tolerate "[N/A]" and driver-failure text → skip, add a `warnings` entry). amdgpu is already in hwmon (edge/junction/mem labels). Classify each reading `kind`: cpu (k10temp, coretemp, zenpower), gpu (amdgpu, nvidia), nvme, memory (spd5118, jc42), board (acpitz, pch_*, nct*, it87*), network (r8169*, iwlwifi*, mt79*), other. Omit obviously bogus values (<=-40 or >=150 °C, or exactly 0 from coretemp unused cores? — keep 0 only if label exists; your judgement, document).
Schema: `{"schema":1,"hostname":"...","collected_at":"ISO8601Z","virtualized":bool,"readings":[{"kind":"cpu","chip":"k10temp","device":"pci-0000:00:18.3","label":"Tctl","celsius":54.2,"max":null,"crit":95.0}],"warnings":[...]}`. Also include `uptime_s` and `load1`.
macOS branch (same script, detect `sys.platform=="darwin"`): try `macmon pipe -s 1` (JSON; fields like `temp.cpu_temp_avg`, `temp.gpu_temp_avg`) — if not installed, emit zero readings and a warning `macmon not installed`. Do not require sudo.
Must finish < 5 s; must never hang (timeouts on every subprocess).

## DB schema — `temps/sql/001_fountain_temperatures.sql` (idempotent)
- `create schema if not exists fountain;` (own schema so Coolify migrations never collide)
- `fountain.host_temperature_samples` (id bigserial pk, sweep_at timestamptz not null, collected_at timestamptz, host text not null, status text not null check in ('ok','unreachable','error'), error text, uptime_s bigint, load1 real, readings_count int, warnings jsonb) — one row per host per sweep.
- `fountain.host_temperature_readings` (sample_id bigint references samples on delete cascade, host text, sweep_at timestamptz, kind text, chip text, device text, label text, celsius real not null, max_c real, crit_c real) + indexes (host, sweep_at desc), (sweep_at).
- Roles: `fountain_temps_writer` (NOLOGIN? — no: LOGIN without password, local socket trust inside container is fine) with usage on schema + insert/select on tables + usage on sequences; `fountain_temps_reader` select only. Use `do $$ ... if not exists` guards.
- Retention: collector deletes samples older than 180 days once per day (configurable).

## Collector HTTP API contract (bearer token required on every route except /health)
- `GET /health` → `{"ok":true,"last_sweep_at":...,"hosts":N}`
- `GET /v1/latest` → `{"sweep_at":..., "hosts":[{"host","status","error","collected_at","uptime_s","load1","max_celsius","readings":[...]}]}` (latest sample per host)
- `GET /v1/history?hours=24&host=<optional>&bucket=<auto>` → per host, per kind, time-bucketed max °C series: `{"from","to","bucket_seconds","series":[{"host","kind","points":[[iso,maxC],...]}]}`. Clamp hours to 1..720; bucket auto = 300 s ≤ 24 h, 1800 s ≤ 7 d, else 7200 s. Validate `host` against `^[A-Za-z0-9-]{1,64}$`.
Constant-time token compare. JSON only. Never expose SSH errors containing paths beyond a short sanitized message.

## Dashboard (UI)
Match the existing Power console's visual language (read `src/components/power-console.tsx`, `src/app/globals.css`) — this is a dense operational tool: scanability, restrained colour, repeated-use ergonomics, lucide icons. Design direction: "industrial instrument panel" — monospace numerals (tabular-nums), one hot accent ramp for temperature (cool→amber→red at thresholds: <60 normal, 60–79 warm, 80–89 hot, ≥90 critical; GPU/NVMe use same), no purple/blue gradients, no decorative blobs, no nested cards.
- Top: fleet strip — one tile per host: name, status (ok/unreachable with age of last good sample), hottest reading big, CPU/GPU/NVMe max small. Sort hottest first; unreachable hosts flagged clearly.
- Range selector 6h / 24h / 7d / 30d; per-host small-multiples line charts of max °C by kind. Implement charts as hand-rolled inline SVG (no new chart dependency) with axis ticks, threshold lines at 80/90, hover tooltip showing time + value, and series colours distinct per kind with a legend.
- Click a host tile → detail panel listing every current reading (kind, chip, device, label, °C, crit).
- Auto-refresh every 60 s; show "last sweep" time; loading/error/empty states. Responsive at 390 px wide and 1440 px wide; text must not overflow.
- Env var docs: add `POWER_TEMPS_API_URL`, `POWER_TEMPS_API_TOKEN` to `.env.example`/README and to `docker-compose.yml` environment (as `${POWER_TEMPS_API_URL}` / `${POWER_TEMPS_API_TOKEN}`). If the env vars are missing, the page must render a clear "temperature service not configured" state, not crash.

## Install artifacts
- `temps/collector/fountain-temps-collector.service` (systemd, Restart=always, RestartSec=10, After=docker.service, sane hardening that still allows docker exec + ssh).
- `temps/install.md`: exact steps for (a) applying the SQL, (b) generating the ed25519 key, (c) installing agent + authorized_keys forced-command line on each host (Linux and macOS incl. `brew install macmon`), (d) installing the collector + config + token, (e) Coolify env vars for the two Power instances, (f) rollback.

## HARD RULES
1. No new npm dependencies for charts; keep package.json deps unchanged unless absolutely needed (justify in report).
2. Python: stdlib only, Python ≥3.11, no shell=True.
3. No secrets in repo. Tokens/keys referenced by path only.
4. Do not modify the existing outlet control logic or auth semantics.
5. Do not commit or push.

## Acceptance — run and paste real output into the report
1. `pnpm install --frozen-lockfile` (if node_modules missing) then `pnpm lint` → 0 errors; `pnpm exec tsc --noEmit` → 0 errors; `pnpm build` → success (this is a small app; building it here is allowed).
2. `python3 -m py_compile temps/agent/fountain-temps temps/collector/fountain-temps-collector`.
3. Unit tests `python3 -m unittest discover -s temps/tests -v` covering: hwmon parsing against a fake sysfs tree fixture (incl. two nvme chips, amdgpu edge/junction, coretemp, bogus values, missing labels), nvidia-smi CSV parsing incl. "[N/A]" and driver-failure text, macmon JSON parsing + missing-macmon path, SQL/CSV escaping of hostile labels (quotes, commas, newlines, backslashes, `\.`), API auth (missing/wrong/right token), history param clamping/validation, bucket selection.
4. Run the agent locally on this Mac (`python3 temps/agent/fountain-temps`) and paste output (macmon is probably not installed → warning path is fine).
5. Collector: start it locally against a stub (e.g. `--dry-run` flag that skips docker/psql and uses a fake host list running the agent locally via a `local` transport) and curl `/health`, `/v1/latest` with and without token; paste output.
6. Dashboard: with `next dev` or `next start` and a stub collector (you may add a tiny fixture mode to the stub), curl `/power/temperatures` HTML to show it renders without the session redirect only if that's how the existing page behaves; otherwise show the redirect behaviour matches `/power`. (Browser screenshots are not possible in your sandbox — orchestrator will do visual verification.)
7. `git status` + `git diff --stat` showing only intended files.

## Report
Write `docs/jobs/TEMPS-REPORT.md`: files created/changed, design decisions, acceptance outputs, anything skipped and why. Then write `done` to `docs/jobs/TEMPS.agent-done`.
