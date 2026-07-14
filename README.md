# FountainStack Power

Small Next.js control surface for the FountainStack WTI IPS-800 power switch.

The app is served from `/power`, runs on FountainSeven via PM2 on port `3040`, stores outlet labels in local SQLite, and reads/actions power state through the USB serial adapter at `/dev/cu.usbserial-FTEPND0D`.

## Environment

Copy `.env.example` to `.env.local` on FountainSeven and set real values:

```bash
cp .env.example .env.local
```

Required values:

- `POWER_SESSION_SECRET`: at least 32 random characters.
- `POWER_SERIAL_PASSWORD`: WTI serial console password.
- `POWER_SERIAL_DEVICE`: serial adapter path.
- `POWER_PROTECTED_OFF_OUTLETS`: comma-separated outlet numbers that cannot be turned off.
- `POWER_DB_PATH`: SQLite database path.
- `COOLIFY_VALIDATE_URL`: Coolify URL used to validate the signed-in session cookie.

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
