# Fleet temperatures: install and rollback

These are operator-run instructions after code review. Python 3.11+ is required
on the collector and every probed host. No Python packages are needed. Nothing in
the installation changes outlet control or exposes PostgreSQL on the LAN.

## 1. Apply the schema on FountainSelf

From a reviewed checkout copied to FountainSelf, run as root (or prefix Docker
commands with sudo). This is the only step that uses the existing database admin
role. Check the container's configured admin role if it differs from `coolify`.

```sh
docker exec -i coolify-db psql -X -v ON_ERROR_STOP=1 -U coolify -d coolify < temps/sql/001_fountain_temperatures.sql
docker exec -i coolify-db psql -X -v ON_ERROR_STOP=1 -U coolify -d coolify < temps/sql/003_fountain_host_resources.sql
docker exec -i coolify-db psql -X -v ON_ERROR_STOP=1 -U fountain_temps_writer -d coolify -c 'SELECT count(*) FROM fountain.host_temperature_samples'
docker exec -i coolify-db psql -X -v ON_ERROR_STOP=1 -U fountain_temps_reader -d coolify -c 'SELECT count(*) FROM fountain.host_temperature_readings'
docker exec -i coolify-db psql -X -v ON_ERROR_STOP=1 -U fountain_temps_reader -d coolify -c 'SELECT count(*) FROM fountain.host_disk_samples'
```

The migrations are transactional and idempotent. **Apply 003 before deploying the
updated collector**: it adds the CPU/memory/swap columns to the existing sample
rows and the `fountain.host_disk_samples` table that the new latest, history and
sweep queries reference. Rows collected before 003 simply have NULL resources, so
all existing history keeps working unchanged. Re-running 001 or 003 is harmless.

Dedicated LOGIN roles have no password and depend on the container's existing
**local Unix socket trust**. Verify that policy before installation; do not
enable network trust or expose a database port. The writer has INSERT/SELECT,
sequence USAGE and DELETE on samples for retention; the reader has SELECT only.
The cascading foreign key removes readings and disk rows when their sample
expires. The extra `sample_id` indexes also keep latest reads and retention
deletes efficient. Table-level privileges from 001 already cover the new sample
columns, so 003 only grants the writer INSERT/SELECT and the reader SELECT on
`fountain.host_disk_samples`.

## 2. Generate the restricted probe key on FountainSelf

```sh
install -d -m 0700 /etc/fountain-temps
ssh-keygen -t ed25519 -N '' -C fountain-temps-collector -f /etc/fountain-temps/id_ed25519
chmod 0600 /etc/fountain-temps/id_ed25519
touch /etc/fountain-temps/known_hosts
chmod 0600 /etc/fountain-temps/known_hosts
cat /etc/fountain-temps/id_ed25519.pub
```

Keep the private key only on FountainSelf. The collector uses SSH even for
FountainSelf (`127.0.0.1:50122`), so install its public key there too. Verify host
key fingerprints using your normal trusted channel before first collection;
`accept-new` accepts new hosts but rejects changed keys. An optional `jump` such
as `temps-relay` uses SSH ProxyJump; configure that alias in root-owned
`/etc/ssh/ssh_config.d/fountain-temps.conf` with its `HostName`, `User`, `Port`,
separate `IdentityFile`, `IdentitiesOnly yes`, and
`UserKnownHostsFile /etc/fountain-temps/known_hosts`. OpenSSH does not inherit the
target's command-line identity settings for a jump. Limit the jump key's
forwarding rights to the required target. A key forced to run the probe cannot
itself serve as a jump key; the unit does not read `/root/.ssh`.

## 3. Install the agent on every host

On Linux, copy the reviewed `temps/agent/fountain-temps` to the host, then:

```sh
python3 --version # must be >= 3.11
sudo install -o root -g root -m 0755 temps/agent/fountain-temps /usr/local/bin/fountain-temps
/usr/local/bin/fountain-temps
```

