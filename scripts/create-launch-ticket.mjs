#!/usr/bin/env node
import crypto from "node:crypto";

const secret = process.env.POWER_SESSION_SECRET;
const ttlSeconds = Number(process.env.POWER_LAUNCH_TTL_SECONDS ?? 60);
const subject = process.argv[2] ?? "coolify-user";
const baseUrl = process.env.POWER_PUBLIC_URL ?? "https://coolify.theci.io/power";

if (!secret || secret.length < 32) {
  console.error("POWER_SESSION_SECRET must be set to at least 32 characters.");
  process.exit(1);
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

const now = Math.floor(Date.now() / 1000);
const payload = base64Url(
  JSON.stringify({
    exp: now + ttlSeconds,
    iat: now,
    sub: subject,
    typ: "launch",
  }),
);
const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
const url = new URL(`${baseUrl.replace(/\/$/, "")}/api/auth/launch`);
url.searchParams.set("ticket", `${payload}.${signature}`);

console.log(url.toString());
