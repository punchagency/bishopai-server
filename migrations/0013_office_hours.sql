-- Office hours configuration stored as a single JSON row in integration_state.
-- Key: 'office_hours'
-- Value (JSON):
--   {
--     "timezone": "Europe/London",
--     "days": [1,2,3,4,5],        -- JS day-of-week, 0=Sun
--     "start_hour": 9,
--     "end_hour": 17,
--     "session_duration_min": 60,
--     "slot_horizon_days": 7,
--     "max_slots": 3
--   }
--
-- Seeded to a sensible default on first migration; Nicole can override via
-- PUT /appointments/office-hours from the Settings view.
INSERT INTO integration_state (key, value)
VALUES (
  'office_hours',
  '{"timezone":"Europe/London","days":[1,2,3,4,5],"start_hour":9,"end_hour":17,"session_duration_min":60,"slot_horizon_days":7,"max_slots":3}'
)
ON CONFLICT (key) DO NOTHING;
