import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import { SharedLabelsUnavailable, updateOutlet } from "@/lib/db";
import { parseUnit } from "@/lib/units";

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

  try {
    const body = await request.json();
    if (!body || typeof body.label !== "string" || (body.server != null && typeof body.server !== "string")) {
      return NextResponse.json({ error: "Label and server must be text" }, { status: 400 });
    }
    const label = body.label.trim();
    if (!label) return NextResponse.json({ error: "Label is required" }, { status: 400 });
    const unit = parseUnit(request.nextUrl.searchParams.get("unit"));
    return NextResponse.json({ outlet: await updateOutlet(outlet, body.label, body.server ?? "", unit) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Update failed." },
      { status: error instanceof SharedLabelsUnavailable ? 503 : 400 });
  }
}
