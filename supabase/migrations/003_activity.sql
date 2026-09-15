-- Activity, workouts and the minimal profile that powers heart-rate based
-- calorie estimates. Additive-only: nothing existing is modified, and every
-- table follows 001_initial.sql's shape (per-user rows, RLS tied to auth.uid(),
-- `deleted_at` tombstones, `(user_id, updated_at)` + date indexes).

-- ---------------------------------------------------------------------------
-- activity_days: one row per user per calendar day (steps, active kcal,
-- active minutes). Re-submitting a day updates the same row in place locally,
-- so the remote upsert by id stays idempotent.
-- ---------------------------------------------------------------------------
create table if not exists public.activity_days (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  log_date date not null,
  steps integer not null default 0 check (steps >= 0),
  active_kcal integer not null default 0 check (active_kcal >= 0),
  active_minutes integer not null default 0 check (active_minutes >= 0),
  source text not null default 'manual',
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create index if not exists activity_days_user_updated_idx
  on public.activity_days (user_id, updated_at);
create index if not exists activity_days_user_date_idx
  on public.activity_days (user_id, log_date, updated_at);

-- ---------------------------------------------------------------------------
-- workouts: manually logged sessions. `calories` is the value snapshotted at
-- write time (manual override, Keytel HR estimate, or MET estimate) and
-- `calories_source` records which path produced it.
-- ---------------------------------------------------------------------------
create table if not exists public.workouts (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  log_date date not null,
  workout_type text not null,
  duration_min numeric not null check (duration_min > 0),
  avg_hr integer check (avg_hr is null or avg_hr > 0),
  peak_hr integer check (peak_hr is null or peak_hr > 0),
  calories integer not null check (calories >= 0),
  calories_source text not null,
  notes text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create index if not exists workouts_user_updated_idx
  on public.workouts (user_id, updated_at);
create index if not exists workouts_user_date_idx
  on public.workouts (user_id, log_date, updated_at);

-- ---------------------------------------------------------------------------
-- user_profile: exactly one row per user (sex + birth year), powering the
-- HR-based estimate. The local row id is the literal string 'profile', so the
-- primary key is text rather than uuid.
-- ---------------------------------------------------------------------------
create table if not exists public.user_profile (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  sex text check (sex is null or sex in ('male', 'female')),
  birth_year integer check (birth_year is null or birth_year between 1900 and 2100),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create index if not exists user_profile_user_updated_idx
  on public.user_profile (user_id, updated_at);

-- ---------------------------------------------------------------------------
-- Row-level security: every user only ever reads/writes their own rows.
-- ---------------------------------------------------------------------------
alter table public.activity_days enable row level security;
alter table public.workouts enable row level security;
alter table public.user_profile enable row level security;

drop policy if exists activity_days_select on public.activity_days;
drop policy if exists activity_days_insert on public.activity_days;
drop policy if exists activity_days_update on public.activity_days;
drop policy if exists activity_days_delete on public.activity_days;

create policy activity_days_select on public.activity_days
  for select using (auth.uid() = user_id);
create policy activity_days_insert on public.activity_days
  for insert with check (auth.uid() = user_id);
create policy activity_days_update on public.activity_days
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy activity_days_delete on public.activity_days
  for delete using (auth.uid() = user_id);

drop policy if exists workouts_select on public.workouts;
drop policy if exists workouts_insert on public.workouts;
drop policy if exists workouts_update on public.workouts;
drop policy if exists workouts_delete on public.workouts;

create policy workouts_select on public.workouts
  for select using (auth.uid() = user_id);
create policy workouts_insert on public.workouts
  for insert with check (auth.uid() = user_id);
create policy workouts_update on public.workouts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy workouts_delete on public.workouts
  for delete using (auth.uid() = user_id);

drop policy if exists user_profile_select on public.user_profile;
drop policy if exists user_profile_insert on public.user_profile;
drop policy if exists user_profile_update on public.user_profile;
drop policy if exists user_profile_delete on public.user_profile;

create policy user_profile_select on public.user_profile
  for select using (auth.uid() = user_id);
create policy user_profile_insert on public.user_profile
  for insert with check (auth.uid() = user_id);
create policy user_profile_update on public.user_profile
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy user_profile_delete on public.user_profile
  for delete using (auth.uid() = user_id);
