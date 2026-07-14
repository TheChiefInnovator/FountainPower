import crypto from "node:crypto";
export const POWER_SESSION_COOKIE = "fountain_power_session";
const SESSION_TTL_SECONDS = Number(process.env.POWER_SESSION_TTL_SECONDS ?? 15 * 60);

export type PowerSession = {
  exp: number;
  iat: number;
  sub: string;
};

function getSecret() {
  const secret = process.env.POWER_SESSION_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("POWER_SESSION_SECRET must be set to at least 32 characters.");
  }

  return secret;
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payload: string) {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

function verifySignedValue(value: string) {
  const [payload, signature] = value.split(".");

  if (!payload || !signature) {
    return null;
  }

  const expected = signPayload(payload);

  if (
    expected.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }

  return payload;
}

export function createSession(sub = "coolify-user") {
  const now = Math.floor(Date.now() / 1000);
  const session: PowerSession = {
    exp: now + SESSION_TTL_SECONDS,
    iat: now,
    sub,
  };
  const payload = base64Url(JSON.stringify(session));

  return `${payload}.${signPayload(payload)}`;
}

export function getSessionFromCookieValue(value?: string) {
  if (!value) {
    return null;
  }

  const payload = verifySignedValue(value);

  if (!payload) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PowerSession;
    const now = Math.floor(Date.now() / 1000);

    if (!session.exp || session.exp <= now) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

type CookieStore = {
  get(name: string): { value: string } | undefined;
};

export function getSessionFromCookies(cookieStore: CookieStore) {
  return getSessionFromCookieValue(cookieStore.get(POWER_SESSION_COOKIE)?.value);
}

export async function validateCoolifyCookie(cookieHeader: string | null) {
  if (!cookieHeader) {
    return false;
  }

  const validateUrl = process.env.COOLIFY_VALIDATE_URL ?? "https://coolify.theci.io/";

  try {
    const response = await fetch(validateUrl, {
      headers: {
        cookie: cookieHeader,
        "user-agent": "FountainStackPower/1.0",
      },
      redirect: "manual",
      cache: "no-store",
    });

    const location = response.headers.get("location") ?? "";

    if (response.status >= 300 && response.status < 400) {
      return !/login|auth|signin/i.test(location);
    }

    if (!response.ok) {
      return false;
    }

    const text = await response.text();
    return !/name=["']password["']|login|sign in/i.test(text.slice(0, 20000));
  } catch {
    return false;
  }
}

export function createLaunchTicket(subject = "coolify-user", ttlSeconds = 60) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64Url(
    JSON.stringify({
      exp: now + ttlSeconds,
      iat: now,
      sub: subject,
      typ: "launch",
    }),
  );

  return `${payload}.${signPayload(payload)}`;
}

export function verifyLaunchTicket(ticket: string | null) {
  if (!ticket) {
    return null;
  }

  const payload = verifySignedValue(ticket);

  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
      sub?: string;
      typ?: string;
    };

    if (parsed.typ !== "launch" || !parsed.exp || parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return parsed.sub ?? "coolify-user";
  } catch {
    return null;
  }
}