For macOS (FountainSeven, SSH user `mac`), install Homebrew tools as that user:

```sh
brew install python@3.13 macmon
sudo mkdir -p /usr/local/bin
sudo install -o root -g wheel -m 0755 temps/agent/fountain-temps /usr/local/bin/fountain-temps
# Pin the interpreter because the system Python may be too old under SSH.
brew_python="$(brew --prefix python@3.13)/bin/python3.13"
sudo sed -i '' "1s|.*|#!${brew_python}|" /usr/local/bin/fountain-temps
/usr/local/bin/fountain-temps
```

The agent checks Homebrew's usual macmon locations as well as PATH; macmon runs
without sudo. Missing macmon produces a valid sample with zero readings and
`macmon not installed`. `macmon pipe -s 1` is killed after two seconds; its first
complete JSON line is used. No sudo sensor helpers are installed.

For each host, as the inventory's SSH user, create `~/.ssh` mode 0700 and
`~/.ssh/authorized_keys` mode 0600. **Append** the following single line, replacing
the placeholder with the public key from step 2 (preserve existing login keys):

```text
command="/usr/local/bin/fountain-temps",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,restrict ssh-ed25519 <PUBLIC_KEY_BASE64> fountain-temps-collector
```

The binary must be root-owned and not writable by the SSH user. The script
ignores arguments and `SSH_ORIGINAL_COMMAND`. Read access to sysfs normally needs
no privileges. Test from FountainSelf, using each inventory port/user/host:

```sh
ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o UserKnownHostsFile=/etc/fountain-temps/known_hosts -i /etc/fountain-temps/id_ed25519 -p 50122 omarchy@192.168.1.111
```

Linux readings at or below -40°C or at or above 150°C are omitted. Unlabeled zero
readings are omitted; explicitly labeled zero readings are retained. Thermal
zones are fallback-only. Physical sysfs device paths distinguish matching chips.
NVIDIA unavailable fields are skipped with warnings. QEMU/DMI detection marks
HappyBird as virtualized; a valid empty probe is status `ok`.

### Resource metrics: CPU, memory and filesystems

Every sample also carries a `resources` object. A metric that cannot be read is
`null`, never `0`, and every probe has a timeout. A host with no temperature
sensors (a VM such as HappyBird) still reports CPU, memory and disk; only its
temperature readings are empty.

**CPU is short-interval usage, not load average.** On Linux the agent reads
`/proc/stat`, sleeps `CPU_SAMPLE_SECONDS` (0.25 s by default), reads it again and
reports the busy share of the elapsed jiffies (idle + iowait subtracted),
clamped to 0–100; `window_s` records that window. This is a 0.25-second snapshot
of a five-minute sweep, so it can differ from the interval average — for
capacity trends prefer the history chart, which averages each bucket. On macOS
the equivalent is one interval sample from `top -l 2 -n 0 -s 1` (`window_s`
1.0), with a bounded `ps -A -o %cpu=` fallback normalised by logical core count
and reported as `window_s: null` because `ps` is a decay average.

**Memory definition.** On Linux, `total_bytes` is `MemTotal` and `used_bytes` is
`MemTotal − MemAvailable` (kB converted to bytes); if the kernel has no
`MemAvailable`, `MemFree + Buffers + Cached` is used instead. Swap is reported
only when `SwapTotal` exists: a host without swap reports `swap_total_bytes` of
`0` (a genuine zero), while an unreadable metric stays `null`. On macOS,
`total_bytes` is `sysctl hw.memsize`, `available_bytes` is
`(Pages free + Pages speculative + Pages inactive) × page size` from `vm_stat`,
`used_bytes` is `total − available`, and swap comes from `sysctl vm.swapusage`.

