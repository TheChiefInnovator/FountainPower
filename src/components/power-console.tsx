"use client";

import { Edit3, ExternalLink, Loader2, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import { useState, useSyncExternalStore, useTransition } from "react";
import { cn } from "@/lib/utils";
import type { OutletView } from "@/lib/power";
import { UNITS, type UnitId } from "@/lib/units";

type PowerConsoleProps = {
  initialOutlets: OutletView[];
  sessionExpiresAt: number;
};

type EditingState = {
  unit: UnitId;
  outlet: number;
  label: string;
  server: string;
} | null;

const subscribeToLocale = () => () => {};

export function PowerConsole({ initialOutlets, sessionExpiresAt }: PowerConsoleProps) {
  const [outlets, setOutlets] = useState(initialOutlets);
  const [editing, setEditing] = useState<EditingState>(null);
  const [pendingOutlet, setPendingOutlet] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();

  const onlineCount = outlets.filter((outlet) => outlet.state === "on" && !outlet.inputDisconnected).length;
  const sessionExpires = useSyncExternalStore(
    subscribeToLocale,
    () => new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(sessionExpiresAt * 1000)),
    () => "—",
  );

  async function refresh() {
    setError(null);
    startRefresh(async () => {
      const response = await fetch("/power/api/outlets", { cache: "no-store" });
      const data = (await response.json()) as { outlets?: OutletView[]; error?: string };

      if (!response.ok || !data.outlets) {
        setError(data.error ?? "Could not refresh outlet state.");
        return;
      }

      setOutlets(data.outlets);
    });
  }

  async function runAction(outlet: OutletView, action: "on" | "off" | "boot") {
    setPendingOutlet(`${outlet.unit}:${outlet.outlet}`);
    setError(null);

    try {
      const response = await fetch(`/power/api/outlets/${outlet.outlet}/action?unit=${outlet.unit}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await response.json()) as { outlets?: OutletView[]; error?: string };

      if (!response.ok || !data.outlets) {
        throw new Error(data.error ?? "Power action failed.");
      }

      setOutlets(data.outlets);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Power action failed.");
    } finally {
      setPendingOutlet(null);
    }
  }

  async function saveEdit() {
    if (!editing) {
      return;
    }

    setPendingOutlet(`${editing.unit}:${editing.outlet}`);
    setError(null);

    try {
      const response = await fetch(`/power/api/outlets/${editing.outlet}?unit=${editing.unit}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: editing.label, server: editing.server }),
      });
      const data = (await response.json()) as { outlet?: OutletView; error?: string };

      if (!response.ok || !data.outlet) {
        throw new Error(data.error ?? "Could not save outlet.");
      }

      setOutlets((current) =>
        current.map((outlet) => (outlet.unit === data.outlet?.unit && outlet.outlet === data.outlet?.outlet ? { ...outlet, ...data.outlet } : outlet)),
      );
      setEditing(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save outlet.");
    } finally {
      setPendingOutlet(null);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border)] pb-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-[var(--accent)]">
              <span className="h-2 w-2 rounded-full bg-[var(--accent)] shadow-[0_0_22px_rgba(250,204,21,0.55)]" />
              FountainStack
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal text-zinc-50 sm:text-3xl">
              Power
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <a href="/power/temperatures" className="inline-flex h-9 items-center rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 text-sm font-medium text-zinc-100 transition hover:border-[var(--border-strong)]">
              Temperatures
            </a>
            <button
              type="button"
              onClick={refresh}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--panel)] text-zinc-200 transition hover:border-[var(--border-strong)] hover:bg-[var(--panel-raised)]"
              aria-label="Refresh outlet state"
              title="Refresh"
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            </button>
            <a
              href="https://coolify.theci.io"
              className="inline-flex h-9 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 text-sm font-medium text-zinc-100 transition hover:border-[var(--border-strong)] hover:bg-[var(--panel-raised)]"
            >
              Back to Coolify
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </header>

        <section className="grid gap-3 border-b border-[var(--border)] py-4 sm:grid-cols-3">
          <Metric label="Outlets on" value={`${onlineCount}/${outlets.length}`} />
          <Metric label="Session expires" value={sessionExpires} />
          <Metric label="Power units" value="2 · LAN + Serial" />
        </section>

        <p className="mt-3 text-xs text-zinc-400">
          ON/OFF reflects the relay setting, not measured voltage. Input connections are recorded manually;
          outlets with a disconnected input are excluded from the on count.
        </p>

        {error ? (
          <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {UNITS.map((unit) => <section key={unit.id} aria-label={unit.label} className="mt-4 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--panel)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-3">
            <h2 className="text-sm font-semibold">{unit.label} <span className="ml-2 font-normal text-zinc-400">{unit.connection}</span></h2>
            <span className="text-xs text-zinc-400">{outlets.filter((outlet) => outlet.unit === unit.id && outlet.state === "on" && !outlet.inputDisconnected).length}/8 on</span>
          </div>
          {outlets.some((outlet) => outlet.unit === unit.id && outlet.inputDisconnected) && (
            <p className="border-b border-[var(--border)] px-3 py-2 text-xs text-amber-200">
              Input disconnected for outlets {outlets.filter((outlet) => outlet.unit === unit.id && outlet.inputDisconnected).map((outlet) => outlet.outlet).join(", ")} · operator confirmed.
            </p>
          )}
          <div className="grid grid-cols-[72px_1fr] border-b border-[var(--border)] bg-zinc-950/45 px-3 py-2 text-xs font-medium uppercase tracking-normal text-zinc-500 sm:grid-cols-[72px_1.2fr_1.7fr_160px_168px]">
            <span>Outlet</span>
            <span>Label</span>
            <span className="hidden sm:block">Server</span>
            <span className="hidden sm:block">State</span>
            <span className="hidden text-right sm:block">Actions</span>
          </div>

          <div className="divide-y divide-[var(--border)]">
            {outlets.filter((outlet) => outlet.unit === unit.id).map((outlet) => {
              const isPending = pendingOutlet === `${outlet.unit}:${outlet.outlet}`;
              const isEditing = editing?.unit === outlet.unit && editing?.outlet === outlet.outlet;
              const isOn = outlet.state === "on";
              const cannotPowerOff = isOn && !outlet.canPowerOff;

              return (
                <div
                  key={`${outlet.unit}:${outlet.outlet}`}
                  className="grid grid-cols-[72px_1fr] items-center gap-3 px-3 py-3 sm:grid-cols-[72px_1.2fr_1.7fr_160px_168px]"
                >
                  <div className="font-mono text-sm text-zinc-400">#{outlet.outlet}</div>

                  <div className="min-w-0">
                    {isEditing ? (
                      <input
                        value={editing.label}
                        onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                        className="h-9 w-full rounded-md border border-[var(--border-strong)] bg-zinc-950 px-2 text-sm text-zinc-50 outline-none ring-0 transition focus:border-[var(--accent)]"
                      />
                    ) : (
                      <div className="truncate text-sm font-semibold text-zinc-50">{outlet.label}</div>
                    )}
                    <div className="mt-1 text-xs text-zinc-500 sm:hidden">{outlet.server}</div>
                  </div>

                  <div className="hidden min-w-0 sm:block">
                    {isEditing ? (
                      <input
                        value={editing.server}
                        onChange={(event) => setEditing({ ...editing, server: event.target.value })}
                        className="h-9 w-full rounded-md border border-[var(--border-strong)] bg-zinc-950 px-2 text-sm text-zinc-50 outline-none ring-0 transition focus:border-[var(--accent)]"
                      />
                    ) : (
                      <div className="truncate text-sm text-zinc-400">{outlet.server}</div>
                    )}
                  </div>

                  <div className="col-start-2 flex items-center gap-2 sm:col-start-auto">
                    {outlet.inputDisconnected ? (
                      <div>
                        <div className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs font-semibold text-zinc-300">NO INPUT POWER</div>
                        <div className="mt-1 text-xs text-zinc-500">Relay: {outlet.state.toUpperCase()}</div>
                      </div>
                    ) : (
                    <button
                      type="button"
                      disabled={pendingOutlet !== null || outlet.state === "unknown" || cannotPowerOff}
                      onClick={() => runAction(outlet, isOn ? "off" : "on")}
                      title={cannotPowerOff ? "FountainSeven hosts this app; use power cycle instead." : "Toggle power"}
                      className={cn(
                        "inline-flex h-8 w-[92px] items-center rounded-full border px-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-55",
                        isOn
                          ? "justify-end border-emerald-400/25 bg-emerald-500/15 text-emerald-200"
                          : "justify-start border-zinc-700 bg-zinc-900 text-zinc-400",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex h-6 min-w-12 items-center justify-center rounded-full px-2",
                          isOn ? "bg-emerald-400 text-emerald-950" : "bg-zinc-700 text-zinc-200",
                        )}
                      >
                        {outlet.state === "unknown" ? "UNK" : isOn ? "ON" : "OFF"}
                      </span>
                    </button>
                    )}
                  </div>

                  <div className="col-span-2 flex justify-end gap-2 sm:col-span-1">
                    {isEditing ? (
                      <>
                        <IconButton label="Cancel" onClick={() => setEditing(null)} disabled={isPending}>
                          <X className="h-4 w-4" />
                        </IconButton>
                        <IconButton label="Save" onClick={saveEdit} disabled={isPending}>
                          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        </IconButton>
                      </>
                    ) : (
                      <>
                        <IconButton
                          label="Power cycle"
                          onClick={() => runAction(outlet, "boot")}
                          disabled={!isOn || outlet.inputDisconnected || pendingOutlet !== null}
                        >
                          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                        </IconButton>
                        <IconButton
                          label="Edit label"
                          onClick={() =>
                            setEditing({
                              unit: outlet.unit,
                              outlet: outlet.outlet,
                              label: outlet.label,
                              server: outlet.server,
                            })
                          }
                          disabled={isPending}
                        >
                          <Edit3 className="h-4 w-4" />
                        </IconButton>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>)}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-2">
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--border)] bg-zinc-950/50 text-zinc-300 transition hover:border-[var(--border-strong)] hover:bg-zinc-900 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-45"
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
