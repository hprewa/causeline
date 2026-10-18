-- Contact-centre pack loader. DuckDB reads and joins the CSVs; SQLite is just the file Toolbox serves.
-- Run from this directory (paths are relative to it).
--
-- The source tables are loaded as they are (calls, agents). Joining the organisation onto each call is
-- the job of the pack's data.yaml, not of the loader.

INSTALL sqlite;
LOAD sqlite;

ATTACH 'causeline.db' AS out (TYPE sqlite);

CREATE OR REPLACE TABLE out.calls AS
  SELECT * FROM read_csv_auto('raw/calls.csv');

CREATE OR REPLACE TABLE out.agents AS
  SELECT * FROM read_csv_auto('raw/agents.csv');
