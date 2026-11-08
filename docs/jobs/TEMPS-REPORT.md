# TEMPS implementation report

Implemented by this agent without delegation. All seven code/local acceptance items pass. No SSH, live database operations, deployments, commits or pushes were performed. Browser screenshots and fleet installation are left to the orchestrator, as the job specifies.

## Files created and changed

Created:

- `temps/agent/fountain-temps`: Linux/macOS read-only probe.
- `temps/collector/fountain-temps-collector`: threaded SSH collector, transaction builder, retention, authenticated read API, isolated dry-run mode.
- `temps/collector/hosts.example.json`: all 16 requested hosts with ports/users/kinds/notes and configuration defaults.
- `temps/collector/fountain-temps-collector.service`: root service with Docker/network dependencies and filesystem hardening.
- `temps/sql/001_fountain_temperatures.sql`: idempotent schema, tables, indexes and dedicated roles.
- `temps/install.md`: operator installation, forced commands, macOS interpreter/macmon setup, optional jump configuration, both Power instances, dry-run/fixture preview and rollback.
- `temps/tests/test_temperatures.py`: 18 tests using generated sysfs trees, mocked commands and real localhost HTTP requests.
- `temps/tests/fixture_collector.py`: standalone synthetic localhost collector for dashboard preview without fleet or DB access.
- `src/lib/temperatures.ts`: shared response types.
- `src/app/api/temperatures/route.ts`: session-protected server proxy; allowlisted upstream routes, bounded requests, server-only token and sanitized errors.
- `src/app/temperatures/page.tsx`: same session/launch-redirect behavior as the existing home page.
- `src/components/temperature-console.tsx`: fleet tiles, sensor detail, inline SVG history, range selection and refresh states.
- This report; `docs/jobs/TEMPS.agent-done` is written after the completed report.

Changed:

- `src/app/globals.css`: scoped instrument-panel styling and mobile/desktop layouts.
- `src/components/power-console.tsx`: added only the Temperatures navigation link.
- `.env.example`, `docker-compose.yml`, `README.md`: temperature connection variables and documentation.
- `.gitignore`, `eslint.config.mjs`: ignore macOS AppleDouble metadata; ignore Python bytecode in git.

`package.json`, `pnpm-lock.yaml`, existing auth, existing home-page logic and outlet API contents are unchanged. No npm or Python dependencies were added.

## Decisions and boundaries

- Physical sysfs device paths retain PCI/NVMe identity rather than unstable hwmon numbers. hwmon takes precedence over thermal zones. Temperatures outside (-40,150) are omitted; zero is retained only with an explicit label. NVIDIA missing fields produce warnings. QEMU/DMI identifies VMs; a valid empty probe remains successful.
- macmon uses PATH or the usual Homebrew locations. The streaming subprocess is bounded to two seconds, with its first complete JSON object parsed even on timeout. macOS uptime uses a separately bounded sysctl query. The local sandbox returned no uptime, so `uptime_s` is null in the captured Mac sample.
- Production collection always uses SSH, including FountainSelf's loopback entry. SSH gets a 25-second total timeout, 10-second connect timeout, dedicated identity, known-hosts file, accept-new host checking and optional ProxyJump. No remote command or agent arguments are sent. The forced-command agent ignores arguments and SSH_ORIGINAL_COMMAND.
- Sweeps run immediately on startup, labeled with the current five-minute boundary, then wait for subsequent wall-clock boundaries. Sixteen probes may run concurrently. Failed probes become samples with generic `unreachable`/`error` messages. Invalid timestamps, nonfinite values, NULs and invalid Unicode are rejected before persistence.
- All host text is encoded as UTF-8 hex and decoded by PostgreSQL in a safe literal expression. Quotes, commas, newlines, backslashes and a standalone backslash-dot cannot become SQL or psql metacommands. All rows in a sweep and the daily retention delete share one transaction. SQL goes through subprocess argv/stdin; no shell=True is used.
- Reader/writer roles are separate. The writer additionally gets DELETE on samples for retention; the FK cascades readings. An extra sample_id index supports latest reads and cascade deletes. Retention is configurable and runs once per successful UTC day. Failed persistence does not advance last-sweep health or retention state.
- The API derives last_good_at across stored successful samples, including successful hosts with no sensors. History clamps to 1–720 hours and groups maxima into 300/1800/7200-second buckets. The bearer comparison is constant-time. HTTP replies are JSON with no-store; logs never contain tokens or raw SSH errors.
- The dashboard uses restrained existing console colors, tabular monospace values, explicit 60/80/90-degree states, per-kind legends, 80/90-degree chart lines, time/value hover and keyboard inspection, gap-aware paths, per-host detail, loading/error/empty/missing-config states, stale-sweep indication and a 60-second refresh. CSS uses two fleet columns and one chart column on mobile and up to three chart columns on desktop. No visual screenshot claim is made.
- The initial worktree had 38 tracked executable-bit differences, numerous AppleDouble files and the untracked job spec. Those pre-existing artifacts were not reverted. The initial node_modules was a symlink to a different workspace. pnpm 11 attempted an automatic reinstall against a nonwritable store and failed; the link was replaced by a local ignored install using a writable /tmp store. Its original target was not modified. Raw git output below preserves the pre-existing mode differences; content-only output uses a per-command core.filemode=false override, without changing git configuration.

