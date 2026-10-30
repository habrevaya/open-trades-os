-- =========================================================================
-- BEFORE
--
-- Runs before the generated table migrations, every time, idempotently.
-- Creates the schema holding the tenant context helpers, kept out of `public`
-- so a customer querying their own database directly is not confused by
-- internal plumbing.
-- =========================================================================

create schema if not exists app;
create extension if not exists "pgcrypto";
create extension if not exists pg_trgm;

-- The role every request runs as. after.sql's policies name it, and its first
-- loop does so before the section that explains the role, so on a database
-- nobody has migrated before the policies would fail with "role
-- authenticated does not exist". Created here, ahead of everything, so a fresh
-- install migrates the same as one that has been migrated for years.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;
