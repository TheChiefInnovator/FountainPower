export type TemperatureReading = {
  kind: string;
  chip: string;
  device: string;
  label: string;
  celsius: number;
  max: number | null;
  crit: number | null;
};

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
};

export type TemperatureLatest = {
  sweep_at: string | null;
  hosts: TemperatureHost[];
};

export type TemperatureSeries = {
  host: string;
  kind: string;
  points: [string, number][];
};

export type TemperatureHistory = {
  from: string;
  to: string;
  bucket_seconds: number;
  series: TemperatureSeries[];
};
