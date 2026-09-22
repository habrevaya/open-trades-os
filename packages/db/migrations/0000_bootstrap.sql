-- Runs before everything. Creates the schema that holds the tenant context
-- helpers, kept out of `public` so a customer querying their own database
-- directly is not confused by internal plumbing.
create schema if not exists app;
create extension if not exists "pgcrypto";
