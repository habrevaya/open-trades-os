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
