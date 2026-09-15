-- Macro tracking: protein / carbohydrate / fat per 100 g on user foods and
-- per-entry gram snapshots on daily entries. All columns are nullable so
-- legacy rows without macro data remain valid and sync cleanly; the app
-- shows "Macros unavailable" for null values and never fabricates numbers.
-- Historical entries keep their write-time snapshots — catalog changes never
-- rewrite history.

-- ---------------------------------------------------------------------------
-- user_foods: protein/carbs/fat per 100 g (grams, one decimal)
-- ---------------------------------------------------------------------------
alter table public.user_foods
  add column if not exists protein_per_100g numeric check (protein_per_100g is null or protein_per_100g >= 0),
  add column if not exists carbs_per_100g numeric check (carbs_per_100g is null or carbs_per_100g >= 0),
  add column if not exists fat_per_100g numeric check (fat_per_100g is null or fat_per_100g >= 0);

-- ---------------------------------------------------------------------------
-- daily_entries: macro grams snapshotted at write time
-- ---------------------------------------------------------------------------
alter table public.daily_entries
  add column if not exists protein_grams numeric check (protein_grams is null or protein_grams >= 0),
  add column if not exists carbs_grams numeric check (carbs_grams is null or carbs_grams >= 0),
  add column if not exists fat_grams numeric check (fat_grams is null or fat_grams >= 0);

-- ---------------------------------------------------------------------------
-- saved_recipes: localized recipes/aliases the user explicitly confirmed
-- ("Mom's hamburger", lecsó, ...). Nutrient values are snapshots so later
-- catalog edits never rewrite a saved recipe.
-- ---------------------------------------------------------------------------
create table if not exists public.saved_recipes (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  ingredients jsonb not null default '[]'::jsonb,
  food_ids jsonb not null default '[]'::jsonb,
  serving_grams numeric not null check (serving_grams > 0),
  calories integer not null default 0 check (calories >= 0),
  protein_grams numeric check (protein_grams is null or protein_grams >= 0),
  carbs_grams numeric check (carbs_grams is null or carbs_grams >= 0),
  fat_grams numeric check (fat_grams is null or fat_grams >= 0),
  aliases jsonb not null default '[]'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);

create index if not exists saved_recipes_user_updated_idx
  on public.saved_recipes (user_id, updated_at);
create index if not exists saved_recipes_user_name_idx
  on public.saved_recipes (user_id, name);

alter table public.saved_recipes enable row level security;

drop policy if exists saved_recipes_select on public.saved_recipes;
drop policy if exists saved_recipes_insert on public.saved_recipes;
drop policy if exists saved_recipes_update on public.saved_recipes;
drop policy if exists saved_recipes_delete on public.saved_recipes;

create policy saved_recipes_select on public.saved_recipes
  for select using (auth.uid() = user_id);
create policy saved_recipes_insert on public.saved_recipes
  for insert with check (auth.uid() = user_id);
create policy saved_recipes_update on public.saved_recipes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy saved_recipes_delete on public.saved_recipes
  for delete using (auth.uid() = user_id);
