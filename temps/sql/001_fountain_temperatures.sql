-- Apply as the database administrator, never as the collector.
BEGIN;
CREATE SCHEMA IF NOT EXISTS fountain;
CREATE TABLE IF NOT EXISTS fountain.host_temperature_samples (
    id bigserial PRIMARY KEY,
    sweep_at timestamptz NOT NULL,
    collected_at timestamptz,
    host text NOT NULL,
    status text NOT NULL CHECK (status IN ('ok', 'unreachable', 'error')),
    error text,
    uptime_s bigint,
    load1 real,
    readings_count int,
    warnings jsonb
);
CREATE TABLE IF NOT EXISTS fountain.host_temperature_readings (
    sample_id bigint REFERENCES fountain.host_temperature_samples(id) ON DELETE CASCADE,
    host text,
    sweep_at timestamptz,
    kind text,
    chip text,
    device text,
    label text,
    celsius real NOT NULL,
    max_c real,
    crit_c real
);
CREATE INDEX IF NOT EXISTS temperature_samples_host_sweep ON fountain.host_temperature_samples(host, sweep_at DESC);
CREATE INDEX IF NOT EXISTS temperature_samples_sweep ON fountain.host_temperature_samples(sweep_at);
CREATE INDEX IF NOT EXISTS temperature_readings_host_sweep ON fountain.host_temperature_readings(host, sweep_at DESC);
CREATE INDEX IF NOT EXISTS temperature_readings_sweep ON fountain.host_temperature_readings(sweep_at);
CREATE INDEX IF NOT EXISTS temperature_readings_sample ON fountain.host_temperature_readings(sample_id);
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fountain_temps_writer') THEN
        CREATE ROLE fountain_temps_writer LOGIN;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fountain_temps_reader') THEN
        CREATE ROLE fountain_temps_reader LOGIN;
    END IF;
END $$;
GRANT USAGE ON SCHEMA fountain TO fountain_temps_writer, fountain_temps_reader;
GRANT INSERT, SELECT ON fountain.host_temperature_samples, fountain.host_temperature_readings TO fountain_temps_writer;
-- Retention needs DELETE on samples only; the FK cascades to readings.
GRANT DELETE ON fountain.host_temperature_samples TO fountain_temps_writer;
GRANT USAGE ON SEQUENCE fountain.host_temperature_samples_id_seq TO fountain_temps_writer;
GRANT SELECT ON fountain.host_temperature_samples, fountain.host_temperature_readings TO fountain_temps_reader;
COMMIT;