## Acceptance 1: install, lint, typecheck, production build

Python 3.13.7; Node v22.22.0; pnpm 11.10.0. Dependencies were installed locally with the frozen lockfile. The next build uses the repository's normal Turbopack command. Final exit codes: install=0, lint=0, tsc=0, build=0. The initial shared-symlink/store failure was resolved before these checks.

### Frozen install (output excerpt)

```text
$ pnpm install --frozen-lockfile --store-dir /tmp/fountain-temps-pnpm-store
Lockfile is up to date, resolution step is skipped
Packages: +357
dependencies:
+ class-variance-authority 0.7.1
+ clsx 2.1.1
+ lucide-react 1.24.0
+ next 16.2.10
+ react 19.2.4
+ react-dom 19.2.4
+ tailwind-merge 3.6.0
devDependencies:
+ @tailwindcss/postcss 4.3.2
+ @types/node 20.19.43
+ @types/react 19.2.17
+ @types/react-dom 19.2.3
+ eslint 9.39.5
+ eslint-config-next 16.2.10
+ tailwindcss 4.3.2
+ typescript 5.9.3
Done in 27.2s using pnpm v11.10.0
```

### Lint

```text
$ pnpm lint
$ eslint
```

```text
$ pnpm exec tsc --noEmit
(no output; exit 0)
```

### Production build

