-- Additive resource metrics (CPU, memory, swap) for the existing five-minute
-- sweep, plus one row per local filesystem. Apply as the database administrator
-- after 001; never as the collector. Idempotent and safe to re-run.
BEGIN;
CREATE SCHEMA IF NOT EXISTS fountain;

-- Scalar resources live on the existing per-host sample row, so historical
-- samples and every existing query keep working unchanged (new columns are
-- simply NULL for rows collected before this migration).
ALTER TABLE fountain.host_temperature_samples
    ADD COLUMN IF NOT EXISTS cpu_percent real,
    ADD COLUMN IF NOT EXISTS cpu_cores int,
    ADD COLUMN IF NOT EXISTS cpu_window_s real,
    ADD COLUMN IF NOT EXISTS memory_total_bytes bigint,
    ADD COLUMN IF NOT EXISTS memory_used_bytes bigint,
    ADD COLUMN IF NOT EXISTS memory_available_bytes bigint,
    ADD COLUMN IF NOT EXISTS swap_total_bytes bigint,
    ADD COLUMN IF NOT EXISTS swap_used_bytes bigint;

-- One row per mount per sample keeps filesystem usage accurate without
-- duplicating the sample row. The cascading FK removes disks with retention.
CREATE TABLE IF NOT EXISTS fountain.host_disk_samples (
    sample_id bigint REFERENCES fountain.host_temperature_samples(id) ON DELETE CASCADE,
    host text,
    sweep_at timestamptz,
    mount text NOT NULL,
    device text,
    fstype text,
    total_bytes bigint,
    used_bytes bigint,
    available_bytes bigint
);
CREATE INDEX IF NOT EXISTS disk_samples_host_sweep ON fountain.host_disk_samples(host, sweep_at DESC);
CREATE INDEX IF NOT EXISTS disk_samples_sweep ON fountain.host_disk_samples(sweep_at);
CREATE INDEX IF NOT EXISTS disk_samples_sample ON fountain.host_disk_samples(sample_id);

-- Table-level INSERT/SELECT privileges already cover later columns on
-- host_temperature_samples, so only the new table needs grants.
REVOKE ALL ON fountain.host_disk_samples FROM PUBLIC;
GRANT INSERT, SELECT ON fountain.host_disk_samples TO fountain_temps_writer;
GRANT SELECT ON fountain.host_disk_samples TO fountain_temps_reader;
COMMIT;
