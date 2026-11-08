-- Apply as the database administrator; no network database access is required.
BEGIN;
CREATE SCHEMA IF NOT EXISTS fountain;
CREATE TABLE IF NOT EXISTS fountain.power_outlet_labels (
    unit smallint NOT NULL CHECK (unit IN (1, 2)),
    outlet smallint NOT NULL CHECK (outlet BETWEEN 1 AND 8),
    label text NOT NULL,
    server text NOT NULL,
    sort_order int NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text,
    PRIMARY KEY (unit, outlet)
);
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fountain_power_labels') THEN
        CREATE ROLE fountain_power_labels LOGIN;
    END IF;
END $$;
-- Passwordless LOGIN uses existing container-local socket trust only.
ALTER ROLE fountain_power_labels PASSWORD NULL;
GRANT USAGE ON SCHEMA fountain TO fountain_power_labels;
REVOKE ALL ON fountain.power_outlet_labels FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fountain_temps_reader') THEN
        REVOKE ALL ON fountain.power_outlet_labels FROM fountain_temps_reader;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fountain_temps_writer') THEN
        REVOKE ALL ON fountain.power_outlet_labels FROM fountain_temps_writer;
    END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON fountain.power_outlet_labels TO fountain_power_labels;
COMMIT;
