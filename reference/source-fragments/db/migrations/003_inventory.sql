CREATE TABLE warehouses (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id text NOT NULL REFERENCES companies(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  location text,
  UNIQUE (company_id, name), UNIQUE (company_id, id));
CREATE TABLE products (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id text NOT NULL REFERENCES companies(id),
  code text NOT NULL CHECK (length(trim(code)) BETWEEN 1 AND 40),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 150),
  unit text NOT NULL DEFAULT 'unité',
  barcode text,
  min_stock bigint NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  UNIQUE (company_id, code), UNIQUE (company_id, id));
CREATE TYPE movement_reason AS ENUM ('PURCHASE','ADJUSTMENT_IN','TRANSFER_IN','ISSUE','DAMAGED','LOST','EXPIRED','ADJUSTMENT_OUT','TRANSFER_OUT');
CREATE TABLE stock_movements (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id text NOT NULL REFERENCES companies(id),
  product_id text NOT NULL, warehouse_id text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity <> 0),          -- signed: + enters stock, - leaves it
  reason movement_reason NOT NULL, note text, transfer_id text,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  -- composite keys make it impossible to point at another company's product or warehouse
  FOREIGN KEY (company_id, product_id) REFERENCES products (company_id, id),
  FOREIGN KEY (company_id, warehouse_id) REFERENCES warehouses (company_id, id));
CREATE INDEX sm_lookup ON stock_movements (company_id, product_id, warehouse_id);
CREATE INDEX sm_time ON stock_movements (company_id, created_at DESC);
CREATE TRIGGER sm_no_change BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION audit_immutable();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['warehouses','products','stock_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP; END $$;
GRANT SELECT, INSERT, UPDATE ON warehouses, products TO erp_app;
GRANT SELECT, INSERT ON stock_movements TO erp_app;          -- append-only history
