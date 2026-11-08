"use client";

import { Activity, AlertTriangle, ArrowLeft, RefreshCw, Thermometer, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { TemperatureHistory, TemperatureHost, TemperatureLatest, TemperatureSeries } from "@/lib/temperatures";

const KIND_COLORS: Record<string, string> = {
  cpu: "#e4e4e7", gpu: "#facc15", nvme: "#fb923c", memory: "#6ee7b7",
  board: "#d6b68a", network: "#94a3b8", other: "#fda4af",
};
const RANGES = [[6, "6h"], [24, "24h"], [168, "7d"], [720, "30d"]] as const;
const formatTemp = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}°`;
const heatClass = (value: number | null) => value === null ? "temp-muted" : value >= 90 ? "temp-critical" : value >= 80 ? "temp-hot" : value >= 60 ? "temp-warm" : "temp-normal";
const formatTime = (value: string | null) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

function age(value: string | null, now: number) {
  if (!value) return "never";
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

export function TemperatureConsole({ configured }: { configured: boolean }) {
  const [latest, setLatest] = useState<TemperatureLatest | null>(null);
  const [history, setHistory] = useState<TemperatureHistory | null>(null);
  const [hours, setHours] = useState(24);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(configured);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!configured) return;
    const controller = new AbortController();
    async function load() {
      try {
        const responses = await Promise.all([
          fetch("/power/api/temperatures", { cache: "no-store", signal: controller.signal }),
          fetch(`/power/api/temperatures?view=history&hours=${hours}`, { cache: "no-store", signal: controller.signal }),
        ]);
        const [now, past] = await Promise.all(responses.map((response) => response.json()));
        if (responses.some((response) => response.status === 401)) throw new Error("Session expired. Reopen Power from Coolify.");
        if (!responses[0].ok || !responses[1].ok) throw new Error(now.error ?? past.error ?? "Could not refresh temperatures.");
        if (!controller.signal.aborted) {
          setLatest(now);
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
    if (!configured) return;
    const timer = setInterval(() => { setNow(Date.now()); setBusy(true); setRevision((value) => value + 1); }, 60_000);
    return () => clearInterval(timer);
  }, [configured]);

  const hosts = [...(latest?.hosts ?? [])].sort((a, b) => (b.max_celsius ?? -Infinity) - (a.max_celsius ?? -Infinity) || a.host.localeCompare(b.host));
  const detail = hosts.find((host) => host.host === selected);
  const chartHosts = [...new Set([...hosts.map((host) => host.host), ...(history?.series.map((series) => series.host) ?? [])])];
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
        </section> : null}
        {configured && chartHosts.length > 0 ? <section aria-label="Temperature history" className="temp-history">
          <div className="temp-section-heading"><h2>Thermal history <span className="temp-muted">/ max by kind</span></h2><div className="temp-ranges" aria-label="History range">{RANGES.map(([value, label]) => <button key={value} aria-pressed={hours === value} onClick={() => { setHours(value); setBusy(true); }} disabled={hours === value}>{label}</button>)}</div></div>
          <div className="temp-legend">{Object.entries(KIND_COLORS).map(([kind, color]) => <span key={kind}><i style={{ background: color }} />{kind}</span>)}<span className="temp-muted">Dashed: 80° / 90°</span></div>
          <div className="temp-charts" aria-busy={busy}>{history ? chartHosts.map((host) => <TemperatureChart key={`${host}-${hours}`} host={host} history={history} series={history.series.filter((series) => series.host === host)} />) : null}</div>
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
  return <button className={`temp-host ${host.status !== "ok" ? "temp-host-failed" : ""}`} aria-expanded={selected} onClick={onClick}>
    <span className="temp-host-name">{host.host}</span>
    <span className={`temp-host-status ${host.status === "ok" ? "temp-muted" : "temp-hot"}`}>{host.status === "ok" ? "OK" : host.status.toUpperCase()}{host.status !== "ok" ? <small>last good {age(host.last_good_at, now)}</small> : null}</span>
    <span className={`temp-host-value ${heatClass(host.max_celsius)}`}>{formatTemp(host.max_celsius)}<small>{host.max_celsius === null ? host.status === "ok" ? "no sensors" : "no sample" : "°C peak"}</small></span>
    <span className="temp-host-kinds">{["cpu", "gpu", "nvme"].map((kind) => <span key={kind}>{kind.toUpperCase()} <b className={heatClass(maxima(kind))}>{formatTemp(maxima(kind))}</b></span>)}</span>
  </button>;
}

function TemperatureChart({ host, history, series }: { host: string; history: TemperatureHistory; series: TemperatureSeries[] }) {
  const titleId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const width = 480, height = 190, left = 35, right = 12, top = 15, bottom = 30;
  const start = Date.parse(history.from), end = Date.parse(history.to);
  const all = series.flatMap((line) => line.points.map(([at, value]) => ({ at, value, kind: line.kind }))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.kind.localeCompare(b.kind));
  const min = Math.min(20, ...all.map((point) => Math.floor(point.value / 10) * 10));
  const max = Math.max(100, ...all.map((point) => Math.ceil(point.value / 10) * 10));
  const x = (at: string) => left + Math.max(0, Math.min(1, (Date.parse(at) - start) / Math.max(1, end - start))) * (width - left - right);
  const y = (value: number) => top + (max - value) / (max - min) * (height - top - bottom);
  const active = hover === null ? null : all[hover];
  return <article className="temp-chart"><h3 id={titleId}>{host}<span className="temp-muted">°C</span></h3>
    {all.length ? <>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} aria-label={`${host} temperature history; arrow keys inspect readings`} tabIndex={0}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const px = (event.clientX - box.left) / box.width * width, py = (event.clientY - box.top) / box.height * height;
          let best = 0, distance = Infinity;
          all.forEach((point, index) => { const d = (x(point.at) - px) ** 2 + (y(point.value) - py) ** 2; if (d < distance) { best = index; distance = d; } });
          setHover(best);
        }} onPointerLeave={() => setHover(null)} onFocus={() => setHover(0)} onBlur={() => setHover(null)} onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setHover((value) => Math.max(0, Math.min(all.length - 1, (value ?? 0) + (event.key === "ArrowRight" ? 1 : -1)))); }
        }}>
        {[min, 60, 80, 90, max].filter((value, index, values) => values.indexOf(value) === index).map((value) => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke={value >= 80 && value <= 90 ? "#7f3930" : "#27272a"} strokeDasharray={value === 80 || value === 90 ? "4 4" : undefined} /><text x={left - 7} y={y(value) + 4} textAnchor="end">{value}</text></g>)}
        {[0, 0.5, 1].map((fraction) => <text key={fraction} x={left + fraction * (width - left - right)} y={height - 7} textAnchor={fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}>{new Date(start + fraction * (end - start)).toLocaleString(undefined, hoursFor(history) > 24 ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" })}</text>)}
        {series.map((line) => <g key={line.kind}><path fill="none" stroke={KIND_COLORS[line.kind] ?? KIND_COLORS.other} strokeWidth={1.7} d={line.points.map(([at, value], index) => `${index === 0 || Date.parse(at) - Date.parse(line.points[index - 1][0]) > history.bucket_seconds * 1000 * 1.8 ? "M" : "L"}${x(at).toFixed(1)},${y(value).toFixed(1)}`).join(" ")} />{line.points.length === 1 ? <circle cx={x(line.points[0][0])} cy={y(line.points[0][1])} r={3} fill={KIND_COLORS[line.kind]} /> : null}</g>)}
        {active ? <g><line x1={x(active.at)} x2={x(active.at)} y1={top} y2={height - bottom} stroke="#71717a" strokeDasharray="2 3" /><circle cx={x(active.at)} cy={y(active.value)} r={4} fill={KIND_COLORS[active.kind]} stroke="#09090b" strokeWidth={2} /></g> : null}
      </svg>
      <div className="temp-tooltip" aria-live="polite">{active ? <><span>{formatTime(active.at)} · {active.kind}</span><b className={heatClass(active.value)}>{formatTemp(active.value)}C</b></> : <span className="temp-muted">Hover or focus chart to inspect</span>}</div>
    </> : <div className="temp-chart-empty">No readings in this range</div>}
  </article>;
}

function hoursFor(history: TemperatureHistory) {
  return (Date.parse(history.to) - Date.parse(history.from)) / 3_600_000;
}
