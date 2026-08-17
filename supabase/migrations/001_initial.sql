-- Calorie counter sync schema.
-- Private per-user tables with row-level security tied to auth.uid().
-- Deletes are tombstones (deleted_at) — rows are never physically removed, so
-- offline corrections propagate to every device instead of resurrecting.

-- ---------------------------------------------------------------------------
-- user_foods: user-created foods (catalog rows are seeded locally per device)
-- ---------------------------------------------------------------------------
create table if not exists public.user_foods (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  category text not null default 'Custom',
  calories_per_100g integer not null check (calories_per_100g >= 0),
  servings jsonb not null default '[]'::jsonb,
  source_ref text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create index if not exists user_foods_user_updated_idx on public.user_foods (user_id, updated_at);
create index if not exists user_foods_user_name_idx on public.user_foods (user_id, name);

-- ---------------------------------------------------------------------------
-- daily_entries: one row per logged serving; nutrient values are snapshots so
-- catalog changes never rewrite history
-- ---------------------------------------------------------------------------
create table if not exists public.daily_entries (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  log_date date not null,
  food_id uuid,
  food_name text not null,
  calories_per_100g integer not null check (calories_per_100g >= 0),
  serving_id text not null,
  serving_label text not null,
  serving_grams numeric not null check (serving_grams > 0),
  amount numeric not null check (amount > 0),
  grams numeric not null check (grams >= 0),
  calories integer not null check (calories >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create index if not exists daily_entries_user_updated_idx on public.daily_entries (user_id, updated_at);
create index if not exists daily_entries_user_date_idx on public.daily_entries (user_id, log_date, updated_at);

-- ---------------------------------------------------------------------------
-- health_measurements: date-keyed weight/height
-- ---------------------------------------------------------------------------
create table if not exists public.health_measurements (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  measured_at date not null,
  weight_kg numeric check (weight_kg is null or weight_kg > 0),
  height_cm numeric check (height_cm is null or height_cm > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create index if not exists health_measurements_user_updated_idx
  on public.health_measurements (user_id, updated_at);
create index if not exists health_measurements_user_date_idx
  on public.health_measurements (user_id, measured_at, updated_at);

-- ---------------------------------------------------------------------------
-- Row-level security: every user only ever reads/writes their own rows.
-- ---------------------------------------------------------------------------
alter table public.user_foods enable row level security;
alter table public.daily_entries enable row level security;
alter table public.health_measurements enable row level security;

drop policy if exists user_foods_select on public.user_foods;
drop policy if exists user_foods_insert on public.user_foods;
drop policy if exists user_foods_update on public.user_foods;
drop policy if exists user_foods_delete on public.user_foods;

create policy user_foods_select on public.user_foods
  for select using (auth.uid() = user_id);
create policy user_foods_insert on public.user_foods
  for insert with check (auth.uid() = user_id);
create policy user_foods_update on public.user_foods
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy user_foods_delete on public.user_foods
  for delete using (auth.uid() = user_id);

drop policy if exists daily_entries_select on public.daily_entries;
drop policy if exists daily_entries_insert on public.daily_entries;
drop policy if exists daily_entries_update on public.daily_entries;
drop policy if exists daily_entries_delete on public.daily_entries;

create policy daily_entries_select on public.daily_entries
  for select using (auth.uid() = user_id);
create policy daily_entries_insert on public.daily_entries
  for insert with check (auth.uid() = user_id);
create policy daily_entries_update on public.daily_entries
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy daily_entries_delete on public.daily_entries
  for delete using (auth.uid() = user_id);

drop policy if exists health_measurements_select on public.health_measurements;
drop policy if exists health_measurements_insert on public.health_measurements;
drop policy if exists health_measurements_update on public.health_measurements;
drop policy if exists health_measurements_delete on public.health_measurements;

create policy health_measurements_select on public.health_measurements
  for select using (auth.uid() = user_id);
create policy health_measurements_insert on public.health_measurements
  for insert with check (auth.uid() = user_id);
create policy health_measurements_update on public.health_measurements
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy health_measurements_delete on public.health_measurements
  for delete using (auth.uid() = user_id);
