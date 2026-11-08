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
docker exec -i coolify-db psql -X -v ON_ERROR_STOP=1 -U fountain_temps_writer -d coolify -c 'SELECT count(*) FROM fountain.host_temperature_samples'
docker exec -i coolify-db psql -X -v ON_ERROR_STOP=1 -U fountain_temps_reader -d coolify -c 'SELECT count(*) FROM fountain.host_temperature_readings'
```

The migration is transactional and idempotent. Dedicated LOGIN roles have no
password and depend on the container's existing **local Unix socket trust**.
Verify that policy before installation; do not enable network trust or expose a
database port. The writer has INSERT/SELECT, sequence USAGE and DELETE on samples
for retention; the reader has SELECT only. The cascading foreign key removes
readings when their sample expires. The extra `sample_id` index also keeps latest
reads and retention deletes efficient.

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
internet edge. All endpoints except `/health` require the bearer token. The
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
POWER_TEMPS_API_URL=http://127.0.0.1:3096 POWER_TEMPS_API_TOKEN="$temps_token" pnpm dev
```

Supply a local `POWER_SESSION_SECRET` and use the existing signed launch-ticket
workflow for an authenticated dashboard. Dry-run always probes the repository's
agent with the current Python interpreter via local subprocess; it never invokes
SSH or Docker, and uses in-memory retention/history. It deliberately refuses a
host list without explicit `transport: local`. The tests construct sysfs trees
and mock subprocess responses; no host probes or database writes are involved.

For visual preview with CPU/GPU/NVMe curves, thresholds, an empty VM and a failed
host (all synthetic), run `python3 temps/tests/fixture_collector.py --token-file
/tmp/fountain-temps-local/token --port 3097`, then point the local Power server at
`http://127.0.0.1:3097`. This separate test server does not run probes. It uses a
fixed 24-hour dataset seeded at startup; restart it for fresh timestamps.

## Rollback

1. Remove the two temperature env vars from both Power services and redeploy the
   prior reviewed app version (or leave the new app's clear disabled state).
2. On FountainSelf, run `systemctl disable --now fountain-temps-collector`, remove
   `/etc/systemd/system/fountain-temps-collector.service`, then
   `systemctl daemon-reload`. Remove `/usr/local/lib/fountain-temps`.
3. Remove only the `fountain-temps-collector` forced-command authorized key line
   from each host, then remove `/usr/local/bin/fountain-temps`. Remove the
   collector key, token and config under `/etc/fountain-temps` securely.
4. Keep the isolated `fountain` schema for history by default. If destruction is
   explicitly approved and no other objects have been added to this schema, a DB
   administrator may run `DROP SCHEMA fountain CASCADE; DROP ROLE
   fountain_temps_reader; DROP ROLE fountain_temps_writer;` inside `coolify-db`.
   This discards all temperature history; never drop Coolify's schemas or tables.