```text
$ pnpm build
$ next build
▲ Next.js 16.2.10 (Turbopack)

  Creating an optimized production build ...
✓ Compiled successfully in 2.2s
  Running TypeScript ...
  Finished TypeScript in 1241ms ...
  Collecting page data using 12 workers ...
  Generating static pages using 12 workers (0/3) ...
✓ Generating static pages using 12 workers (3/3) in 226ms
  Finalizing page optimization ...

Route (app)
┌ ƒ /
├ ○ /_not-found
├ ƒ /api/auth/launch
├ ƒ /api/health
├ ƒ /api/outlets
├ ƒ /api/outlets/[outlet]
├ ƒ /api/outlets/[outlet]/action
├ ƒ /api/temperatures
└ ƒ /temperatures


○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

## Acceptance 2: Python compilation

```text
$ python3 -m py_compile temps/agent/fountain-temps temps/collector/fountain-temps-collector
(no output; exit 0)
```

## Acceptance 3: unit tests

Tests include two separate NVMe devices, amdgpu edge/junction, coretemp, bogus values, missing labels, thermal fallback, virtualized empty sensors, NVIDIA CSV/N/A/driver errors, macmon JSON/timeout/missing executable, hostile SQL labels, schema validation, failed probes, dedicated DB roles, token file mode, wall-clock alignment, daily retention, last-good preservation, API authentication and history boundaries.

### Test output

```text
$ python3 -m unittest discover -s temps/tests -v
test_classification (test_temperatures.AgentTests.test_classification) ... ok
test_hwmon_two_nvme_gpu_cpu_bogus_and_missing_labels (test_temperatures.AgentTests.test_hwmon_two_nvme_gpu_cpu_bogus_and_missing_labels) ... ok
test_macmon_json_and_missing_path (test_temperatures.AgentTests.test_macmon_json_and_missing_path) ... ok
test_macmon_stream_timeout_uses_first_sample (test_temperatures.AgentTests.test_macmon_stream_timeout_uses_first_sample) ... ok
test_nvidia_csv_na_and_driver_failure (test_temperatures.AgentTests.test_nvidia_csv_na_and_driver_failure) ... ok
test_thermal_fallback_and_virtualized_no_sensors (test_temperatures.AgentTests.test_thermal_fallback_and_virtualized_no_sensors) ... ok
test_config_token_mode_and_local_transport (test_temperatures.CollectorTests.test_config_token_mode_and_local_transport) ... ok
test_docker_roles_input_and_read_queries (test_temperatures.CollectorTests.test_docker_roles_input_and_read_queries) ... ok
test_history_clamp_validation_and_buckets (test_temperatures.CollectorTests.test_history_clamp_validation_and_buckets) ... ok
test_hostile_labels_encoded_losslessly_no_sql_or_psql_injection (test_temperatures.CollectorTests.test_hostile_labels_encoded_losslessly_no_sql_or_psql_injection) ... ok
test_invalid_payload_rejected (test_temperatures.CollectorTests.test_invalid_payload_rejected) ... ok
test_loop_aligns_to_wall_clock_boundary (test_temperatures.CollectorTests.test_loop_aligns_to_wall_clock_boundary) ... ok
test_memory_history_max_and_last_good_survives_failure (test_temperatures.CollectorTests.test_memory_history_max_and_last_good_survives_failure) ... ok
test_probe_success_timeout_ssh_failure_and_bad_response (test_temperatures.CollectorTests.test_probe_success_timeout_ssh_failure_and_bad_response) ... ok
test_retention_only_once_per_day_and_all_hosts_recorded (test_temperatures.CollectorTests.test_retention_only_once_per_day_and_all_hosts_recorded) ... ok
test_storage_failure_does_not_advance_health_or_retention (test_temperatures.CollectorTests.test_storage_failure_does_not_advance_health_or_retention) ... ok
test_auth_missing_wrong_right_and_health (test_temperatures.HTTPTests.test_auth_missing_wrong_right_and_health) ... ok
test_history_contract_and_invalid_query (test_temperatures.HTTPTests.test_history_contract_and_invalid_query) ... ok

----------------------------------------------------------------------
Ran 18 tests in 0.529s

OK
```

## Acceptance 4: local Mac agent

One JSON object was emitted, with exit 0 in under five seconds. macmon is not installed on this Mac.

### Agent output

```text
$ python3 temps/agent/fountain-temps
{"schema":1,"hostname":"Big-Bird.local","collected_at":"2026-11-08T05:03:37.314658Z","virtualized":false,"readings":[],"warnings":["macmon not installed"],"uptime_s":null,"load1":5.37}
Elapsed: 0.037s; exit=0
```

## Acceptance 5: local collector dry-run and curl

Started with a generated temporary 0600 token file and a single `LocalMac` host using `transport: local`. No SSH or Docker subprocess was executed. Config and credentials stayed under /tmp. Startup output:

```text
$ python3 temps/collector/fountain-temps-collector --dry-run --config /tmp/fountain-temps-evidence/collector.json
sweep 2026-11-08T05:00:00Z: 1 hosts recorded
```

The following are real curl responses from port 13096. The authorized calls supplied the temporary token in the Authorization header; its value is intentionally omitted. Hours=9999 clamps to 720 hours/7200-second buckets.

### HTTP responses

```text
$ curl -i <local collector endpoint> [Authorization header when indicated]
health
HTTP/1.0 200 OK
Server: FountainTemps/1 Python/3.13.7
Date: Sun, 08 Nov 2026 05:03:37 GMT
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Content-Length: 60