**Filesystem definition.** Disk figures come from `statvfs` on each local mount:
`available_bytes` is `f_bavail` (space an unprivileged writer can actually use),
`used_bytes` is `total − f_bfree`, and `used + available ≤ total` is always true.
Only allowlisted real filesystems are reported (`ext2/3/4`, `xfs`, `btrfs`,
`f2fs`, `bcachefs`, `zfs`, `vfat`, `msdos`, `exfat`, `ntfs`/`ntfs3`, `jfs`,
`reiserfs`, `ufs`, `hfs`/`hfsplus`, `apfs`), so network mounts (`nfs`, `cifs`,
`sshfs`), pseudo filesystems (`proc`, `sysfs`, `tmpfs`, `devtmpfs`, `overlay`,
`cgroup`), `/dev/loop` devices and pseudo mount trees (`/proc`, `/sys`, `/dev`,
`/run`, `/snap`, `/var/lib/docker`, `/System/Volumes`, CoreSimulator images) are
excluded. `/proc/self/mounts` octal escapes (`\040` space and friends) are decoded
before `statvfs`, so paths with spaces work. Duplicate mount points and repeated
devices (bind mounts) are collapsed by identity — two independent filesystems are
never dropped just because they report an identical capacity — and at most 32
filesystems are reported. A mount that cannot be statvfs'd is skipped, never
zeroed. The collector re-validates each host's report: at most 32 filesystems,
255-character mount/device/filesystem text, finite and in-range percentages, and
consistent totals (`used + available ≤ total`) for memory and every filesystem.

## 4. Install and configure the collector on FountainSelf

```sh
install -d -m 0755 /usr/local/lib/fountain-temps
install -m 0755 temps/collector/fountain-temps-collector /usr/local/lib/fountain-temps/fountain-temps-collector
install -m 0600 temps/collector/hosts.example.json /etc/fountain-temps/collector.json
umask 077
python3 -c 'import secrets; from pathlib import Path; Path("/etc/fountain-temps/api-token").write_text(secrets.token_urlsafe(48) + "\n")'
chmod 0600 /etc/fountain-temps/api-token
install -m 0644 temps/collector/fountain-temps-collector.service /etc/systemd/system/fountain-temps-collector.service
```

Edit `/etc/fountain-temps/collector.json` before starting if inventory or bind
addresses differ. Verify Omen's WireGuard SSH port (example 50122 is unconfirmed).
FountainEight may be down. Then start the collector:

```sh
systemctl daemon-reload
systemctl enable --now fountain-temps-collector
systemctl status fountain-temps-collector
journalctl -u fountain-temps-collector -n 30 --no-pager
curl --fail http://192.168.1.110:3096/health
```

All 16 specified hosts, ports, users and notes are in
the example; `kind` is operator metadata, and the agent detects its own platform.
Production transport is always forced-command SSH. `interval` defaults to 300
seconds; `retention_days` defaults to 180. Retention runs on the first successful
sweep each UTC day. Restart after config or token changes.

The collector does an immediate startup sweep labeled with the current wall-clock
interval, then waits for each next boundary (00/05/10… minutes by default). At
most 16 probes run concurrently, each with a 25-second total timeout and a
10-second connect timeout. Database commands have a 30-second timeout. Every
host gets a sample even for bad JSON, agent errors or SSH failure. Logs and API
errors contain short messages, never raw SSH stderr or private paths. Readings
are limited to 512 per host with bounded text and validated finite numbers.

Allow TCP 3096 only from Power hosts 192.168.1.111 and 192.168.1.112 and your
operator network. This is a private HTTP endpoint: do not publish it at the
internet edge. Temperature endpoints require the temperature bearer token; label
endpoints require the separate label token described below. `/health` needs no token. The
unit needs root for Docker; it protects the filesystem except the config
directory (where SSH adds known hosts), and permits AF_UNIX/INET/INET6. It does
not use production database passwords. No temperature data is written to Power's
existing SQLite databases.

## 5. Connect both Power instances

In each Coolify Power service (FountainOne **and** FountainTwo), set:

```text
POWER_TEMPS_API_URL=http://192.168.1.110:3096
POWER_TEMPS_API_TOKEN=<contents of /etc/fountain-temps/api-token>
```

