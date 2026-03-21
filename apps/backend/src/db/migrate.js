const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ctgate:ctgate@localhost:5432/ctgate'
});

const migration = `
-- Machines table
CREATE TABLE IF NOT EXISTS machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  plc_type VARCHAR(50) NOT NULL CHECK (plc_type IN ('S7-300', 'S7-400', 'S7-1200', 'S7-1500', 'Rockwell')),
  host VARCHAR(255) NOT NULL,
  rack INTEGER DEFAULT 0,
  slot INTEGER DEFAULT 2,
  connector VARCHAR(50) NOT NULL CHECK (connector IN ('siemens-s7', 'siemens-opcua', 'rockwell')),
  tia_version VARCHAR(10),
  project_source_type VARCHAR(50) CHECK (project_source_type IN ('upload', 'network_path')),
  project_source_path TEXT,
  project_last_parsed TIMESTAMPTZ,
  status VARCHAR(50) DEFAULT 'disconnected',
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Parsed signals from project files or live scans
CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  source VARCHAR(50) NOT NULL CHECK (source IN ('project_file', 'live_scan', 'manual')),
  block_type VARCHAR(50),
  block_number INTEGER,
  block_name VARCHAR(255),
  name VARCHAR(255),
  address VARCHAR(255) NOT NULL,
  data_type VARCHAR(50) NOT NULL,
  comment TEXT,
  live_confirmed BOOLEAN DEFAULT false,
  live_value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(machine_id, address)
);

-- Network comments from project files
CREATE TABLE IF NOT EXISTS network_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  block_name VARCHAR(255),
  block_type VARCHAR(50),
  network_number INTEGER,
  comment TEXT,
  signals_referenced TEXT[],
  logic TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Standard data model definition
CREATE TABLE IF NOT EXISTS datamodel (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS datamodel_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  datamodel_id UUID NOT NULL REFERENCES datamodel(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  data_type VARCHAR(50) NOT NULL,
  unit VARCHAR(50),
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(datamodel_id, name)
);

-- Per-machine standard data model (overrides global when set)
CREATE TABLE IF NOT EXISTS machine_datamodels (
  machine_id UUID PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
  signals JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Signal mappings per machine
CREATE TABLE IF NOT EXISTS mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  target_signal VARCHAR(255) NOT NULL,
  mapping_type VARCHAR(50) NOT NULL CHECK (mapping_type IN ('direct', 'expression', 'lookup', 'calculated')),
  source_address VARCHAR(255),
  expression TEXT,
  lookup_table JSONB,
  confidence REAL,
  validated_by_human BOOLEAN DEFAULT false,
  reasoning TEXT,
  version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(machine_id, target_signal)
);

-- Insert default data model if none exists
INSERT INTO datamodel (version)
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM datamodel);

INSERT INTO datamodel_signals (datamodel_id, name, data_type, unit, description, sort_order)
SELECT d.id, s.name, s.data_type, s.unit, s.description, s.sort_order
FROM datamodel d,
(VALUES
  ('machine_producing', 'BOOL', NULL, 'True when actively producing', 1),
  ('machine_fault', 'BOOL', NULL, 'True when fault active', 2),
  ('machine_idle', 'BOOL', NULL, 'True when idle, no fault', 3),
  ('inlet_temperature', 'REAL', '°C', 'Inlet temperature', 4),
  ('cycle_time_ms', 'INT', 'ms', 'Last cycle time', 5),
  ('parts_produced', 'INT', 'pcs', 'Parts counter current shift', 6),
  ('oee_availability', 'REAL', '%', 'Calculated OEE availability', 7)
) AS s(name, data_type, unit, description, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM datamodel_signals);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER machines_updated_at BEFORE UPDATE ON machines
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER mappings_updated_at BEFORE UPDATE ON mappings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER datamodel_updated_at BEFORE UPDATE ON datamodel
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running CT-Gate database migration...');
    await client.query(migration);
    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
