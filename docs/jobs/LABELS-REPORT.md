# LABELS implementation report

Implemented the shared outlet-label store, collector routes, separate token and
role, SQLite read-through cache, read-only fallback notice, fail-closed shared
writes, and environment/installation/rollback documentation.

## Acceptance

- [x] `pnpm lint` — exit 0, no warnings.
- [x] `pnpm exec tsc --noEmit` — exit 0.
- [x] `pnpm build` — exit 0.
- [x] `python3 -m unittest discover -s temps/tests -v` — 26 tests pass,
  including eight new label tests covering validation/body limits, separate
  tokens, optional token configuration, seed conflict rules, SQL encoding and
  label-role selection.
- [x] `node scripts/test_labels.mjs` — shared reads/cache, unavailable and malformed
  shared reads, rejected writes with unchanged SQLite, successful shared writes,
  migration, replica seed reconciliation, Unicode body batching, connection
  refusal, and legacy mode all pass against a real local stub HTTP server.
- [x] `node scripts/test_units.mjs` — existing unit/control regression passes.
- [x] `git diff --check` — exit 0.
- [x] `git diff --stat` — captured below, followed by statistics for new files.

## Implementation details

The outlet API keeps its existing envelopes and fields; fallback rows add
`readOnly: true`, which drives the small console notice and disabled label edit
controls. A shared write failure returns a clear 503 error without updating
SQLite. Shared reads and successful writes refresh SQLite.

Each replica offers its original local snapshot on its first shared read per
unit, including when the other replica already seeded. This is necessary to
reconcile a later-starting replica's newer seed. Missing rows are inserted;
conflicting seeds replace only older rows marked `updated_by='seed'`. Equal
seed timestamps keep the existing row. Explicit PUTs mark rows `put` and cannot
be overwritten by later seeds. Empty or incomplete shared units retry seeding.
Naive SQLite timestamps are sent as UTC; UTF-8 seed batches stay within 4096 bytes.
These behaviors and migration prerequisites are documented in README and
`temps/install.md`.

No delegation, other agent CLI, SSH, deployment, external database access, commit,
or push was used. Python tests use in-memory storage/mocked psql; Node tests use
disposable SQLite databases and a loopback HTTP stub. The PostgreSQL migration
was not applied to infrastructure, as required by the job. Installation and
live replica verification remain operator-run deployment steps, outside this job.

## Real verification output

### `pnpm lint`

```text
$ pnpm lint
$ eslint
[exit 0]
```

### `pnpm exec tsc --noEmit`

```text
$ pnpm exec tsc --noEmit

[exit 0]
```

### `pnpm build`

```text
$ pnpm build
$ next build
▲ Next.js 16.2.10 (Turbopack)

  Creating an optimized production build ...
✓ Compiled successfully in 1554ms
  Running TypeScript ...
  Finished TypeScript in 1171ms ...
  Collecting page data using 12 workers ...
  Generating static pages using 12 workers (0/3) ...
✓ Generating static pages using 12 workers (3/3) in 203ms
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
[exit 0]
```

### `python3 -m unittest discover -s temps/tests -v`

```text
$ python3 -m unittest discover -s temps/tests -v
test_bad_payloads_and_size_limit (test_labels.LabelHTTPTests.test_bad_payloads_and_size_limit) ... ok
test_seed_api_counts_and_put_protection (test_labels.LabelHTTPTests.test_seed_api_counts_and_put_protection) ... ok
test_separate_tokens_and_unconfigured (test_labels.LabelHTTPTests.test_separate_tokens_and_unconfigured) ... ok
test_storage_errors_do_not_leak_details (test_labels.LabelHTTPTests.test_storage_errors_do_not_leak_details) ... ok
test_hostile_strings_encoding_and_roles (test_labels.LabelTests.test_hostile_strings_encoding_and_roles) ... ok
test_optional_private_and_separate_token_config (test_labels.LabelTests.test_optional_private_and_separate_token_config) ... ok
test_seed_conflicts_newest_wins_until_put_in_both_orders (test_labels.LabelTests.test_seed_conflicts_newest_wins_until_put_in_both_orders) ... ok
test_validation (test_labels.LabelTests.test_validation) ... ok
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
Ran 26 tests in 2.589s

OK
[exit 0]
```

### `node scripts/test_labels.mjs`

```text
$ node scripts/test_labels.mjs
PASS: shared reads override local rows, preserve ordering, and refresh SQLite cache.
PASS: unavailable/malformed shared reads fall back with readOnly; unavailable writes leave SQLite unchanged.
PASS: shared PUT trims/encodes text, updates cache, and validates before sending.
PASS: empty unit seeds from SQLite with timezone timestamps and rereads shared rows.
PASS: replicas reconcile newer seed timestamps; explicit PUT survives later seed offers.
PASS: Unicode migration batches stay within the collector 4 KiB body limit.
PASS: connection refusal uses cache for reads only; env unset restores legacy behavior.
[exit 0]
```

### `node scripts/test_units.mjs`

```text
$ node scripts/test_units.mjs
PASS: legacy labels preserved, unit edits isolated, invalid units/outlets rejected, unit 1 protection retained, unit 2 routed to bridge.
[exit 0]
```

### `git diff --check`

```text
$ git diff --check

[exit 0]
```

### `git diff --stat`

```text
$ git diff --stat
 .env.example                             |   4 +
 README.md                                |  22 ++++
 docker-compose.yml                       |   2 +
 scripts/test_units.mjs                   |  14 +--
 src/app/api/outlets/[outlet]/route.ts    |  21 ++--
 src/components/power-console.tsx         |  14 ++-
 src/lib/db.ts                            | 122 +++++++++++++++++++++-
 src/lib/power.ts                         |   2 +-
 temps/collector/fountain-temps-collector | 173 +++++++++++++++++++++++++++++--
 temps/install.md                         |  96 ++++++++++++++++-
 10 files changed, 438 insertions(+), 32 deletions(-)
[exit 0]
```

## New implementation files

`git diff --stat` omits untracked files; the working tree was left unstaged.
These additional real statistics cover the new implementation files:

```text
$ git diff --no-index --stat /dev/null scripts/test_labels.mjs
 /dev/null => scripts/test_labels.mjs | 173 +++++++++++++++++++++++++++++++++++
 1 file changed, 173 insertions(+)
[exit 1: differences found]

$ git diff --no-index --stat /dev/null temps/sql/002_power_outlet_labels.sql
 /dev/null => temps/sql/002_power_outlet_labels.sql | 32 ++++++++++++++++++++++
 1 file changed, 32 insertions(+)
[exit 1: differences found]

$ git diff --no-index --stat /dev/null temps/tests/test_labels.py
 /dev/null => temps/tests/test_labels.py | 166 ++++++++++++++++++++++++++++++++
 1 file changed, 166 insertions(+)
[exit 1: differences found]
```

The supplied `docs/jobs/LABELS.md` was left unchanged. This report and
`docs/jobs/LABELS.agent-done` are new delivery artifacts.
