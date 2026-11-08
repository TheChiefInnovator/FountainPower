import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();

  if (!getSessionFromCookies(cookieStore)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiUrl = process.env.POWER_TEMPS_API_URL;
  const token = process.env.POWER_TEMPS_API_TOKEN;
  const reply = (body: unknown, status = 200) => NextResponse.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  });
  if (!apiUrl || !token) {
    return reply({ error: "Temperature service not configured" }, 503);
  }

  const query = request.nextUrl.searchParams;
  const view = query.get("view") ?? "latest";
  if (view !== "latest" && view !== "history") {
    return reply({ error: "Invalid view" }, 400);
  }
  const params = new URLSearchParams();
  if (view === "history") {
    const hours = Number(query.get("hours") ?? 24);
    const host = query.get("host");
    if (!Number.isInteger(hours) || (host !== null && !/^[A-Za-z0-9-]{1,64}$/.test(host)) ||
        (query.has("bucket") && query.get("bucket") !== "auto")) {
      return reply({ error: "Invalid history parameters" }, 400);
    }
    params.set("hours", String(Math.min(720, Math.max(1, hours))));
    params.set("bucket", "auto");
    if (host) params.set("host", host);
  }

  try {
    const url = new URL(`/v1/${view}`, apiUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return reply({ error: "Temperature service configuration invalid" }, 503);
    }
    url.search = params.toString();
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return reply({ error: "Temperature service unavailable" }, 502);
    const data = await response.json();
    if (!data || !Array.isArray(view === "latest" ? data.hosts : data.series)) {
      return reply({ error: "Invalid temperature service response" }, 502);
    }
    return reply(data);
  } catch {
    return reply({ error: "Temperature service unavailable" }, 502);
  }
}
