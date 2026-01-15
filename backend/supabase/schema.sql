-- Supabase schema for PDF Chat App
-- Run this once in Supabase SQL Editor.
-- If you still see "schema cache" errors afterwards, reload the PostgREST schema cache
-- in Supabase Dashboard → Settings → API → "Reload schema".
-- Note: this app expects documents.id to be TEXT (it uses a hash like "e53803d604b4709a").
-- If you previously created documents.id as an integer, either drop/recreate the table
-- or run: alter table public.documents alter column id type text using id::text;
--
-- If you previously created documents.user_id NOT NULL (common in RLS templates), you have two options:
--   1) Make it nullable: alter table public.documents alter column user_id drop not null;
--   2) Keep it NOT NULL and set SUPABASE_DEFAULT_USER_ID in backend/.env to a valid value.

create table if not exists public.documents (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

-- If the table already exists (created manually), ensure required columns exist.
alter table public.documents add column if not exists num_pages integer not null default 0;
alter table public.documents add column if not exists pages jsonb not null default '[]'::jsonb;
alter table public.documents add column if not exists chunks jsonb not null default '[]'::jsonb;
alter table public.documents add column if not exists scanned_likely boolean not null default false;
alter table public.documents add column if not exists total_extracted_chars integer not null default 0;
alter table public.documents add column if not exists non_empty_pages integer not null default 0;
alter table public.documents add column if not exists summary text;
alter table public.documents add column if not exists summary_updated_at timestamptz;

create index if not exists documents_created_at_idx on public.documents (created_at desc);
