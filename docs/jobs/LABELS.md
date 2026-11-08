# LABELS — single shared outlet-label store (fix replica split-brain)

You are the IMPLEMENTER. Write code yourself. Do NOT delegate or launch other agent CLIs. No ssh, deploy, DB access, commit or push.

## Bug
The Power app runs as two replicas (FountainOne, FountainTwo) behind Traefik round-robin; each has its own SQLite (`src/lib/db.ts`, tables `outlets` and `outlets_unit2`). A label edit lands on one replica; reads from the other show the old value. Operator saw Unit 2 #5 revert to "Shloimi".

## Fix
Make the label store shared, using the same FountainSelf data service and coolify-db `fountain` schema that the temperature collector (temps/collector/fountain-temps-collector, already in this repo — read it and temps/sql) uses.
1. `temps/sql/002_power_outlet_labels.sql` (idempotent): `fountain.power_outlet_labels(unit smallint not null check (unit in (1,2)), outlet smallint not null check (outlet between 1 and 8), label text not null, server text not null, sort_order int not null, updated_at timestamptz not null default now(), updated_by text, primary key(unit,outlet))`. New role `fountain_power_labels` LOGIN (passwordless, local-socket only like the others) with SELECT, INSERT, UPDATE on that table. Writer/reader temp roles get nothing on it.
2. Collector HTTP API (same daemon, same bearer token mechanism but a SEPARATE token file `/etc/fountain-temps/labels-token` so read-only temperature consumers cannot write labels; token optional → label routes return 503 if not configured):
   - `GET /v1/labels` → `{"labels":[{unit,outlet,label,server,sortOrder,updatedAt}]}`
   - `PUT /v1/labels/<unit>/<outlet>` JSON `{label, server}` → upsert, returns row. Validate unit 1|2, outlet 1..8, label/server: trimmed, 1..64 chars, reject control chars. Body ≤ 4 KiB. Use the same hex-encoding SQL safety approach.
   - `POST /v1/labels/seed` JSON `{"labels":[...]}` → insert rows ONLY where (unit,outlet) is missing (ON CONFLICT DO NOTHING); used for one-time migration from replicas. Return counts.
3. Power app: `src/lib/db.ts` label reads/writes go to the shared API when `POWER_LABELS_API_URL` + `POWER_LABELS_API_TOKEN` are set (server-side only; token never to browser). Keep the local SQLite as (a) a read-through cache: on successful shared read, write rows into local SQLite; (b) fallback for READS if the shared API is down (UI must show a small "labels read-only: shared store unavailable" notice); WRITES must fail with a clear error when the shared API is unreachable — never write locally only (that recreates split-brain). If env vars are unset, behave exactly as today (backward compatible).
   - On startup / first read, if the shared store returns zero rows for a unit, seed it from local SQLite via `/v1/labels/seed`. Both replicas may race to seed: seed is insert-if-missing, so this is safe — but replicas could disagree; seed must send `updatedAt` and the endpoint should, for conflicting seeds arriving before any PUT, keep the row with the newest updatedAt (implement as `ON CONFLICT DO UPDATE ... WHERE excluded.updated_at > power_outlet_labels.updated_at AND power_outlet_labels.updated_by = 'seed'`). Document.
   - Keep existing API shapes for `/power/api/outlets*` unchanged so the console keeps working; update the console only for the read-only notice/error.
4. Env docs: `.env.example`, README, docker-compose (`POWER_LABELS_API_URL: ${POWER_LABELS_API_URL:-}`, `POWER_LABELS_API_TOKEN: ${POWER_LABELS_API_TOKEN:-}`), temps/install.md section for labels (apply 002 SQL, create token file, env vars, rollback).

## Acceptance (paste real output into docs/jobs/LABELS-REPORT.md)
1. `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm build` all clean.
2. `python3 -m unittest discover -s temps/tests -v` — add tests: label validation (bad unit/outlet/length/control chars/oversize body), token separation (temps token cannot PUT labels; labels token can), seed conflict rule, hostile strings encoding.
3. Node test (extend `scripts/test_units.mjs` or new `scripts/test_labels.mjs`, run with `node`): with a stub HTTP server emulating the shared API — read uses shared rows; shared down → read falls back to SQLite + readOnly flag; write with shared down → error, local SQLite unchanged; env unset → legacy behaviour.
4. `git diff --stat`.
Then write `done` to `docs/jobs/LABELS.agent-done`.
