CREATE TYPE role AS ENUM ('SUPER_ADMIN','COMPANY_OWNER','GENERAL_MANAGER','FINANCE_MANAGER','ACCOUNTANT',
  'INVENTORY_MANAGER','TRANSPORT_MANAGER','HR_MANAGER','DEPARTMENT_MANAGER','EMPLOYEE');
CREATE TYPE currency AS ENUM ('USD','CDF');

CREATE TABLE companies (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  rccm text, id_nat text, nif text,
  timezone text NOT NULL DEFAULT 'Africa/Kinshasa',
  locale text NOT NULL DEFAULT 'fr-CD',
  base_currency currency NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE users (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email text NOT NULL, name text NOT NULL, password_hash text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE memberships (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL REFERENCES users(id),
  company_id text NOT NULL REFERENCES companies(id),
  role role NOT NULL,
  active boolean NOT NULL DEFAULT true,
  approval_limit_usd bigint CHECK (approval_limit_usd >= 0),
  approval_limit_cdf bigint CHECK (approval_limit_cdf >= 0),
  UNIQUE (user_id, company_id));
CREATE INDEX memberships_company ON memberships (company_id);

CREATE TABLE invitations (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id text NOT NULL REFERENCES companies(id),
  email text NOT NULL, role role NOT NULL,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL);
CREATE INDEX invitations_company ON invitations (company_id);

CREATE TABLE exchange_rates (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id text NOT NULL REFERENCES companies(id),
  from_currency currency NOT NULL, to_currency currency NOT NULL,
  rate numeric(24,12) NOT NULL CHECK (rate > 0),
  effective_at timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_currency <> to_currency),
  UNIQUE (company_id, from_currency, to_currency, effective_at));

CREATE TABLE audit_logs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id text NOT NULL REFERENCES companies(id),
  user_id text, action text NOT NULL, entity text NOT NULL, entity_id text,
  before_state jsonb, after_state jsonb, ip text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_company_time ON audit_logs (company_id, created_at);
CREATE INDEX audit_entity ON audit_logs (company_id, entity, entity_id);

CREATE TABLE idempotency_keys (
  company_id text NOT NULL REFERENCES companies(id),
  idem_key text NOT NULL,
  result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, idem_key));

-- Audit log is immutable for everyone, including the table owner.
CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- Row-level security -------------------------------------------------------
CREATE FUNCTION current_company() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.company_id', true), '') $$;
CREATE FUNCTION current_app_user() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['invitations','exchange_rates','audit_logs','idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

-- Memberships: a user can also read their OWN rows (needed to authorize before a company is chosen).
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY m_read ON memberships FOR SELECT USING (company_id = current_company() OR user_id = current_app_user());
CREATE POLICY m_write ON memberships FOR ALL USING (company_id = current_company()) WITH CHECK (company_id = current_company());

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;  -- not FORCEd: owner-run functions below can create companies
CREATE POLICY c_own ON companies FOR SELECT USING (id = current_company());
CREATE POLICY c_upd ON companies FOR UPDATE USING (id = current_company()) WITH CHECK (id = current_company());

-- Sign-up: only way for the app role to create a company (atomic company + owner membership).
CREATE FUNCTION create_company_with_owner(p_user text, p_name text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid text;
BEGIN
  INSERT INTO companies (name) VALUES (p_name) RETURNING id INTO cid;
  PERFORM set_config('app.company_id', cid, true);
  INSERT INTO memberships (user_id, company_id, role) VALUES (p_user, cid, 'COMPANY_OWNER');
  INSERT INTO audit_logs (company_id, user_id, action, entity, entity_id)
    VALUES (cid, p_user, 'company.create', 'company', cid);
  RETURN cid;
END $$;
REVOKE ALL ON FUNCTION create_company_with_owner(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_company_with_owner(text, text) TO erp_app;

-- Least-privilege grants for the application role.
GRANT USAGE ON SCHEMA public TO erp_app;
GRANT SELECT, UPDATE ON companies TO erp_app;
GRANT SELECT, INSERT, UPDATE ON users TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, invitations TO erp_app;
GRANT SELECT, INSERT ON exchange_rates, audit_logs TO erp_app;   -- history: no UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE ON idempotency_keys TO erp_app;
