import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { getOutletRecords, type OutletRecord } from "@/lib/db";

const execFileAsync = promisify(execFile);

export type OutletState = "on" | "off" | "unknown";

export type OutletView = OutletRecord & {
  canPowerOff: boolean;
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

function protectedOffOutlets() {
  return new Set(
    (process.env.POWER_PROTECTED_OFF_OUTLETS ?? "5")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 8),
  );
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
  const protectedOutlets = protectedOffOutlets();

  return records.map((record) => ({
    ...record,
    canPowerOff: !protectedOutlets.has(record.outlet),
    state: states[String(record.outlet)] ?? "unknown",
  }));
}

export async function setOutletPower(outlet: number, action: "on" | "off" | "boot") {
  if (!Number.isInteger(outlet) || outlet < 1 || outlet > 8) {
    throw new Error("Outlet must be between 1 and 8.");
  }

  if (action === "off" && protectedOffOutlets().has(outlet)) {
    throw new Error("This outlet hosts the power-control app and cannot be turned off. Use power cycle instead.");
  }

  await runSerial([action, String(outlet)]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  return getOutletsWithState();
}