Use Coolify's secret UI for the token, then redeploy both Power services after
review. Do not prefix these variables with `NEXT_PUBLIC_`. The dashboard uses
the existing Power session and server-side proxy; the token stays server-side.
Open Power normally from Coolify, then choose **Temperatures**. Verify current
readings, a failed host's last-good age, range selection, sensor details and the
60-second refresh. If either variable is missing, the authenticated page shows
“Temperature service not configured”. Without a session both console pages
redirect to the same existing launch endpoint; APIs return 401.

History clamps hours to 1–720 and uses 300-second buckets through 24h,
1800-second buckets through 7d, then 7200 seconds. Series contain bucket maxima;
missing samples remain gaps (the UI does not bridge long gaps). The latest API
also includes `last_good_at` and `warnings` for operations. Thresholds are 60/80/90°C.
The dashboard's thermal charts and every resource chart support drag-to-zoom
(reverse drags included, clamped to the chart range) with a **Reset zoom** control,
double-click, and Escape to reset; arrow keys still step through readings.

Resource history is the same `/v1/history` endpoint with an extra `metric`
parameter: `temp` (default, the behaviour above), `cpu`, `memory` or `disk`. The
response adds `"metric"` and keeps the `series` shape (`{host,kind,points}`), with
per-filesystem series adding `mount`. Resource values are bucketed **averages**
of a percentage — CPU from the stored sample, memory as
`100 × used / total`, disk as `100 × used / (used + available)` computed in SQL
from the stored byte counts — and are charted separately from Celsius on a 0–100
axis. The default `temp` response is byte-for-byte compatible with earlier
collectors and app versions, and the latest API keeps every legacy field while
adding per-host `resources` (`cpu`, `memory`, `disks`). A collector that predates
resources simply omits them, and the dashboard hides the resource section and
shows the CPU/memory/disk columns as not reported.

On the `/power/temperatures` page the resource overview lists every host's CPU
percentage, memory used/total, swap and each local filesystem's usage; selecting
a host expands full sensor and resource detail (CPU window and core count,
memory and available bytes, swap, and a per-mount table). The **Resource history**
section has CPU / Memory / Disk selectors that reuse the 6h/24h/7d/30d range
picker.

## Shared outlet labels

The same daemon also serves the shared Power label store. These steps are for an
operator after review; they do not change outlet switching or temperature roles.
Back up each replica's SQLite database before enabling shared labels. Review
custom labels and server descriptions: both must be 1–64 trimmed characters,
without control characters. Legacy mode permitted empty descriptions; fill those
in before migration. SQLite `updated_at` timestamps without a timezone mean UTC.

On FountainSelf, apply the additional idempotent migration as the database admin:

```sh
docker exec -i coolify-db psql -X -v ON_ERROR_STOP=1 -U coolify -d coolify < temps/sql/002_power_outlet_labels.sql
install -d -m 0700 /etc/fountain-temps
umask 077
python3 -c 'import secrets; from pathlib import Path; Path("/etc/fountain-temps/labels-token").write_text(secrets.token_urlsafe(48) + "\n")'
chmod 0600 /etc/fountain-temps/labels-token
install -m 0755 temps/collector/fountain-temps-collector /usr/local/lib/fountain-temps/fountain-temps-collector
systemctl restart fountain-temps-collector
```

The new `fountain_power_labels` LOGIN role has no password and uses the existing
container-local Unix socket trust, just like the temperature roles. It gets
schema USAGE and table SELECT/INSERT/UPDATE only. The migration revokes table
rights from PUBLIC and both temperature roles. Do not add network trust or
publish PostgreSQL. The label role receives no temperature-table grants.

The optional token file defaults to `/etc/fountain-temps/labels-token`; override
its path with `labels_token_file` in `collector.json` for local tests. It must be
mode 0600 and contain at least 32 ASCII characters without whitespace, different
from the temperature token. A missing file disables label routes with 503 while
temperature reads continue. An invalid, insecure, or reused token fails startup.
Restart after changing either token file. Keep the existing TCP 3096 LAN firewall
limits; never expose this private write API at the public edge.

