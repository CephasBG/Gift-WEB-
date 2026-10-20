-- PostgreSQL row-level security. The app runs `set_config('app.company_id', id, true)`
-- inside every request transaction (see withTenant). Extend the array for each new tenant table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Membership','Invitation','ExchangeRate','AuditLog','IdempotencyKey'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING ("companyId" = current_setting('app.company_id', true))
      WITH CHECK ("companyId" = current_setting('app.company_id', true))$p$, t);
  END LOOP;
END $$;
-- Connect the app with a NON-superuser role (superusers bypass RLS).
-- Make the audit log append-only for the app role:
-- REVOKE UPDATE, DELETE ON "AuditLog" FROM app_role;
