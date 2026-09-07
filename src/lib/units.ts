export const UNITS = [
  { id: 1, label: "Unit 1", connection: "LAN" },
  { id: 2, label: "Unit 2", connection: "Serial · FountainSeven" },
] as const;

export type UnitId = 1 | 2;

export function parseUnit(value: string | null): UnitId {
  if (value === null || value === "1") return 1;
  if (value === "2") return 2;
  throw new Error("Invalid power unit.");
}