Set these identically in **both** Coolify Power services, using the secret UI for
the token, then redeploy the reviewed app:

```text
POWER_LABELS_API_URL=http://192.168.1.110:3096
POWER_LABELS_API_TOKEN=<contents of /etc/fountain-temps/labels-token>
```

These are server-only environment variables. Never use `NEXT_PUBLIC_` or reuse
`POWER_TEMPS_API_TOKEN`. Both must be set to enable shared storage; either unset
retains legacy local behavior. Enable both replicas together to avoid one
continuing to edit only its local SQLite database.

Label API contract (all routes require the **label** bearer token):

- `GET /v1/labels` returns `{"labels":[{unit,outlet,label,server,sortOrder,updatedAt}]}`.
- `PUT /v1/labels/1/1` accepts `{"label":"FountainSelf","server":"Coolify admin"}`
  and returns the saved row. Unit is 1 or 2; outlet is 1–8. Text is trimmed,
  validated, and hex encoded before SQL. PUT timestamps use the database clock.
- `POST /v1/labels/seed` accepts `{"labels":[...]}` with the same row fields,
  including `updatedAt` with timezone. It returns `{inserted,updated,ignored}`
  counts. Up to 16 unique outlet keys are allowed per request. All write bodies
  are limited to 4096 bytes; the Power app batches wide Unicode seeds as needed.

On first read per unit and app process, each replica offers its original local
snapshot before refreshing its cache, even when another replica seeded first.
Empty or incomplete shared units also trigger seeding. Missing rows are inserted.
For a conflicting seed, SQL updates only when
`excluded.updated_at > power_outlet_labels.updated_at AND power_outlet_labels.updated_by = 'seed'`.
The newest seed wins regardless of arrival order; equal timestamps keep the
existing row. A successful PUT sets `updated_by='put'`, so no later seed can
overwrite that operator edit, even one with a future timestamp. If replicas have
different labels with identical timestamps, use an explicit edit to choose the
correct value after migration. Migration retries after shared API failures.

Successful reads and writes refresh each replica's local cache. When the API is
unavailable, reads return cached labels with `readOnly: true`; the console shows
“labels read-only: shared store unavailable” and disables label editing. Power
actions still work. Label writes return 503 with a clear error and never save
only to SQLite. Refresh after recovery. Verify a label edited through one replica
is visible through the other, then test the cache notice and rejected edit during
a controlled collector outage. Temperature tokens must receive 401 on label
routes and label tokens must receive 401 on temperature routes.

### Label rollback

Pause label editing and refresh both replicas while shared storage is available
so both SQLite caches contain the current labels; back up those caches. Remove
both `POWER_LABELS_API_*` variables from both services together and redeploy to
restore legacy local storage. This intentionally restores independent stores and
the original replica divergence risk. Remove the label token file and restart
the collector to disable only label routes; temperature service remains active.
Keep `fountain.power_outlet_labels` and its role for recovery by default. Only
after separately approving data destruction may an administrator drop that
specific table and `fountain_power_labels` role (revoke schema USAGE before
dropping the role). Do not drop the `fountain` schema or temperature objects as
part of label rollback.

## Local verification without infrastructure

Use a disposable directory and generated token; do not put runtime credentials
or config into git. From the repo root:

```sh
mkdir -p /tmp/fountain-temps-local
python3 - <<'PY'
import json, os, secrets
from pathlib import Path
root = Path('/tmp/fountain-temps-local')
token = root / 'token'
token.write_text(secrets.token_urlsafe(48))
token.chmod(0o600)
(root / 'collector.json').write_text(json.dumps({
    'bind': '127.0.0.1:3096', 'api_token_file': str(token), 'interval': 300,
    'hosts': [{'name': 'LocalMac', 'transport': 'local'}]
}))
PY
python3 temps/collector/fountain-temps-collector --dry-run --config /tmp/fountain-temps-local/collector.json
```

