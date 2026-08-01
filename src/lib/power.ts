import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
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

type PowerDriver = "serial" | "http";

type WtiHttpResponse = {
  body: string;
  statusCode: number;
};

function serialScriptPath() {
  return path.join(process.cwd(), "scripts", "wti_serial.py");
}

function powerDriver(): PowerDriver {
  const driver = (process.env.POWER_CONTROL_DRIVER ?? "serial").toLowerCase();

  if (driver === "http" || driver === "web") {
    return "http";
  }

  return "serial";
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

function wtiBaseUrl() {
  return (process.env.POWER_WTI_BASE_URL ?? "http://192.168.1.150").replace(/\/+$/, "");
}

function wtiAuthHeader() {
  const username = process.env.POWER_WTI_USERNAME;
  const password = process.env.POWER_WTI_PASSWORD;

  if (!username || !password) {
    throw new Error("POWER_WTI_USERNAME and POWER_WTI_PASSWORD must be set for HTTP power control.");
  }

  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function requestWti(pathname: string, options: { method?: "GET" | "POST"; body?: string } = {}) {
  return new Promise<WtiHttpResponse>((resolve, reject) => {
    const url = new URL(`${wtiBaseUrl()}${pathname}`);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;
    const body = options.body ?? "";
    const request = client.request(
      url,
      {
        method: options.method ?? "GET",
        timeout: Number(process.env.POWER_WTI_HTTP_TIMEOUT_MS ?? 7000),
        headers: {
          Authorization: wtiAuthHeader(),
          Connection: "close",
          "User-Agent": "FountainStackPower/1.0",
          ...(body
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("latin1"),
            statusCode: response.statusCode ?? 0,
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("WTI HTTP request timed out."));
    });
    request.on("error", reject);

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

function parseWtiHtmlStates(html: string) {
  const states: Record<string, OutletState> = {};
  const rowPattern = /<tr><td[^>]*>\s*([1-8])\s*<\/td>([\s\S]*?)<\/tr>/gi;

  for (const row of html.matchAll(rowPattern)) {
    const outlet = row[1];
    const state = row[2].match(/alt="(ON|OFF)"/i)?.[1]?.toLowerCase();

    if (state === "on" || state === "off") {
      states[outlet] = state;
    }
  }

  return states;
}

async function readHttpPowerStates() {
  const response = await requestWti("/plugs.htm");

  if (response.statusCode !== 200) {
    throw new Error(`WTI HTTP status request failed with ${response.statusCode}.`);
  }

  return parseWtiHtmlStates(response.body);
}

async function setHttpOutletPower(outlet: number, action: "on" | "off" | "boot") {
  const value = {
    boot: "Boot",
    off: "Off",
    on: "On",
  }[action];
  const response = await requestWti("/plugs", {
    method: "POST",
    body: new URLSearchParams({ [`plug${outlet}`]: value }).toString(),
  });

  if (response.statusCode !== 200) {
    throw new Error(`WTI HTTP action request failed with ${response.statusCode}.`);
  }
}

export async function readPowerStates() {
  try {
    if (powerDriver() === "http") {
      return await readHttpPowerStates();
    }

    const result = await runSerial(["status"]);
    return result.states ?? {};
  } catch (error) {
    console.error(`Failed to read ${powerDriver()} power state`, error);
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

  if (powerDriver() === "http") {
    await setHttpOutletPower(outlet, action);
  } else {
    await runSerial([action, String(outlet)]);
  }

  await new Promise((resolve) => setTimeout(resolve, 800));
  return getOutletsWithState();
}
