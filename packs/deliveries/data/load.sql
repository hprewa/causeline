-- Deliveries pack loader. DuckDB reads the CSV; SQLite is the file Toolbox serves. Run from this directory.
INSTALL sqlite;
LOAD sqlite;

ATTACH 'causeline.db' AS out (TYPE sqlite);

CREATE OR REPLACE TABLE out.orders AS
  SELECT * FROM read_csv_auto('raw/orders.csv');
