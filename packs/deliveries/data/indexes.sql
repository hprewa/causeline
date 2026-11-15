CREATE INDEX IF NOT EXISTS ix_orders_shipped_at ON orders(shipped_at);
ANALYZE;
