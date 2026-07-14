import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";
import { getOutletsWithState } from "@/lib/power";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();

  if (!getSessionFromCookies(cookieStore)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ outlets: await getOutletsWithState() });
}
