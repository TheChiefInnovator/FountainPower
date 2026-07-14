import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getOutletRecords, type OutletRecord } from "@/lib/db";

const execFileAsync = promisify(execFile);

export type OutletState = "on" | "off" | "unknown";

export type OutletView = OutletRecord & {
  state: OutletState;
};

type SerialResult = {
  states?: Record<string, OutletState>;
  state?: OutletState;
  raw?: string;
};

function serialScriptPath() {
  return path.join(process.cwd(), "scripts", "wti_serial.py");
}

async function runSerial(args: string[]) {
  const device = process.env.POWER_SERIAL_DEVICE ?? "/dev/cu.usbserial-FTEPND0D";
  const { stdout } = await execFileAsync("python3", [serialScriptPath(), "--device", device, ...args], {
    timeout: Number(process.env.POWER_SERIAL_TIMEOUT_MS ?? 7000),
    maxBuffer: 1024 * 1024,
  });

  return JSON.parse(stdout) as SerialResult;
}

export async function readPowerStates() {
  try {
    const result = await runSerial(["status"]);
    return result.states ?? {};
  } catch (error) {
    console.error("Failed to read serial power state", error);
    return {};
  }
}

export async function getOutletsWithState(): Promise<OutletView[]> {
  const [records, states] = await Promise.all([Promise.resolve(getOutletRecords()), readPowerStates()]);

  return records.map((record) => ({
    ...record,
    state: states[String(record.outlet)] ?? "unknown",
  }));
}

export async function setOutletPower(outlet: number, action: "on" | "off" | "boot") {
  if (!Number.isInteger(outlet) || outlet < 1 || outlet > 8) {
    throw new Error("Outlet must be between 1 and 8.");
  }

  await runSerial([action, String(outlet)]);
  return getOutletsWithState();
}
