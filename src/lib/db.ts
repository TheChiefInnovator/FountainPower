import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { UnitId } from "@/lib/units";

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "power.sqlite");
const DB_PATH = process.env.POWER_DB_PATH ?? DEFAULT_DB_PATH;

export type OutletRecord = {
  unit: UnitId;
  outlet: number;
  label: string;
  server: string;
  sortOrder: number;
  updatedAt: string;
};

const seedOutlets: Array<[number, string, string]> = [
  [1, "FountainSelf", "Coolify admin and master proxy"],
  [2, "FountainOne", "Coolify managed web, DB, mixed workloads"],
  [3, "FountainTwo", "Coolify managed web, DB, mixed workloads"],
  [4, "FountainThree", "Coolify managed web, DB, mixed workloads"],
  [5, "FountainSeven", "Serial console host"],
  [6, "FountainFive", "Coolify managed AI workloads"],
  [7, "Outlet 7", "Unassigned"],
  [8, "Outlet 8", "Unassigned"],
];

const secondUnitOutlets: Array<[number, string, string]> = [
  [1, "FountainSix", "GPU / render host"],
  [2, "eGPU #1 RTX 3090 Ti", "FountainSix external GPU"],
  [3, "eGPU #2 RTX 3090 Ti", "FountainSix external GPU"],
  ...[4, 5, 6, 7, 8].map((n): [number, string, string] => [n, `Outlet ${n}`, "Unassigned"]),
];

function tableName(unit: UnitId) {
  if (unit !== 1 && unit !== 2) throw new Error("Invalid power unit.");
  return unit === 1 ? "outlets" : "outlets_unit2";
}

function sqlite(sql: string) {
  return execFileSync("sqlite3", [DB_PATH, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function initDb(unit: UnitId = 1) {
  const table = tableName(unit);
  const dir = path.dirname(DB_PATH);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  sqlite(`
    create table if not exists ${table} (
      outlet integer primary key check (outlet between 1 and 8),
      label text not null,
      server text not null default '',
      sort_order integer not null,
      updated_at text not null default current_timestamp
    );
  `);

  for (const [outlet, label, server] of unit === 1 ? seedOutlets : secondUnitOutlets) {
    sqlite(`
      insert into ${table} (outlet, label, server, sort_order)
      values (${outlet}, ${sqlString(label)}, ${sqlString(server)}, ${outlet})
      on conflict(outlet) do nothing;
    `);
  }
}

export function getOutletRecords(unit: UnitId = 1) {
  initDb(unit);

  const raw = sqlite(`
    select coalesce(json_group_array(json_object(
      'unit', ${unit},
      'outlet', outlet,
      'label', label,
      'server', server,
      'sortOrder', sort_order,
      'updatedAt', updated_at
    )), '[]')
    from (select * from ${tableName(unit)} order by sort_order, outlet);
  `);

  return JSON.parse(raw.trim() || "[]") as OutletRecord[];
}

export function updateOutlet(outlet: number, label: string, server: string, unit: UnitId = 1) {
  initDb(unit);

  sqlite(`
    update ${tableName(unit)}
    set label = ${sqlString(label.trim())},
        server = ${sqlString(server.trim())},
        updated_at = current_timestamp
    where outlet = ${outlet};
  `);

  return getOutletRecords(unit).find((record) => record.outlet === outlet) ?? null;
}
