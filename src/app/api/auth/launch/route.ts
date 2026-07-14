import { NextRequest, NextResponse } from "next/server";
import {
  POWER_SESSION_COOKIE,
  createSession,
  validateCoolifyCookie,
  verifyLaunchTicket,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ticketSubject = verifyLaunchTicket(request.nextUrl.searchParams.get("ticket"));
  const validCoolifySession = ticketSubject
    ? true
    : await validateCoolifyCookie(request.headers.get("cookie"));

  if (!validCoolifySession) {
    return new NextResponse("Not authenticated through Coolify.", {
      status: 401,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const isHttps =
    request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? request.headers.get("host") ?? request.nextUrl.host;
  const proto = forwardedProto ?? (isHttps ? "https" : "http");
  const response = NextResponse.redirect(new URL("/power", `${proto}://${host}`));

  response.cookies.set({
    name: POWER_SESSION_COOKIE,
    value: createSession(ticketSubject || "coolify-user"),
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    path: "/power",
    maxAge: Number(process.env.POWER_SESSION_TTL_SECONDS ?? 15 * 60),
  });

  return response;
}