In another terminal, `curl http://127.0.0.1:3096/health` works without a token;
`curl -i http://127.0.0.1:3096/v1/latest` must return 401. For authorized requests,
load the disposable token without printing it:

```sh
temps_token="$(cat /tmp/fountain-temps-local/token)"
curl --fail -H "Authorization: Bearer ${temps_token}" http://127.0.0.1:3096/v1/latest
curl --fail -H "Authorization: Bearer ${temps_token}" 'http://127.0.0.1:3096/v1/history?hours=24&bucket=auto'
curl --fail -H "Authorization: Bearer ${temps_token}" 'http://127.0.0.1:3096/v1/history?hours=24&metric=cpu'
curl --fail -H "Authorization: Bearer ${temps_token}" 'http://127.0.0.1:3096/v1/history?hours=24&metric=memory'
curl --fail -H "Authorization: Bearer ${temps_token}" 'http://127.0.0.1:3096/v1/history?hours=24&metric=disk'
POWER_TEMPS_API_URL=http://127.0.0.1:3096 POWER_TEMPS_API_TOKEN="$temps_token" pnpm dev
```

Supply a local `POWER_SESSION_SECRET` and use the existing signed launch-ticket
workflow for an authenticated dashboard. Dry-run always probes the repository's
agent with the current Python interpreter via local subprocess; it never invokes
SSH or Docker, and uses in-memory retention/history. It deliberately refuses a
host list without explicit `transport: local`. The tests construct sysfs trees
and mock subprocess responses; no host probes or database writes are involved.

For visual preview with CPU/GPU/NVMe temperature curves, resource tiles and
CPU/memory/disk percentage charts, thresholds, an empty VM and a failed host (all
synthetic), run `python3 temps/tests/fixture_collector.py --token-file
/tmp/fountain-temps-local/token --port 3097`, then point the local Power server at
`http://127.0.0.1:3097`. This separate test server does not run probes. It seeds a
fixed 24-hour dataset of temperatures and CPU/memory/disk percentages at startup;
restart it for fresh timestamps. Until migration 003 and the updated collector are
deployed on FountainSelf, a real collector reports no resources and the dashboard
shows the resource columns as not reported.

## Rollback

1. Remove the two temperature env vars from both Power services and redeploy the
   prior reviewed app version (or leave the new app's clear disabled state).
2. On FountainSelf, run `systemctl disable --now fountain-temps-collector`, remove
   `/etc/systemd/system/fountain-temps-collector.service`, then
   `systemctl daemon-reload`. Remove `/usr/local/lib/fountain-temps`.
3. Remove only the `fountain-temps-collector` forced-command authorized key line
   from each host, then remove `/usr/local/bin/fountain-temps`. Remove the
   collector key, token and config under `/etc/fountain-temps` securely.
4. To roll the resource extension back without data loss, deploy the previous
   collector and app: the new columns stay NULL and `fountain.host_disk_samples`
   simply stops receiving rows, so the old temperature-only queries keep working.
   Alternatively drop only the resource objects with `ALTER TABLE
   fountain.host_temperature_samples DROP COLUMN cpu_percent, DROP COLUMN
   cpu_cores, DROP COLUMN cpu_window_s, DROP COLUMN memory_total_bytes, DROP
   COLUMN memory_used_bytes, DROP COLUMN memory_available_bytes, DROP COLUMN
   swap_total_bytes, DROP COLUMN swap_used_bytes;` and `DROP TABLE
   fountain.host_disk_samples;`. This discards resource history only.
5. Keep the isolated `fountain` schema for history by default. If destruction is
   explicitly approved and no other objects have been added to this schema, a DB
   administrator may run `DROP SCHEMA fountain CASCADE; DROP ROLE
   fountain_temps_reader; DROP ROLE fountain_temps_writer;` inside `coolify-db`.
   This discards all temperature history; never drop Coolify's schemas or tables.
