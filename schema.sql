CREATE TABLE IF NOT EXISTS meter_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  read_time TEXT NOT NULL,
  kwh REAL NOT NULL,
  balance REAL NOT NULL,
  valve_state INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'query',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meter_readings_read_time
ON meter_readings(read_time);
