-- The header pg_dump writes, as in a migration from `supabase db pull`. None of it may reach sessions.
SET statement_timeout = 0;
SET row_security = off;
SELECT pg_catalog.set_config('search_path', '', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE TABLE public.tokens (
  id uuid DEFAULT extensions.uuid_generate_v4() PRIMARY KEY,
  digest text DEFAULT encode(extensions.digest('seed', 'sha256'), 'hex')
);