{"ok":true,"last_sweep_at":"2026-11-08T05:00:00Z","hosts":1}

latest without token
HTTP/1.0 401 Unauthorized
Server: FountainTemps/1 Python/3.13.7
Date: Sun, 08 Nov 2026 05:03:37 GMT
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Content-Length: 24

{"error":"Unauthorized"}

latest wrong token
HTTP/1.0 401 Unauthorized
Server: FountainTemps/1 Python/3.13.7
Date: Sun, 08 Nov 2026 05:03:37 GMT
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Content-Length: 24

{"error":"Unauthorized"}

latest authorized
HTTP/1.0 200 OK
Server: FountainTemps/1 Python/3.13.7
Date: Sun, 08 Nov 2026 05:03:37 GMT
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Content-Length: 314

{"sweep_at":"2026-11-08T05:00:00Z","hosts":[{"host":"LocalMac","status":"ok","error":null,"collected_at":"2026-11-08T05:03:06.735420Z","readings":[],"warnings":["macmon not installed"],"uptime_s":null,"load1":6.07,"sweep_at":"2026-11-08T05:00:00Z","last_good_at":"2026-11-08T05:03:06.735420Z","max_celsius":null}]}

history authorized
HTTP/1.0 200 OK
Server: FountainTemps/1 Python/3.13.7
Date: Sun, 08 Nov 2026 05:03:37 GMT
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Content-Length: 107

{"bucket_seconds":7200,"series":[],"from":"2026-10-09T05:03:37.272994Z","to":"2026-11-08T05:03:37.272994Z"}

invalid host
HTTP/1.0 400 Bad Request
Server: FountainTemps/1 Python/3.13.7
Date: Sun, 08 Nov 2026 05:03:37 GMT
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Content-Length: 38

{"error":"Invalid history parameters"}
```

## Acceptance 6: dashboard and authenticated proxy

The production build was served using `pnpm start --hostname 127.0.0.1 --port 13098` against the synthetic collector on port 13097. A second production server on port 13099 had both temperature env vars absent. A generated test session used the exact existing HMAC cookie format; no auth code was modified. curl did not follow redirects or invoke any outlet APIs with an authenticated session, so no outlet database/control operation occurred.

The probe asserted identical unauthenticated redirects for /power and /power/temperatures, a 200 authenticated temperature page, 401 API without a session, successful proxy data/history for every selector and clamping, a working host filter, 400 on invalid parameters, a 200 missing-config page and 503 missing-config API. It also asserted that the collector token did not occur in any response body. The history bodies below are summaries extracted from real curl JSON; only the first two points of the first series are printed to keep the report readable. Status/headers and latest data are actual output.

### Dashboard HTTP evidence

```text
$ curl <local Power routes> [generated session cookie when indicated]
outlets-unauth
HTTP/1.1 307 Temporary Redirect
Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding
location: http://127.0.0.1:13098/power/api/auth/launch
X-Powered-By: Next.js
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
Content-Type: text/html; charset=utf-8
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



temperatures-unauth
HTTP/1.1 307 Temporary Redirect
Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding
location: http://127.0.0.1:13098/power/api/auth/launch
X-Powered-By: Next.js
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
Content-Type: text/html; charset=utf-8
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



temperatures-auth
HTTP/1.1 200 OK
Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding
X-Powered-By: Next.js
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
Content-Type: text/html; charset=utf-8
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



