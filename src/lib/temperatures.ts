export type TemperatureReading = {
  kind: string;
  chip: string;
  device: string;
  label: string;
  celsius: number;
  max: number | null;
  crit: number | null;
};

export type ResourceCpu = {
  usage_percent: number;
  cores: number | null;
  window_s: number | null;
};

export type ResourceMemory = {
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  swap_total_bytes: number | null;
  swap_used_bytes: number | null;
};

export type ResourceDisk = {
  mount: string;
  device: string;
  fstype: string;
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
};

export type HostResources = {
  cpu: ResourceCpu | null;
  memory: ResourceMemory | null;
  disks: ResourceDisk[];
};

export type ResourceMetric = "cpu" | "memory" | "disk";

export type TemperatureHost = {
  host: string;
  status: "ok" | "unreachable" | "error";
  error: string | null;
  collected_at: string | null;
  last_good_at: string | null;
  uptime_s: number | null;
  load1: number | null;
  max_celsius: number | null;
  readings: TemperatureReading[];
  warnings?: string[];
  // Absent from collectors that predate resource collection.
  resources?: HostResources | null;
};

export type TemperatureLatest = {
  sweep_at: string | null;
  hosts: TemperatureHost[];
};

export type TemperatureSeries = {
  host: string;
  kind: string;
  points: [string, number][];
  // Present only for per-filesystem disk series.
  mount?: string;
};

export type TemperatureHistory = {
  from: string;
  to: string;
  bucket_seconds: number;
  series: TemperatureSeries[];
  metric?: string;
};
