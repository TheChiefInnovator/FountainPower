import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PowerConsole } from "@/components/power-console";
import { getOutletsWithState } from "@/lib/power";
import { getSessionFromCookies } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const cookieStore = await cookies();
  const session = getSessionFromCookies(cookieStore);

  if (!session) {
    const headerStore = await headers();
    const proto = headerStore.get("x-forwarded-proto") ?? "https";
    const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");

    if (host) {
      redirect(`${proto}://${host}/power/api/auth/launch`);
    }

    redirect("/power/api/auth/launch");
  }

  const outlets = await getOutletsWithState();

  return <PowerConsole initialOutlets={outlets} sessionExpiresAt={session.exp} />;
}