Authenticated HTML excerpts: <h1>Temperatures</h1> ; <div class="temp-state" role="status">Loading fleet temperatures…</div>

proxy-unauth
HTTP/1.1 401 Unauthorized
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"error":"Unauthorized"}

proxy-latest
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"sweep_at":"2026-11-08T05:00:00Z","hosts":[{"host":"FountainOne","status":"ok","error":null,"collected_at":"2026-11-08T05:00:00Z","uptime_s":123456,"load1":1.23,"readings":[{"kind":"cpu","chip":"fixture","device":"pci-0000:00:00.0","label":"CPU fixture sensor","celsius":56.4,"max":null,"crit":95},{"kind":"gpu","chip":"fixture","device":"pci-0000:00:00.0","label":"GPU fixture sensor","celsius":74.4,"max":null,"crit":95},{"kind":"nvme","chip":"fixture","device":"pci-0000:00:00.0","label":"NVME fixture sensor","celsius":46.4,"max":null,"crit":95}],"warnings":[],"sweep_at":"2026-11-08T05:00:00Z","last_good_at":"2026-11-08T05:00:00Z","max_celsius":74.4},{"host":"FountainTwo","status":"ok","error":null,"collected_at":"2026-11-08T05:00:00Z","uptime_s":123456,"load1":1.23,"readings":[{"kind":"cpu","chip":"fixture","device":"pci-0000:01:00.0","label":"CPU fixture sensor","celsius":64.5,"max":null,"crit":95},{"kind":"gpu","chip":"fixture","device":"pci-0000:01:00.0","label":"GPU fixture sensor","celsius":82.5,"max":null,"crit":95},{"kind":"nvme","chip":"fixture","device":"pci-0000:01:00.0","label":"NVME fixture sensor","celsius":54.5,"max":null,"crit":95}],"warnings":[],"sweep_at":"2026-11-08T05:00:00Z","last_good_at":"2026-11-08T05:00:00Z","max_celsius":82.5},{"host":"HappyBird","status":"ok","error":null,"collected_at":"2026-11-08T05:00:00Z","uptime_s":123456,"load1":1.23,"readings":[],"warnings":["Virtual machine; no temperature sensors"],"sweep_at":"2026-11-08T05:00:00Z","last_good_at":"2026-11-08T05:00:00Z","max_celsius":null},{"host":"OfflineHost","status":"unreachable","error":"SSH connection failed","collected_at":null,"uptime_s":null,"load1":null,"readings":[],"warnings":[],"sweep_at":"2026-11-08T05:00:00Z","last_good_at":"2026-11-08T01:55:00Z","max_celsius":null}]}

proxy-history-6
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"hours_requested": 6, "bucket_seconds": 300, "series": 9, "first_series": {"host": "FountainOne", "kind": "cpu", "points": [["2026-11-07T23:05:00Z", 64.6], ["2026-11-07T23:10:00Z", 64.4]]}, "from": "2026-11-07T23:04:11.232243Z", "to": "2026-11-08T05:04:11.232243Z"}

proxy-history-24
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"hours_requested": 24, "bucket_seconds": 300, "series": 9, "first_series": {"host": "FountainOne", "kind": "cpu", "points": [["2026-11-07T05:05:00Z", 53], ["2026-11-07T05:10:00Z", 53.8]]}, "from": "2026-11-07T05:04:11.244489Z", "to": "2026-11-08T05:04:11.244489Z"}

proxy-history-168
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"hours_requested": 168, "bucket_seconds": 1800, "series": 9, "first_series": {"host": "FountainOne", "kind": "cpu", "points": [["2026-11-07T05:00:00Z", 56.2], ["2026-11-07T05:30:00Z", 60.4]]}, "from": "2026-11-01T05:04:11.260096Z", "to": "2026-11-08T05:04:11.260096Z"}

