# FountainStack Power

Small Next.js control surface for the FountainStack WTI IPS-800 power switch.

The app is served from `/power`, runs via PM2 on port `3040`, stores outlet labels in local SQLite, and reads/actions power state through the WTI web form API by default. The USB serial adapter at `/dev/cu.usbserial-FTEPND0D` remains available as a fallback driver on FountainSeven.

## Environment

Copy `.env.example` to `.env.local` on FountainSeven and set real values:

```bash
cp .env.example .env.local
```

Required values:

- `POWER_SESSION_SECRET`: at least 32 random characters.
- `POWER_CONTROL_DRIVER`: `http` for the WTI web form API, or `serial` for the local serial-console fallback.
- `POWER_WTI_BASE_URL`: WTI base URL, usually `http://192.168.1.150`.
- `POWER_WTI_USERNAME`: WTI web username.
- `POWER_WTI_PASSWORD`: WTI web password.
- `POWER_WTI_HTTP_TIMEOUT_MS`: WTI HTTP request timeout.
- `POWER_SERIAL_PASSWORD`: WTI serial console password, required only when `POWER_CONTROL_DRIVER=serial`.
- `POWER_SERIAL_DEVICE`: serial adapter path, required only when `POWER_CONTROL_DRIVER=serial`.
- `POWER_PROTECTED_OFF_OUTLETS`: comma-separated outlet numbers that cannot be turned off.
- `POWER_DB_PATH`: SQLite database path.
- `COOLIFY_VALIDATE_URL`: Coolify URL used to validate the signed-in session cookie.

## Power Drivers

Use `POWER_CONTROL_DRIVER=http` for redundant deployments. The HTTP driver talks to the WTI's classic HTML form API:

- `GET /plugs.htm` reads outlet state.
- `POST /plugs` sends `plugN=On`, `plugN=Off`, or `plugN=Boot`.

Use `POWER_CONTROL_DRIVER=serial` only on FountainSeven when the WTI web interface is unavailable. Serial uses `/S`, `/On N,y`, `/Off N,y`, and `/Boot N,y` through `/dev/cu.usbserial-FTEPND0D`.

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
