# FountainStack Power

Next.js control surface for two FountainStack WTI IPS-800 power switches.

The app is served from `/power` by redundant Coolify instances on FountainOne and FountainTwo. Unit 1 uses the LAN/Telnet driver at `192.168.1.150`. Unit 2 uses an authenticated serial bridge on FountainSeven (`192.168.1.117:3041`), connected through `/dev/cu.usbserial-FTEPND0D`. That cable now controls **Unit 2**, not a fallback connection to Unit 1.

## Two-unit operation (2026-09-07)

The console groups outlets by unit. Action and label APIs accept `?unit=1` or `?unit=2`; omitting the parameter retains Unit 1 compatibility. Invalid unit IDs are rejected. Existing labels remain in the `outlets` table; Unit 2 labels are stored independently in `outlets_unit2`. Each Coolify replica has its own existing SQLite volume.

Unit 2 MAC: `00-09-9b-01-12-83`. The operator has now connected power to the second input bank, supplying outlets 5–8 as well as 1–4. The temporary `2:B` disconnected-bank annotation has been cleared on both app instances. Input power is operator-confirmed; the switch reports relay settings, not measured outlet voltage. Assignments: 1 = FountainSix; 2 = eGPU #1 RTX 3090 Ti; 3 = eGPU #2 RTX 3090 Ti; 4–8 = unassigned.

`POWER_DISCONNECTED_INPUT_BANKS` is currently empty. Use an entry such as `2:B` to record a disconnected input in both Coolify app instances, then redeploy them. Banks A and B correspond to outlets 1–4 and 5–8 respectively. This is operator-maintained wiring metadata, not automatic sensing. The API preserves switch-reported `state` and adds `inputDisconnected`; the UI shows NO INPUT POWER separately from Relay: ON and excludes those outlets from its on count. Clear the corresponding entry and redeploy both instances after reconnecting an input. Do not invent an OFF relay response to represent an absent input supply.

Set `POWER_UNIT2_BRIDGE_URL=http://192.168.1.117:3041` and secret `POWER_UNIT2_BRIDGE_TOKEN` in both Coolify service stacks. The host bridge uses only the Python standard library; source is `scripts/serial_bridge.py` plus `scripts/wti_serial.py`. It serializes requests, verifies the switch MAC before accessing outlets, and reports incomplete reads as failures. No bridge credentials or raw console output are returned to browsers. Only the two app hosts and local host are permitted to connect.

The bridge is managed by `/Library/LaunchDaemons/io.theci.fountain-power-serial.plist`, runs as `miles`, and starts at boot. Its private config is `/Volumes/miles/.config/fountain-power-bridge/config.json` (mode 0600); logs are in the same directory. Inspect with `sudo launchctl print system/io.theci.fountain-power-serial`. Run `python3 scripts/test_serial_bridge.py` and `node scripts/test_units.mjs` for regression checks.

When Unit 2 gets LAN connectivity, keep unit IDs and label tables stable and replace its bridge transport with a unit-specific LAN driver. Do not point Unit 1's global WTI settings at the second device. GPU workloads and boot GPU-count settings were not changed by this power-app update.

## Environment

Copy `.env.example` to `.env.local` on FountainSeven and set real values:

```bash
cp .env.example .env.local
```

Required values:

- `POWER_SESSION_SECRET`: at least 32 random characters.
- `POWER_CONTROL_DRIVER`: `telnet` for the WTI network text API, `http` for the WTI web form API, or `serial` for the local serial-console fallback.
- `POWER_WTI_BASE_URL`: WTI base URL, usually `http://192.168.1.150`.
- `POWER_WTI_USERNAME`: WTI web username.
- `POWER_WTI_PASSWORD`: WTI web password.
- `POWER_WTI_HTTP_TIMEOUT_MS`: WTI HTTP request timeout.
- `POWER_WTI_TELNET_HOST`: WTI Telnet host, usually `192.168.1.150`.
- `POWER_WTI_TELNET_PORT`: WTI Telnet port, usually `23`.
- `POWER_WTI_TELNET_PASSWORD`: WTI System Password for the network text interface. Defaults to `POWER_WTI_PASSWORD` when unset.
- `POWER_WTI_TELNET_TIMEOUT_MS`: WTI Telnet command timeout.
- `POWER_WTI_TELNET_ATTEMPTS`: retry attempts for the WTI Telnet command channel.
- `POWER_SERIAL_PASSWORD`: WTI serial console password, required only when `POWER_CONTROL_DRIVER=serial`.
- `POWER_SERIAL_DEVICE`: serial adapter path, required only when `POWER_CONTROL_DRIVER=serial`.
- `POWER_PROTECTED_OFF_OUTLETS`: comma-separated outlet numbers that cannot be turned off.
- `POWER_DB_PATH`: SQLite database path.
- `COOLIFY_VALIDATE_URL`: Coolify URL used to validate the signed-in session cookie.
- `POWER_TEMPS_API_URL`: private temperature collector origin, e.g. `http://192.168.1.110:3096`.
- `POWER_TEMPS_API_TOKEN`: private collector bearer token; never exposed to browsers. Set both temperature variables in both Coolify Power instances. Leaving either empty displays “Temperature service not configured”.

The authenticated `/power/temperatures` dashboard shows fleet temperatures and up to 30 days of history. It refreshes every 60 seconds through the session-protected `/power/api/temperatures` proxy. The collector samples every five minutes and retains 180 days; it uses dedicated PostgreSQL roles inside `coolify-db`, without exposing PostgreSQL on the LAN. See [temperature installation and rollback](temps/install.md) for the agent, SSH restrictions, schema, collector configuration, and local dry-run commands.

## Power Drivers

Use `POWER_CONTROL_DRIVER=telnet` for redundant deployments. The Telnet driver talks to the WTI network text interface and uses the same commands as the serial driver:

- `/S` reads outlet state.
- `/On N,y`, `/Off N,y`, and `/Boot N,y` control outlets.

Use `POWER_CONTROL_DRIVER=http` only when the WTI's classic HTML form API is stable:

- `GET /plugs.htm` reads outlet state.
- `POST /plugs` sends `plugN=On`, `plugN=Off`, or `plugN=Boot`.

The legacy `POWER_CONTROL_DRIVER=serial` setting must not be used for Unit 1 while the USB adapter is attached to Unit 2. The Unit 2 bridge uses `/S`, `/On N,y`, `/Off N,y`, and `/Boot N,y` through `/dev/cu.usbserial-FTEPND0D`.

## Local Commands

```bash
pnpm install
pnpm build
pm2 start ecosystem.config.cjs
pm2 save
```

Generate a short-lived launch URL:

```bash
set -a
source .env.local
set +a
pnpm ticket
```

## Traefik

The app expects Traefik to forward `https://coolify.theci.io/power` to:

```text
http://192.168.1.117:3040
```

Do not strip the `/power` prefix; Next.js is configured with `basePath: "/power"`.

## Container

Build locally:

```bash
docker build -t fountainpower .
```

Coolify service stacks use `docker-compose.yml`. Each redundant instance listens on host port `3091`, and the FountainSelf Traefik dynamic config load-balances `https://coolify.theci.io/power` across the FountainOne and FountainTwo LAN endpoints.
