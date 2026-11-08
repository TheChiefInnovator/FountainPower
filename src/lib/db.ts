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
  readOnly?: boolean;
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

function localOutletRecords(unit: UnitId = 1) {
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

const seededUnits = new Set<string>();

function sharedConfig() {
  const url = process.env.POWER_LABELS_API_URL;
  const token = process.env.POWER_LABELS_API_TOKEN;
  return url && token ? { url, token } : null;
}

export class SharedLabelsUnavailable extends Error {
  constructor() {
    super("Labels read-only: shared store unavailable. Refresh and try again; no local-only edit was saved.");
  }
}

async function sharedRequest(config: { url: string; token: string }, route: string, body?: unknown, method = "POST") {
  const origin = new URL(config.url);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
    throw new SharedLabelsUnavailable();
  }
  const response = await fetch(`${origin.toString().replace(/\/$/, "")}${route}`, {
    method: body === undefined ? "GET" : method,
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new SharedLabelsUnavailable();
  return response.json() as Promise<unknown>;
}

function parseSharedRow(value: unknown): OutletRecord {
  if (!value || typeof value !== "object") throw new SharedLabelsUnavailable();
  const row = value as OutletRecord;
  if ((row.unit !== 1 && row.unit !== 2) || !Number.isInteger(row.outlet) || row.outlet < 1 || row.outlet > 8 ||
      typeof row.label !== "string" || typeof row.server !== "string" || !Number.isInteger(row.sortOrder) ||
      typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))) {
    throw new SharedLabelsUnavailable();
  }
  return { unit: row.unit, outlet: row.outlet, label: row.label, server: row.server, sortOrder: row.sortOrder, updatedAt: row.updatedAt };
}

async function sharedRows(config: { url: string; token: string }) {
  const result = await sharedRequest(config, "/v1/labels") as { labels?: unknown[] } | null;
  if (!result || !Array.isArray(result.labels)) throw new SharedLabelsUnavailable();
  const rows = result.labels.map(parseSharedRow);
  if (new Set(rows.map((row) => `${row.unit}:${row.outlet}`)).size !== rows.length) throw new SharedLabelsUnavailable();
  return rows;
}

function cacheRows(rows: OutletRecord[], unit: UnitId) {
  initDb(unit);
  sqlite(`BEGIN; ${rows.map((row) => `
    insert into ${tableName(unit)} (outlet,label,server,sort_order,updated_at)
    values (${row.outlet},${sqlString(row.label)},${sqlString(row.server)},${row.sortOrder},${sqlString(row.updatedAt)})
    on conflict(outlet) do update set label=excluded.label,server=excluded.server,
      sort_order=excluded.sort_order,updated_at=excluded.updated_at;
  `).join("\n")} COMMIT;`);
}

async function seedRows(config: { url: string; token: string }, rows: OutletRecord[]) {
  // Eight Unicode labels can exceed 4 KiB. Bound every seed request by bytes.
  let batch: OutletRecord[] = [];
  for (const row of rows) {
    const seed = { ...row, updatedAt: row.updatedAt.includes("T") ? row.updatedAt : row.updatedAt.replace(" ", "T") + "Z" };
    if (Buffer.byteLength(JSON.stringify({ labels: [...batch, seed] })) > 4096 && batch.length) {
      await sharedRequest(config, "/v1/labels/seed", { labels: batch });
      batch = [];
    }
    batch.push(seed);
  }
  if (batch.length) await sharedRequest(config, "/v1/labels/seed", { labels: batch });
}

export async function getOutletRecords(unit: UnitId = 1): Promise<OutletRecord[]> {
  const local = localOutletRecords(unit);
  const config = sharedConfig();
  if (!config) return local;
  try {
    let rows = (await sharedRows(config)).filter((row) => row.unit === unit);
    const key = `${config.url}:${unit}`;
    // Every replica offers its original snapshot once, including when another
    // replica seeded first. Only newer seed timestamps may replace seed rows.
    if (!seededUnits.has(key) || rows.length < 8) {
      await seedRows(config, local);
      rows = (await sharedRows(config)).filter((row) => row.unit === unit);
      seededUnits.add(key);
    }
    if (rows.length !== 8) throw new SharedLabelsUnavailable();
    rows.sort((a, b) => a.sortOrder - b.sortOrder || a.outlet - b.outlet);
    cacheRows(rows, unit);
    return rows;
  } catch {
    return local.map((row) => ({ ...row, readOnly: true }));
  }
}

export async function updateOutlet(outlet: number, label: string, server: string, unit: UnitId = 1) {
  tableName(unit);
  if (!Number.isInteger(outlet) || outlet < 1 || outlet > 8) throw new Error("Invalid outlet.");
  const config = sharedConfig();
  if (config) {
    if ([label, server].some((value) => !value.trim() || [...value.trim()].length > 64 || /\p{Cc}/u.test(value))) {
      throw new Error("Label and server must have 1..64 characters without control characters.");
    }
    let row: OutletRecord;
    try {
      row = parseSharedRow(await sharedRequest(config, `/v1/labels/${unit}/${outlet}`,
        { label: label.trim(), server: server.trim() }, "PUT"));
      if (row.unit !== unit || row.outlet !== outlet) throw new SharedLabelsUnavailable();
    } catch {
      throw new SharedLabelsUnavailable();
    }
    cacheRows([row], unit);
    return row;
  }
  initDb(unit);

  sqlite(`
    update ${tableName(unit)}
    set label = ${sqlString(label.trim())},
        server = ${sqlString(server.trim())},
        updated_at = current_timestamp
    where outlet = ${outlet};
  `);

  return localOutletRecords(unit).find((record) => record.outlet === outlet) ?? null;
}
