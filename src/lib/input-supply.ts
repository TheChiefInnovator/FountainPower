import type { UnitId } from "@/lib/units";

// Operator-recorded wiring information. The IPS status protocol does not
// provide a voltage measurement for either input bank.
export function inputDisconnected(unit: UnitId, outlet: number) {
  const entries = (process.env.POWER_DISCONNECTED_INPUT_BANKS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (entries.some((entry) => !/^[12]:[AB]$/.test(entry))) {
    throw new Error("Invalid POWER_DISCONNECTED_INPUT_BANKS; expected entries such as 2:B.");
  }
  return entries.includes(`${unit}:${outlet <= 4 ? "A" : "B"}`);
}
