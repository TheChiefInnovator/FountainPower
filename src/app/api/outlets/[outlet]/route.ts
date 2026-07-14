import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import { updateOutlet } from "@/lib/db";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{
    outlet: string;
  }>;
};

export async function PATCH(request: NextRequest, context: Context) {
  const cookieStore = await cookies();

  if (!getSessionFromCookies(cookieStore)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { outlet: outletParam } = await context.params;
  const outlet = Number(outletParam);

  if (!Number.isInteger(outlet) || outlet < 1 || outlet > 8) {
    return NextResponse.json({ error: "Invalid outlet" }, { status: 400 });
  }

  const body = (await request.json()) as { label?: string; server?: string };
  const label = body.label?.trim();
  const server = body.server?.trim() ?? "";

  if (!label) {
    return NextResponse.json({ error: "Label is required" }, { status: 400 });
  }

  return NextResponse.json({ outlet: updateOutlet(outlet, label, server) });
}
