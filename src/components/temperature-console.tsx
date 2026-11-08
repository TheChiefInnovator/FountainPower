"use client";

import { Activity, AlertTriangle, ArrowLeft, Cpu, HardDrive, MemoryStick, RefreshCw, RotateCcw, Thermometer, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { HostResources, ResourceDisk, ResourceMemory, ResourceMetric, TemperatureHistory, TemperatureHost, TemperatureLatest } from "@/lib/temperatures";

const KIND_COLORS: Record<string, string> = {
  cpu: "#e4e4e7", gpu: "#facc15", nvme: "#fb923c", memory: "#6ee7b7",
  board: "#d6b68a", network: "#94a3b8", other: "#fda4af",
};
const RESOURCE_COLORS: Record<"cpu" | "memory", string> = { cpu: "#38bdf8", memory: "#34d399" };
const DISK_COLORS = ["#f59e0b", "#22d3ee", "#a3e635", "#fb7185", "#94a3b8", "#fbbf24", "#60a5fa", "#f472b6"];
const RESOURCE_TICKS = [0, 25, 50, 75, 100];
const RANGES = [[6, "6h"], [24, "24h"], [168, "7d"], [720, "30d"]] as const;
const RESOURCE_METRICS: [ResourceMetric, string][] = [["cpu", "CPU"], ["memory", "Memory"], ["disk", "Disk"]];
const RESOURCE_UNITS: Record<ResourceMetric, string> = { cpu: "CPU %", memory: "MEM %", disk: "DISK %" };
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

const formatTemp = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}°`;
const formatPercent = (value: number | null | undefined) => value === null || value === undefined ? "—" : `${value.toFixed(0)}%`;
const formatTime = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const heatClass = (value: number | null) => value === null ? "temp-muted" : value >= 90 ? "temp-critical" : value >= 80 ? "temp-hot" : value >= 60 ? "temp-warm" : "temp-normal";
const resourceClass = (value: number | null | undefined) => value === null || value === undefined ? "temp-muted" : value >= 95 ? "temp-critical" : value >= 85 ? "temp-hot" : value >= 70 ? "temp-warm" : "temp-normal";

function formatBytes(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) { size /= 1024; unit += 1; }
  return `${unit === 0 || size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

function percentOf(used: number, total: number) {
  return total > 0 ? (used / total) * 100 : null;
}

const diskPercent = (disk: ResourceDisk) => percentOf(disk.used_bytes, disk.used_bytes + disk.available_bytes);
const memoryPercent = (memory: ResourceMemory | null) => memory ? percentOf(memory.used_bytes, memory.total_bytes) : null;

// An unreported swap total and an unknown swap used figure must render as
// missing, never as 0%: only a real total with a real used value has a percent.
type SwapDisplay = { percent: number | null; label: string; total: string; detail: string };
function swapDisplay(memory: ResourceMemory | null): SwapDisplay {
  if (!memory || memory.swap_total_bytes === null) return { percent: null, label: "—", total: "", detail: "" };
  const total = formatBytes(memory.swap_total_bytes);
  if (memory.swap_total_bytes === 0) return { percent: null, label: "none", total: "", detail: "" };
  if (memory.swap_used_bytes === null) return { percent: null, label: "—", total, detail: `unknown of ${total}` };
  const percent = percentOf(memory.swap_used_bytes, memory.swap_total_bytes);
  return { percent, label: formatPercent(percent), total, detail: `${formatBytes(memory.swap_used_bytes)} of ${total}` };
}

function age(value: string | null, now: number) {
  if (!value) return "never";
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

type ResourceSummary = {
  cpu: number | null;
  memory: ResourceMemory | null;
  memoryPercent: number | null;
  disks: ResourceDisk[];
  worst: number | null;
};

function resourceSummary(host: TemperatureHost): ResourceSummary {
  const memory = host.resources?.memory ?? null;
  const disks = [...(host.resources?.disks ?? [])].sort((a, b) => (diskPercent(b) ?? -1) - (diskPercent(a) ?? -1));
  return {
    cpu: host.resources?.cpu?.usage_percent ?? null,
    memory,
    memoryPercent: memoryPercent(memory),
    disks,
    worst: disks.length ? diskPercent(disks[0]) : null,
  };
}

// A collector that supports resources still returns an empty object for samples
// recorded before migration 003; treat that as "not reported", not as "none".
function reportedResources(host: TemperatureHost) {
  const resources = host.resources;
  return Boolean(resources && (resources.cpu || resources.memory || resources.disks.length));
}

export function TemperatureConsole({ configured }: { configured: boolean }) {
  const [latest, setLatest] = useState<TemperatureLatest | null>(null);
  const [history, setHistory] = useState<TemperatureHistory | null>(null);
  const [resourceHistory, setResourceHistory] = useState<TemperatureHistory | null>(null);
  const [hours, setHours] = useState(24);
  const [resourceMetric, setResourceMetric] = useState<ResourceMetric>("cpu");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(configured);
  const [resourceBusy, setResourceBusy] = useState(configured);
  const [error, setError] = useState<string | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const resourcesSupported = Boolean(latest?.hosts.some((host) => host.resources !== undefined));

  useEffect(() => {
    if (!configured) return;
    const controller = new AbortController();
    async function load() {
      try {
        const responses = await Promise.all([
          fetch("/power/api/temperatures", { cache: "no-store", signal: controller.signal }),
          fetch(`/power/api/temperatures?view=history&hours=${hours}`, { cache: "no-store", signal: controller.signal }),
        ]);
        const [now_, past] = await Promise.all(responses.map((response) => response.json()));
        if (responses.some((response) => response.status === 401)) throw new Error("Session expired. Reopen Power from Coolify.");
        if (!responses[0].ok || !responses[1].ok) throw new Error(now_.error ?? past.error ?? "Could not refresh temperatures.");
        if (!controller.signal.aborted) {
          setLatest(now_);
          setHistory(past);
          setNow(Date.now());
          setError(null);
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Could not refresh temperatures.");
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [configured, hours, revision]);

  useEffect(() => {
    if (!configured || !resourcesSupported) return;
    const controller = new AbortController();
    async function load() {
      setResourceBusy(true);
      try {
        const response = await fetch(`/power/api/temperatures?view=history&hours=${hours}&metric=${resourceMetric}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (response.status === 401) throw new Error("Session expired. Reopen Power from Coolify.");
        if (!response.ok) throw new Error(data?.error ?? "Could not refresh resource history.");
        if (!controller.signal.aborted) {
          setResourceHistory(data);
          setResourceError(null);
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          setResourceHistory(null);
          setResourceError(caught instanceof Error ? caught.message : "Could not refresh resource history.");
        }
      } finally {
        if (!controller.signal.aborted) setResourceBusy(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [configured, resourcesSupported, hours, resourceMetric, revision]);

  useEffect(() => {
    if (!configured) return;
    const timer = setInterval(() => { setNow(Date.now()); setBusy(true); setRevision((value) => value + 1); }, 60_000);
    return () => clearInterval(timer);
  }, [configured]);

  const hosts = [...(latest?.hosts ?? [])].sort((a, b) => (b.max_celsius ?? -Infinity) - (a.max_celsius ?? -Infinity) || a.host.localeCompare(b.host));
  const detail = hosts.find((host) => host.host === selected);
  const chartHosts = [...new Set([...hosts.map((host) => host.host), ...(history?.series.map((series) => series.host) ?? [])])];
  const resourceHosts = [...new Set(resourceHistory?.series.map((series) => series.host) ?? [])].sort((a, b) => a.localeCompare(b));
  const diskMounts = [...new Set((resourceHistory?.series ?? []).filter((series) => series.kind === "disk").map((series) => series.mount ?? "unknown"))].sort((a, b) => a.localeCompare(b));
  const diskColors = mountColorMap(diskMounts);
  const diskColorFor = (mount: string) => diskColors[mount] ?? DISK_COLORS[0];
  const failed = hosts.filter((host) => host.status !== "ok").length;
  const stale = latest?.sweep_at && now - Date.parse(latest.sweep_at) > 11 * 60_000;

  return (
    <main className="temp-console">
      <div className="temp-shell">
        <header className="temp-header">
          <div><div className="temp-brand"><Thermometer size={15} /> FountainStack</div><h1>Temperatures</h1></div>
          <div className="temp-actions">
            <a className="temp-control" href="/power"><ArrowLeft size={14} /> Outlets</a>
            <button className="temp-control" disabled={!configured || busy} onClick={() => { setBusy(true); setRevision((value) => value + 1); }} aria-label="Refresh temperatures"><RefreshCw size={15} className={busy ? "animate-spin" : ""} /></button>
          </div>
        </header>
        <div className="temp-toolbar">
          <div className="temp-summary"><Activity size={14} /><span>{hosts.length} hosts</span><span className={failed ? "temp-hot" : "temp-muted"}>{failed} unavailable</span></div>
          <span className={stale ? "temp-hot" : "temp-muted"}>Last sweep {formatTime(latest?.sweep_at ?? null)}{stale ? " · stale" : ""} · refresh 60s</span>
        </div>
        {!configured ? <div className="temp-state"><Thermometer size={22} /><h2>Temperature service not configured</h2><p>Fleet temperatures will appear when the service is connected.</p></div> : null}
        {error ? <div className="temp-error" role="alert"><AlertTriangle size={16} /><span>{error}{latest ? " Showing the last received data." : ""}</span></div> : null}
        {configured && busy && !latest ? <div className="temp-state" role="status">Loading fleet temperatures…</div> : null}
        {configured && latest?.hosts.length === 0 ? <div className="temp-state">No samples yet. Waiting for the first fleet sweep.</div> : null}
        <section className="temp-fleet" aria-label="Fleet temperatures">
          {hosts.map((host) => <HostTile key={host.host} host={host} now={now} selected={selected === host.host} onClick={() => setSelected(selected === host.host ? null : host.host)} />)}
        </section>
        {detail ? <section className="temp-detail" aria-label={`${detail.host} sensor detail`}>
          <div className="temp-section-heading"><h2>{detail.host} <span className="temp-muted">/ sensors</span></h2><button className="temp-control" onClick={() => setSelected(null)} aria-label="Close sensor detail"><X size={15} /></button></div>
          <p className="temp-muted temp-detail-meta">Sample {formatTime(detail.collected_at)} · uptime {detail.uptime_s === null ? "—" : `${(detail.uptime_s / 86400).toFixed(1)}d`} · load {detail.load1 ?? "—"}</p>
          {detail.error ? <p className="temp-hot">{detail.error}</p> : null}
          {detail.warnings?.map((warning, index) => <p key={index} className="temp-warm temp-warning">{warning}</p>)}
          {detail.readings.length ? <div className="temp-table-wrap"><table><thead><tr><th>Kind</th><th>Chip / device</th><th>Sensor</th><th>°C</th><th>Crit °C</th></tr></thead><tbody>
            {detail.readings.map((sensor, index) => <tr key={index}><td>{sensor.kind}</td><td>{sensor.chip}<small>{sensor.device}</small></td><td>{sensor.label}</td><td className={heatClass(sensor.celsius)}>{sensor.celsius.toFixed(1)}</td><td>{sensor.crit?.toFixed(1) ?? "—"}</td></tr>)}
          </tbody></table></div> : <p className="temp-muted">{detail.status === "ok" ? "No sensors reported by this host." : "No readings in the current sweep."}</p>}
          <ResourceDetail resources={detail.resources} />
        </section> : null}
        {configured && hosts.length ? <section className="temp-resources" aria-label="Host resource overview">
          <div className="temp-section-heading">
            <h2>Resources <span className="temp-muted">/ CPU, memory, disk</span></h2>
            <span className="temp-muted">CPU = usage over a short sampling interval · RAM = total − available</span>
          </div>
          {!resourcesSupported ? <p className="temp-muted temp-warning">The collector has not reported resources yet. Deploy the updated collector to enable CPU, memory and disk metrics.</p> : null}
          <div className="temp-table-wrap"><table className="temp-res-table">
            <thead><tr><th>Host</th><th><Cpu size={11} /> CPU</th><th><MemoryStick size={11} /> Memory</th><th>Swap</th><th><HardDrive size={11} /> Filesystems</th></tr></thead>
            <tbody>
              {hosts.map((host) => {
                const summary = resourceSummary(host);
                const swap = swapDisplay(summary.memory);
                return <tr key={host.host} className={selected === host.host ? "temp-res-selected" : undefined}>
                  <td><button className="temp-host-link" aria-pressed={selected === host.host} onClick={() => setSelected(selected === host.host ? null : host.host)}>{host.host}</button>
                    <small>{host.status === "ok" ? (summary.disks.length ? `${summary.disks.length} fs` : "no fs") : host.status}</small></td>
                  <td className={resourceClass(summary.cpu)}>{formatPercent(summary.cpu)}<small>{host.resources?.cpu?.cores ? `${host.resources.cpu.cores} cores` : host.resources?.cpu?.window_s ? `${host.resources.cpu.window_s}s window` : ""}</small></td>
                  <td className={resourceClass(summary.memoryPercent)}>{formatPercent(summary.memoryPercent)}<small>{summary.memory ? `${formatBytes(summary.memory.used_bytes)} / ${formatBytes(summary.memory.total_bytes)}` : "not reported"}</small></td>
                  <td className={resourceClass(swap.percent)}>{swap.label}<small>{swap.total}</small></td>
                  <td>{summary.disks.length ? <ul className="temp-disk-list">
                    {summary.disks.map((disk) => <li key={disk.mount}><span className="temp-disk-mount" title={`${disk.device} (${disk.fstype})`}>{disk.mount}</span><b className={resourceClass(diskPercent(disk))}>{formatPercent(diskPercent(disk))}</b></li>)}
                  </ul> : <span className="temp-muted">{reportedResources(host) ? "No local filesystems" : "Not reported"}</span>}</td>
                </tr>;
              })}
            </tbody>
          </table></div>
        </section> : null}
        {configured && chartHosts.length > 0 ? <section aria-label="Temperature history" className="temp-history">
          <div className="temp-section-heading"><h2>Thermal history <span className="temp-muted">/ max by kind</span></h2><div className="temp-ranges" aria-label="History range">{RANGES.map(([value, label]) => <button key={value} aria-pressed={hours === value} onClick={() => { setHours(value); setBusy(true); }} disabled={hours === value}>{label}</button>)}</div></div>
          <div className="temp-legend">{Object.entries(KIND_COLORS).map(([kind, color]) => <span key={kind}><i style={{ background: color }} />{kind}</span>)}<span className="temp-muted">Dashed: 80° / 90° · drag to zoom</span></div>
          <div className="temp-charts" aria-busy={busy}>{history ? chartHosts.map((host) => {
            const series = temperatureSeries(host, history);
            const values = series.flatMap((line) => line.points.map(([, value]) => value));
            const min = Math.min(20, ...values.map((value) => Math.floor(value / 10) * 10));
            const max = Math.max(100, ...values.map((value) => Math.ceil(value / 10) * 10));
            return <TimeChart key={`${host}-${hours}`} title={<>{host}<span className="temp-muted">°C</span></>} ariaLabel={`${host} temperature history`} from={history.from} to={history.to} bucketSeconds={history.bucket_seconds} series={series} yTicks={[min, 60, 80, 90, max]} thresholds={[80, 90]} formatValue={(value) => `${value.toFixed(1)}°C`} emptyLabel="No readings in this range" />;
          }) : null}</div>
        </section> : null}
        {configured && resourcesSupported ? <section aria-label="Resource history" className="temp-history">
          <div className="temp-section-heading"><h2>Resource history <span className="temp-muted">/ percent by host</span></h2><div className="temp-ranges" aria-label="Resource metric">{RESOURCE_METRICS.map(([value, label]) => <button key={value} aria-pressed={resourceMetric === value} onClick={() => { setResourceMetric(value); setResourceBusy(true); }} disabled={resourceMetric === value}>{label}</button>)}</div></div>
          <div className="temp-legend">
            {resourceMetric === "disk"
              ? (diskMounts.length ? diskMounts.map((mount) => <span key={mount}><i style={{ background: diskColorFor(mount) }} />{mount}</span>) : <span className="temp-muted">No filesystem series</span>)
              : <span><i style={{ background: RESOURCE_COLORS[resourceMetric] }} />{resourceMetric === "cpu" ? "CPU usage" : "memory used"}</span>}
            <span className="temp-muted">Percent · dashed: 90% · drag to zoom</span>
          </div>
          {resourceError ? <div className="temp-error" role="alert"><AlertTriangle size={16} /><span>{resourceError}</span></div> : null}
          <div className="temp-charts" aria-busy={resourceBusy}>{resourceHistory ? (resourceHosts.length ? resourceHosts.map((host) => <TimeChart key={`${host}-${resourceMetric}-${hours}`} title={<>{host}<span className="temp-muted">{RESOURCE_UNITS[resourceMetric]}</span></>} ariaLabel={`${host} ${resourceMetric === "disk" ? "filesystem" : resourceMetric} usage history`} from={resourceHistory.from} to={resourceHistory.to} bucketSeconds={resourceHistory.bucket_seconds} series={resourceSeries(host, resourceMetric, resourceHistory, diskColorFor)} yTicks={RESOURCE_TICKS} thresholds={[90]} formatValue={(value) => `${value.toFixed(1)}%`} valueClass={resourceClass} emptyLabel={`No ${resourceMetric} history in this range`} />) : <div className="temp-chart-empty">No resource history in this range</div>) : null}</div>
        </section> : null}
      </div>
    </main>
  );
}

function HostTile({ host, now, selected, onClick }: { host: TemperatureHost; now: number; selected: boolean; onClick: () => void }) {
  const maxima = (kind: string) => {
    const values = host.readings.filter((sensor) => sensor.kind === kind).map((sensor) => sensor.celsius);
    return values.length ? Math.max(...values) : null;
  };
  const summary = resourceSummary(host);
  return <button className={`temp-host ${host.status !== "ok" ? "temp-host-failed" : ""}`} aria-expanded={selected} onClick={onClick}>
    <span className="temp-host-name">{host.host}</span>
    <span className={`temp-host-status ${host.status === "ok" ? "temp-muted" : "temp-hot"}`}>{host.status === "ok" ? "OK" : host.status.toUpperCase()}{host.status !== "ok" ? <small>last good {age(host.last_good_at, now)}</small> : null}</span>
    <span className={`temp-host-value ${heatClass(host.max_celsius)}`}>{formatTemp(host.max_celsius)}<small>{host.max_celsius === null ? host.status === "ok" ? "no sensors" : "no sample" : "°C peak"}</small></span>
    <span className="temp-host-kinds">{["cpu", "gpu", "nvme"].map((kind) => <span key={kind}>{kind.toUpperCase()} <b className={heatClass(maxima(kind))}>{formatTemp(maxima(kind))}</b></span>)}</span>
    {host.resources !== undefined ? <span className="temp-host-res">
      <span>CPU <b className={resourceClass(summary.cpu)}>{formatPercent(summary.cpu)}</b></span>
      <span>MEM <b className={resourceClass(summary.memoryPercent)}>{formatPercent(summary.memoryPercent)}</b></span>
      <span>DISK <b className={resourceClass(summary.worst)}>{formatPercent(summary.worst)}</b></span>
    </span> : null}
  </button>;
}

function ResourceDetail({ resources }: { resources?: HostResources | null }) {
  if (resources === undefined) return <p className="temp-muted temp-warning">This collector does not report CPU, memory or disk resources.</p>;
  if (resources === null) return <p className="temp-muted temp-warning">No resources were reported in the current sweep.</p>;
  const cpu = resources.cpu;
  const memory = resources.memory;
  const swap = swapDisplay(memory);
  const disks = [...resources.disks].sort((a, b) => (diskPercent(b) ?? -1) - (diskPercent(a) ?? -1));
  if (!cpu && !memory && !disks.length) return <p className="temp-muted temp-warning">No resources were reported before migration 003. New sweeps will include them.</p>;
  return <div className="temp-detail-resources">
    <h3 className="temp-detail-subhead"><Cpu size={13} /> Resources</h3>
    <dl className="temp-res-grid">
      <div><dt>CPU usage</dt><dd className={resourceClass(cpu?.usage_percent ?? null)}>{cpu ? `${cpu.usage_percent.toFixed(1)}%` : "—"}<small>{cpu ? `${cpu.cores ?? "?"} cores${cpu.window_s ? ` · ${cpu.window_s}s interval` : ""}` : "not reported"}</small></dd></div>
      <div><dt>Memory used</dt><dd className={resourceClass(memoryPercent(memory))}>{memory ? `${formatPercent(memoryPercent(memory))}` : "—"}<small>{memory ? `${formatBytes(memory.used_bytes)} of ${formatBytes(memory.total_bytes)}` : "not reported"}</small></dd></div>
      <div><dt>Memory available</dt><dd>{memory ? formatBytes(memory.available_bytes) : "—"}<small>{memory ? `${formatBytes(memory.total_bytes)} total` : ""}</small></dd></div>
      <div><dt>Swap</dt><dd className={resourceClass(swap.percent)}>{swap.label}<small>{swap.detail}</small></dd></div>
    </dl>
    {disks.length ? <div className="temp-table-wrap"><table><thead><tr><th>Mount</th><th>Device / fs</th><th>Used</th><th>Available</th><th>Used %</th></tr></thead><tbody>
      {disks.map((disk) => <tr key={disk.mount}><td>{disk.mount}</td><td>{disk.device}<small>{disk.fstype}</small></td><td>{formatBytes(disk.used_bytes)}</td><td>{formatBytes(disk.available_bytes)}</td><td className={resourceClass(diskPercent(disk))}>{formatPercent(diskPercent(disk))}</td></tr>)}
    </tbody></table></div> : <p className="temp-muted temp-warning">No local filesystems were reported.</p>}
  </div>;
}

type ChartSeries = { key: string; label: string; color: string; points: [string, number][] };

// Legend and per-host charts must agree on a mount's colour. Assign from one
// sorted mount list instead of each host's series order.
function mountColorMap(mounts: string[]): Record<string, string> {
  return Object.fromEntries([...new Set(mounts)].sort((a, b) => a.localeCompare(b))
    .map((mount, index) => [mount, DISK_COLORS[index % DISK_COLORS.length]]));
}

function temperatureSeries(host: string, history: TemperatureHistory): ChartSeries[] {
  return history.series.filter((series) => series.host === host).map((series) => ({
    key: series.kind, label: series.kind, color: KIND_COLORS[series.kind] ?? KIND_COLORS.other, points: series.points,
  }));
}

function resourceSeries(host: string, metric: ResourceMetric, history: TemperatureHistory, diskColorFor: (mount: string) => string): ChartSeries[] {
  const lines = history.series.filter((series) => series.host === host);
  if (metric === "disk") {
    return lines.map((line, index) => ({
      key: line.mount ?? `disk-${index}`, label: line.mount ?? "unknown", color: diskColorFor(line.mount ?? "unknown"), points: line.points,
    }));
  }
  return lines.map((line) => ({ key: metric, label: metric, color: RESOURCE_COLORS[metric], points: line.points }));
}

function TimeChart({ title, ariaLabel, from, to, bucketSeconds, series, yTicks, thresholds = [], formatValue, valueClass = heatClass, emptyLabel }: {
  title: ReactNode;
  ariaLabel: string;
  from: string;
  to: string;
  bucketSeconds: number;
  series: ChartSeries[];
  yTicks: number[];
  thresholds?: number[];
  formatValue: (value: number) => string;
  valueClass?: (value: number) => string;
  emptyLabel: string;
}) {
  const titleId = useId();
  const clipId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const drag = useRef<{ pointerId: number; start: number; current: number } | null>(null);

  const width = 480, height = 190, left = 35, right = 12, top = 15, bottom = 30;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const fullStart = Date.parse(from), fullEnd = Date.parse(to);
  const start = zoom ? zoom[0] : fullStart;
  const end = zoom ? zoom[1] : fullEnd;
  const span = Math.max(1, end - start);
  const ticks = [...new Set(yTicks)].sort((a, b) => a - b);
  const min = ticks[0], max = ticks[ticks.length - 1];
  const scale = Math.max(1, max - min);
  const minSpan = Math.max(60_000, bucketSeconds * 1000);

  const all = series.flatMap((line) => line.points.map(([at, value]) => ({ time: Date.parse(at), value, key: line.key, color: line.color })))
    .sort((a, b) => a.time - b.time || a.key.localeCompare(b.key));
  const visible = all.filter((point) => point.time >= start && point.time <= end);
  const active = hover === null ? null : visible[hover] ?? null;

  const toX = (time: number) => left + ((time - start) / span) * plotWidth;
  const toY = (value: number) => top + ((max - value) / scale) * plotHeight;
  const pointerTime = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = Math.min(width - right, Math.max(left, ((event.clientX - box.left) / box.width) * width));
    return start + ((px - left) / plotWidth) * span;
  };
  const reset = () => { setZoom(null); setHover(null); };
  const trackHover = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const py = ((event.clientY - box.top) / box.height) * height;
    let best = -1, distance = Infinity;
    visible.forEach((point, index) => {
      const delta = (toX(point.time) - px) ** 2 + (toY(point.value) - py) ** 2;
      if (delta < distance) { best = index; distance = delta; }
    });
    setHover(best >= 0 ? best : null);
  };
  const release = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const labelFormat: Intl.DateTimeFormatOptions = span > 2 * 86_400_000 ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" };

  return <article className="temp-chart"><h3 id={titleId}>{title}</h3>
    {all.length ? <>
      <div className="temp-chart-tools">
        <button className="temp-zoom-reset" onClick={reset} disabled={!zoom} aria-label={`Reset zoom for ${ariaLabel}`}><RotateCcw size={11} /> Reset</button>
        <span className="temp-muted">{zoom ? `${new Date(start).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} → ${new Date(end).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "drag to zoom"}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} aria-label={`${ariaLabel}; drag to zoom, arrow keys inspect readings, Escape resets zoom`} tabIndex={0}
        onPointerDown={(event) => {
          if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const time = pointerTime(event);
          drag.current = { pointerId: event.pointerId, start: time, current: time };
          setSelection([time, time]);
          trackHover(event);
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          // A captured drag continues even when the cursor leaves the plot, but it
          // must stop as soon as the button is released (lost capture, window blur).
          if (state && state.pointerId === event.pointerId && (event.pointerType !== "mouse" || event.buttons !== 0)) {
            state.current = pointerTime(event);
            setSelection([state.start, state.current]);
            return;
          }
          if (state) {
            drag.current = null;
            setSelection(null);
          }
          trackHover(event);
        }}
        onPointerUp={(event) => {
          const state = drag.current;
          drag.current = null;
          setSelection(null);
          release(event);
          if (!state) return;
          const lower = Math.min(state.start, state.current), upper = Math.max(state.start, state.current);
          if (upper - lower >= minSpan) {
            setZoom([Math.max(lower, fullStart), Math.min(upper, fullEnd)]);
            setHover(null);
          }
        }}
        onPointerCancel={(event) => { drag.current = null; setSelection(null); release(event); }}
        onDoubleClick={reset}
        onPointerLeave={() => { if (!drag.current) setHover(null); }}
        onFocus={() => { if (visible.length) setHover(0); }}
        onBlur={() => setHover(null)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); reset(); return; }
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setHover((value) => Math.max(0, Math.min(visible.length - 1, (value ?? 0) + (event.key === "ArrowRight" ? 1 : -1)))); }
        }}>
        <defs><clipPath id={clipId}><rect x={left} y={top} width={plotWidth} height={plotHeight} /></clipPath></defs>
        {ticks.map((value) => <g key={value}><line x1={left} x2={width - right} y1={toY(value)} y2={toY(value)} stroke={thresholds.includes(value) ? "#7f3930" : "#27272a"} strokeDasharray={thresholds.includes(value) ? "4 4" : undefined} /><text x={left - 7} y={toY(value) + 4} textAnchor="end">{value}</text></g>)}
        {[0, 0.5, 1].map((fraction) => <text key={fraction} x={left + fraction * plotWidth} y={height - 7} textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}>{new Date(start + fraction * span).toLocaleString(undefined, labelFormat)}</text>)}
        <g clipPath={`url(#${clipId})`}>
          {series.map((line) => <g key={line.key}><path fill="none" stroke={line.color} strokeWidth={1.7} d={line.points.map(([at, value], index) => `${index === 0 || Date.parse(at) - Date.parse(line.points[index - 1][0]) > bucketSeconds * 1000 * 1.8 ? "M" : "L"}${toX(Date.parse(at)).toFixed(1)},${toY(value).toFixed(1)}`).join(" ")} />{line.points.length === 1 ? <circle cx={toX(Date.parse(line.points[0][0]))} cy={toY(line.points[0][1])} r={3} fill={line.color} /> : null}</g>)}
          {active ? <g><line x1={toX(active.time)} x2={toX(active.time)} y1={top} y2={height - bottom} stroke="#71717a" strokeDasharray="2 3" /><circle cx={toX(active.time)} cy={toY(active.value)} r={4} fill={active.color} stroke="#09090b" strokeWidth={2} /></g> : null}
        </g>
        {selection ? <rect x={Math.min(width - right, Math.max(left, Math.min(toX(selection[0]), toX(selection[1]))))} y={top} width={Math.min(plotWidth, Math.abs(toX(selection[1]) - toX(selection[0])))} height={plotHeight} fill={RESOURCE_COLORS.cpu} opacity={0.14} pointerEvents="none" /> : null}
      </svg>
      <div className="temp-tooltip" aria-live="polite">{active ? <><span>{formatTime(new Date(active.time).toISOString())} · {active.key}</span><b className={valueClass(active.value)}>{formatValue(active.value)}</b></> : <span className="temp-muted">Drag to zoom · hover or focus to inspect</span>}</div>
    </> : <div className="temp-chart-empty">{emptyLabel}</div>}
  </article>;
}
