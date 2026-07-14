import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { PowerConsole } from "@/components/power-console";
import { getOutletsWithState } from "@/lib/power";
import { getSessionFromCookies } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const cookieStore = await cookies();
  const session = getSessionFromCookies(cookieStore);

  if (!session) {
    redirect("/power/api/auth/launch");
  }

  const outlets = await getOutletsWithState();

  return <PowerConsole initialOutlets={outlets} sessionExpiresAt={session.exp} />;
}
