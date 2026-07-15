-- Per-client Appointment Flow Sheet: a native Google Sheet (converted from
-- Nicole's xlsx template) that we append a block to each session. Store its id
-- so provisioning happens once per client; subsequent sessions append to it.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS flow_sheet_id text;
