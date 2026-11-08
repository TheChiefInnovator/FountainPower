import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { getOutletRecords, type OutletRecord } from "@/lib/db";
import { UNITS, type UnitId } from "@/lib/units";
import { inputDisconnected } from "@/lib/input-supply";

const execFileAsync = promisify(execFile);

export type OutletState = "on" | "off" | "unknown";

export type OutletView = OutletRecord & {
  canPowerOff: boolean;
  state: OutletState;
  inputDisconnected: boolean;
};

type SerialResult = {
  states?: Record<string, OutletState>;
  state?: OutletState;
  raw?: string;
};

type PowerDriver = "serial" | "http" | "telnet";

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

  if (driver === "telnet" || driver === "network") {
    return "telnet";
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

function telnetHost() {
  return process.env.POWER_WTI_TELNET_HOST ?? "192.168.1.150";
}

function telnetPort() {
  return Number(process.env.POWER_WTI_TELNET_PORT ?? 23);
}

function telnetPassword() {
  const password = process.env.POWER_WTI_TELNET_PASSWORD ?? process.env.POWER_WTI_PASSWORD;

  if (!password) {
    throw new Error("POWER_WTI_TELNET_PASSWORD or POWER_WTI_PASSWORD must be set for Telnet power control.");
  }

  return password;
}

function telnetTimeoutMs() {
  return Number(process.env.POWER_WTI_TELNET_TIMEOUT_MS ?? 8000);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function telnetCommand(command: string) {
  const attempts = Number(process.env.POWER_WTI_TELNET_ATTEMPTS ?? 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runTelnetCommand(command);
    } catch (error) {
      lastError = error;
      await wait(750 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("WTI Telnet command failed.");
}

function runTelnetCommand(command: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: telnetHost(), port: telnetPort() });
    const timeout = setTimeout(() => {
      socket.destroy(new Error("WTI Telnet command timed out."));
    }, telnetTimeoutMs());
    let raw = "";
    let settled = false;

    function finish(error?: Error) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.destroy();

      if (error) {
        reject(error);
      } else {
        resolve(raw);
      }
    }

    socket.on("data", (chunk) => {
      raw += chunk.toString("latin1");
    });
    socket.on("error", finish);

    socket.on("connect", async () => {
      try {
        await wait(350);
        socket.write(`${telnetPassword()}\r`);
        await wait(650);
        socket.write(`${command}\r`);
        await wait(2600);
        socket.write("/X\r");
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("WTI Telnet command failed."));
      }
    });
  });
}

async function readTelnetPowerStates() {
  return parseTelnetStates(await telnetCommand("/S"));
}

function parseTelnetStates(raw: string) {
  const states: Record<string, OutletState> = {};
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  const rowPattern = /\b([1-8])\s+\|\s+[^|]*\|\s+[^|]*\|\s+(ON|OFF)\s+\|/gi;

  for (const row of clean.matchAll(rowPattern)) {
    states[row[1]] = row[2].toLowerCase() as OutletState;
  }

  return states;
}

async function setTelnetOutletPower(outlet: number, action: "on" | "off" | "boot") {
  const command = {
    boot: "/Boot",
    off: "/Off",
    on: "/On",
  }[action];

  await telnetCommand(`${command} ${outlet},y`);
}

async function serialBridge(action: "status" | "on" | "off" | "boot", outlet?: number) {
  const url = process.env.POWER_UNIT2_BRIDGE_URL;
  const token = process.env.POWER_UNIT2_BRIDGE_TOKEN;
  if (!url || !token) throw new Error("Unit 2 serial bridge is not configured.");
  const response = await fetch(`${url.replace(/\/+$/, "")}/${action === "status" ? "status" : "action"}`, {
    method: action === "status" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(action === "status" ? {} : { body: JSON.stringify({ action, outlet }) }),
    signal: AbortSignal.timeout(25000),
    cache: "no-store",
  });
  const data = await response.json() as SerialResult & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Unit 2 serial bridge failed.");
  if (!data.states || Object.keys(data.states).length !== 8) throw new Error("Incomplete unit 2 status.");
  return data.states;
}

export async function readPowerStates(unit: UnitId = 1) {
  try {
    if (unit === 2) return await serialBridge("status");
    if (powerDriver() === "http") {
      return await readHttpPowerStates();
    }

    if (powerDriver() === "telnet") {
      return await readTelnetPowerStates();
    }

    const result = await runSerial(["status"]);
    return result.states ?? {};
  } catch (error) {
    console.error(`Failed to read ${powerDriver()} power state`, error);
    return {};
  }
}

export async function getOutletsWithState(): Promise<OutletView[]> {
  return (await Promise.all(UNITS.map(async ({ id }) => {
    const records = await getOutletRecords(id);
    const states = await readPowerStates(id);
    const protectedOutlets = id === 1 ? protectedOffOutlets() : new Set<number>();
    return records.map((record) => ({
      ...record,
      canPowerOff: !protectedOutlets.has(record.outlet),
      state: states[String(record.outlet)] ?? "unknown",
      inputDisconnected: inputDisconnected(id, record.outlet),
    }));
  }))).flat();
}

export async function setOutletPower(outlet: number, action: "on" | "off" | "boot", unit: UnitId = 1) {
  if (unit !== 1 && unit !== 2) throw new Error("Invalid power unit.");
  if (!Number.isInteger(outlet) || outlet < 1 || outlet > 8) {
    throw new Error("Outlet must be between 1 and 8.");
  }

  if (unit === 1 && action === "off" && protectedOffOutlets().has(outlet)) {
    throw new Error("This outlet hosts the power-control app and cannot be turned off. Use power cycle instead.");
  }

  if (unit === 2) {
    await serialBridge(action, outlet);
  } else if (powerDriver() === "http") {
    await setHttpOutletPower(outlet, action);
  } else if (powerDriver() === "telnet") {
    await setTelnetOutletPower(outlet, action);
  } else {
    await runSerial([action, String(outlet)]);
  }

  await new Promise((resolve) => setTimeout(resolve, 800));
  return getOutletsWithState();
}
