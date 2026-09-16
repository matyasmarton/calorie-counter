/**
 * capture-food-extracts.ts
 *
 * Regenerates data/raw/dishes_*.csv — the composite-dish extract — from the
 * pinned FNDDS 2021-2023 release, for exactly the foods in selection.json
 * whose source is "fndds". Run `npm run capture:catalog` before
 * `npm run build:catalog` whenever that part of the selection changes.
 *
 * The output is deterministic (sorted by fdc_id), so a rebuild either
 * reproduces the checked-in files or shows a real difference.
 *
 * Not regenerated here: data/raw/{food,food_nutrient,food_portion}.csv. That
 * is a frozen legacy extract, and it cannot be reproduced from current USDA
 * releases — 23 of its ids (e.g. "Banana, ripe, raw", fdcId 790991) no longer
 * exist in any published release, and its 37 survey rows predate FNDDS
 * 2021-2023. Regenerating would silently drop foods, so it is left as is and
 * described honestly in PROVENANCE.json.
 *
 * Archives are cached under .cache/fdc/ (gitignored) and reused; set
 * FDC_CACHE_DIR to relocate, or pre-place the .zip there to work offline.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');
const CACHE = process.env.FDC_CACHE_DIR ?? path.join(ROOT, '.cache', 'fdc');

/** The only release the composite-dish extract is built from. Bump deliberately. */
const DISH_SOURCE = {
  id: 'fndds' as const,
  dataType: 'survey_fndds_food',
  url: 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_json_2024-10-31.zip',
  json: 'surveyDownload.json',
  key: 'SurveyFoods',
};

/** Nutrients the catalog needs: energy, plus the three macros. */
const NUTRIENT_IDS = ['1008', '1003', '1004', '1005'];

/** Portion rows above this are not a real single serving (mirrors the builder's cap). */
const MAX_PORTION_GRAMS = 2000;

interface FdcNutrient {
  id: number;
  nutrient: { id: number };
  amount?: number;
}
interface FdcPortion {
  id: number;
  amount?: number;
  modifier?: string;
  gramWeight?: number;
  portionDescription?: string;
  sequenceNumber?: number;
  measureUnit?: { id: number; name: string };
}
interface FdcFood {
  fdcId: number;
  description: string;
  publicationDate?: string;
  wweiaFoodCategory?: { wweiaFoodCategoryCode: number };
  foodNutrients: FdcNutrient[];
  foodPortions?: FdcPortion[];
}

interface SelectionEntry {
  fdcId: string;
  source: string;
  name: string;
}

function csvCell(value: string | number | undefined | null): string {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Parse a checked-in JSON artifact. A malformed source must fail the build, so
 * this never falls back to a default — it just names the file, which a bare
 * JSON.parse error would not.
 */
function readJson<T>(file: string): T {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`${path.relative(ROOT, file)} is not valid JSON: ${String(err)}`);
  }
}

function writeCsv(file: string, header: string[], rows: (string | number | undefined)[][]) {
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  fs.writeFileSync(path.join(RAW, file), `${header.join(',')}\n${body}\n`);
}

/** Download + unzip the pinned release into the cache, reusing what is there. */
function loadDishDataset(): FdcFood[] {
  fs.mkdirSync(CACHE, { recursive: true });
  const jsonPath = path.join(CACHE, DISH_SOURCE.json);
  if (!fs.existsSync(jsonPath)) {
    const zipPath = path.join(CACHE, path.basename(DISH_SOURCE.url));
    if (!fs.existsSync(zipPath)) {
      console.log(`fetching ${DISH_SOURCE.json}: ${DISH_SOURCE.url}`);
      execFileSync('curl', ['-fsSL', '-o', zipPath, DISH_SOURCE.url], { stdio: 'inherit' });
    }
    execFileSync('unzip', ['-oq', zipPath, '-d', CACHE], { stdio: 'inherit' });
  }
  const parsed = readJson<Record<string, FdcFood[]>>(jsonPath);
  const foods = parsed[DISH_SOURCE.key];
  if (!Array.isArray(foods)) throw new Error(`${DISH_SOURCE.json}: missing ${DISH_SOURCE.key}`);
  return foods;
}

/** "10/31/2024" -> "2024-10-31"; the legacy CSV uses ISO dates. */
function isoDate(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/^(\d+)\/(\d+)\/(\d+)$/, '$3-$1-$2');
}

function main() {
  const selection = readJson<SelectionEntry[]>(path.join(RAW, 'selection.json'));
  const wanted = [...selection]
    .filter((e) => e.source === DISH_SOURCE.id)
    .sort((a, b) => Number(a.fdcId) - Number(b.fdcId));
  if (wanted.length === 0) {
    console.log(`no "${DISH_SOURCE.id}" entries in selection.json — nothing to capture`);
    return;
  }

  const byId = new Map(loadDishDataset().map((f) => [String(f.fdcId), f]));

  const foodRows: (string | number)[][] = [];
  const nutrientRows: (string | number)[][] = [];
  const portionRows: (string | number)[][] = [];

  for (const entry of wanted) {
    const food = byId.get(entry.fdcId);
    if (!food) throw new Error(`${entry.name}: fdcId ${entry.fdcId} not in the ${DISH_SOURCE.id} release`);

    foodRows.push([
      food.fdcId,
      DISH_SOURCE.dataType,
      food.description,
      food.wweiaFoodCategory?.wweiaFoodCategoryCode ?? '',
      isoDate(food.publicationDate),
    ]);

    const nutrients = food.foodNutrients
      .filter((n) => NUTRIENT_IDS.includes(String(n.nutrient.id)))
      .sort((a, b) => Number(a.nutrient.id) - Number(b.nutrient.id));
    if (nutrients.length === 0) throw new Error(`${entry.name}: no catalogued nutrients`);
    for (const n of nutrients) {
      nutrientRows.push([n.id, food.fdcId, n.nutrient.id, n.amount ?? '']);
    }

    for (const p of food.foodPortions ?? []) {
      const grams = Number(p.gramWeight ?? 0);
      if (!(grams > 0) || grams > MAX_PORTION_GRAMS) continue;
      portionRows.push([
        p.id,
        food.fdcId,
        p.sequenceNumber ?? '',
        p.amount ?? '',
        p.measureUnit?.id ?? '',
        p.portionDescription ?? '',
        p.modifier ?? '',
        grams,
      ]);
    }
  }

  writeCsv('dishes_food.csv', ['fdc_id', 'data_type', 'description', 'food_category_id', 'publication_date'], foodRows);
  writeCsv(
    'dishes_food_nutrient.csv',
    ['id', 'fdc_id', 'nutrient_id', 'amount', 'data_points', 'derivation_id', 'min', 'max', 'median', 'footnote', 'min_year_acquired'],
    nutrientRows.map((r) => [...r, '', '', '', '', '', '', '']),
  );
  writeCsv(
    'dishes_food_portion.csv',
    ['id', 'fdc_id', 'seq_num', 'amount', 'measure_unit_id', 'portion_description', 'modifier', 'gram_weight', 'data_points', 'footnote', 'min_year_acquired'],
    portionRows.map((r) => [...r, '', '', '']),
  );

  console.log(
    `captured ${foodRows.length} dishes · ${nutrientRows.length} nutrient rows · ${portionRows.length} portions -> data/raw/dishes_*.csv`,
  );
}

main();
