import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getSessionFromCookies } from "@/lib/auth";
import { TemperatureConsole } from "@/components/temperature-console";

export const dynamic = "force-dynamic";

export default async function Temperatures() {
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

  return <TemperatureConsole configured={Boolean(process.env.POWER_TEMPS_API_URL && process.env.POWER_TEMPS_API_TOKEN)} />;
}