proxy-history-720
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"hours_requested": 720, "bucket_seconds": 7200, "series": 9, "first_series": {"host": "FountainOne", "kind": "cpu", "points": [["2026-11-07T04:00:00Z", 60.4], ["2026-11-07T06:00:00Z", 65]]}, "from": "2026-10-09T05:04:11.274503Z", "to": "2026-11-08T05:04:11.274503Z"}

proxy-history-9999
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"hours_requested": 9999, "bucket_seconds": 7200, "series": 9, "first_series": {"host": "FountainOne", "kind": "cpu", "points": [["2026-11-07T04:00:00Z", 60.4], ["2026-11-07T06:00:00Z", 65]]}, "from": "2026-10-09T05:04:11.287561Z", "to": "2026-11-08T05:04:11.287561Z"}

proxy-history-filter
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



Host filter: 3 series, all FountainOne

proxy-invalid-host
HTTP/1.1 400 Bad Request
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"error":"Invalid history parameters"}

proxy-invalid-hours
HTTP/1.1 400 Bad Request
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"error":"Invalid history parameters"}

proxy-invalid-bucket
HTTP/1.1 400 Bad Request
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"error":"Invalid history parameters"}

proxy-invalid-view
HTTP/1.1 400 Bad Request
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"error":"Invalid view"}

missing-config-page
HTTP/1.1 200 OK
Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding
X-Powered-By: Next.js
Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate
Content-Type: text/html; charset=utf-8
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



Missing-config HTML: <h2>Temperature service not configured</h2>

missing-config-api
HTTP/1.1 503 Service Unavailable
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
cache-control: no-store
content-type: application/json
Date: Sun, 08 Nov 2026 05:04:11 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked



{"error":"Temperature service not configured"}
All dashboard HTTP assertions passed.
```

## Acceptance 7: scope and git output

Git status and diff --stat are captured below. Raw output includes the pre-existing mode-only differences recorded before implementation; content-only output shows the seven intended tracked changes plus new temperature source/artifacts. Git diff --stat excludes untracked files, so the status listing is also included. The original untracked docs/jobs/TEMPS.md is input, unchanged. The report itself is listed before the final sentinel is written.

Verified byte-for-byte against HEAD: package.json, pnpm-lock.yaml, src/lib/auth.ts, src/app/page.tsx, src/app/api/outlets/route.ts. A complete content comparison of tracked files identified only the seven files listed in the content-only diff stat. `git diff --check` passes.

```text
$ git status --short --untracked-files=all
 M .dockerignore
 M .env.example
 M .gitignore
 M Dockerfile
 M README.md
 M docker-compose.yml
 M ecosystem.config.cjs
 M eslint.config.mjs
 M next.config.ts
 M package.json
 M pnpm-lock.yaml
 M pnpm-workspace.yaml
 M postcss.config.mjs
 M public/file.svg
 M public/globe.svg
 M public/next.svg
 M public/vercel.svg
 M public/window.svg
 M scripts/serial_bridge.py
 M scripts/test_serial_bridge.py
 M scripts/test_units.mjs
 M src/app/api/auth/launch/route.ts
 M src/app/api/health/route.ts
 M src/app/api/outlets/[outlet]/action/route.ts
 M src/app/api/outlets/[outlet]/route.ts
 M src/app/api/outlets/route.ts
 M src/app/favicon.ico
 M src/app/globals.css
 M src/app/layout.tsx
 M src/app/page.tsx
 M src/components/power-console.tsx
 M src/lib/auth.ts
 M src/lib/db.ts
 M src/lib/input-supply.ts
 M src/lib/power.ts
 M src/lib/units.ts
 M src/lib/utils.ts
 M tsconfig.json
