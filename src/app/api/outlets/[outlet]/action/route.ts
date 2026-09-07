import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import { setOutletPower } from "@/lib/power";
import { parseUnit } from "@/lib/units";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{
    outlet: string;
  }>;
};

export async function POST(request: NextRequest, context: Context) {
  const cookieStore = await cookies();

  if (!getSessionFromCookies(cookieStore)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { outlet: outletParam } = await context.params;
  const outlet = Number(outletParam);
  const body = (await request.json()) as { action?: "on" | "off" | "boot" };

  if (body.action !== "on" && body.action !== "off" && body.action !== "boot") {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  try {
    const unit = parseUnit(request.nextUrl.searchParams.get("unit"));
    return NextResponse.json({ outlets: await setOutletPower(outlet, body.action, unit) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Power action failed." },
      { status: 400 },
    );
  }
}
