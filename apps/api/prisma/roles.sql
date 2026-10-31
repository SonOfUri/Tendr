-- Runtime role for the api and worker. Run as the database owner (scripts/apply-db-roles.ts);
-- idempotent. It is one DO block because Prisma sends a single statement per call. The role can
-- read and write rows but cannot change the schema (no CREATE on public, owns nothing).
DO $$
DECLARE
  owner_role text := current_user;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tendr_app') THEN
    CREATE ROLE tendr_app LOGIN;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO tendr_app', current_database());
  GRANT USAGE ON SCHEMA public TO tendr_app;
  REVOKE CREATE ON SCHEMA public FROM tendr_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tendr_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tendr_app;

  -- Tables and sequences created by later migrations (run by the owner) get the same grants.
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tendr_app',
    owner_role);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tendr_app',
    owner_role);

  -- events is append-only: a trigger rejects UPDATE/DELETE/TRUNCATE, and the role lacks them too.
  IF to_regclass('public.events') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON public.events FROM tendr_app;
  END IF;
  -- Prisma's own bookkeeping: only the owner runs migrations.
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON public._prisma_migrations FROM tendr_app;
  END IF;
END
$$