?? docs/jobs/TEMPS-REPORT.md
?? docs/jobs/TEMPS.md
?? src/app/api/temperatures/route.ts
?? src/app/temperatures/page.tsx
?? src/components/temperature-console.tsx
?? src/lib/temperatures.ts
?? temps/agent/fountain-temps
?? temps/collector/fountain-temps-collector
?? temps/collector/fountain-temps-collector.service
?? temps/collector/hosts.example.json
?? temps/install.md
?? temps/sql/001_fountain_temperatures.sql
?? temps/tests/fixture_collector.py
?? temps/tests/test_temperatures.py
```

```text
$ git diff --stat
 .dockerignore                                |   0
 .env.example                                 |   3 +
 .gitignore                                   |   2 +
 Dockerfile                                   |   0
 README.md                                    |   4 ++
 docker-compose.yml                           |   2 +
 ecosystem.config.cjs                         |   0
 eslint.config.mjs                            |   1 +
 next.config.ts                               |   0
 package.json                                 |   0
 pnpm-lock.yaml                               |   0
 pnpm-workspace.yaml                          |   0
 postcss.config.mjs                           |   0
 public/file.svg                              |   0
 public/globe.svg                             |   0
 public/next.svg                              |   0
 public/vercel.svg                            |   0
 public/window.svg                            |   0
 scripts/serial_bridge.py                     |   0
 scripts/test_serial_bridge.py                |   0
 scripts/test_units.mjs                       |   0
 src/app/api/auth/launch/route.ts             |   0
 src/app/api/health/route.ts                  |   0
 src/app/api/outlets/[outlet]/action/route.ts |   0
 src/app/api/outlets/[outlet]/route.ts        |   0
 src/app/api/outlets/route.ts                 |   0
 src/app/favicon.ico                          | Bin 25931 -> 25931 bytes
 src/app/globals.css                          |  85 +++++++++++++++++++++++++++
 src/app/layout.tsx                           |   0
 src/app/page.tsx                             |   0
 src/components/power-console.tsx             |   3 +
 src/lib/auth.ts                              |   0
 src/lib/db.ts                                |   0
 src/lib/input-supply.ts                      |   0
 src/lib/power.ts                             |   0
 src/lib/units.ts                             |   0
 src/lib/utils.ts                             |   0
 tsconfig.json                                |   0
 38 files changed, 100 insertions(+)
```

```text
$ git -c core.filemode=false status --short --untracked-files=all
 M .env.example
 M .gitignore
 M README.md
 M docker-compose.yml
 M eslint.config.mjs
 M src/app/globals.css
 M src/components/power-console.tsx
?? docs/jobs/TEMPS-REPORT.md
?? docs/jobs/TEMPS.md
?? src/app/api/temperatures/route.ts
?? src/app/temperatures/page.tsx
?? src/components/temperature-console.tsx
?? src/lib/temperatures.ts
?? temps/agent/fountain-temps
?? temps/collector/fountain-temps-collector
?? temps/collector/fountain-temps-collector.service
?? temps/collector/hosts.example.json
?? temps/install.md
?? temps/sql/001_fountain_temperatures.sql
?? temps/tests/fixture_collector.py
?? temps/tests/test_temperatures.py
```

```text
$ git -c core.filemode=false diff --stat
 .env.example                     |  3 ++
 .gitignore                       |  2 +
 README.md                        |  4 ++
 docker-compose.yml               |  2 +
 eslint.config.mjs                |  1 +
 src/app/globals.css              | 85 ++++++++++++++++++++++++++++++++++++++++
 src/components/power-console.tsx |  3 ++
 7 files changed, 100 insertions(+)
```

```text
$ git -c core.filemode=false diff --check
(no output; exit 0)
```

## Remaining operator verification

No acceptance command was skipped. The job explicitly excludes browser screenshots here; the orchestrator should check the 390 px and 1440 px layouts and client interactions using the supplied fixture server. Applying SQL, verifying in-container socket trust, installing forced keys/agents, verifying Omen's port, enabling the service, configuring private-network access and deploying both Power instances remain operator actions after review. No live DB or fleet connectivity is claimed. All temporary local servers used for acceptance were stopped. The completion sentinel is written after this report.
