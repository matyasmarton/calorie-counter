/**
 * build-food-catalog.ts
 *
 * Normalizes the checked-in USDA FoodData Central extracts (data/raw/) into
 * data/foods.json — the app's default catalog. Deterministic and idempotent:
 * run `npm run build:catalog` to regenerate.
 *
 * Per food:
 *  - id:       stable UUID derived from the FDC id (md5-based, v5-style)
 *  - energy:   kcal/100g from the checked-in nutrient extract
 *  - servings: official FDC portion gram weights when available; otherwise
 *              density-based approximations clearly flagged `approx: true`
 *              (cup/tbsp/tsp synthesized from approxCupGrams, plus manual
 *              piece/handful estimates from the selection).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const RAW = path.join(__dirname, '..', 'data', 'raw');
const OUT = path.join(__dirname, '..', 'data', 'foods.json');

/* ---------- tiny CSV parser (quoted fields, embedded commas) ---------- */
function parseCsv(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = splitLine(lines[0]!);
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]!);
    if (cells.length !== headers.length) {
      throw new Error(`CSV row ${i + 1}: ${cells.length} cells, expected ${headers.length}`);
    }
    const row: Record<string, string> = {};
    headers.forEach((h, j) => (row[h] = cells[j]!));
    rows.push(row);
  }
  return rows;
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/* ---------- stable UUID from a string (v5-style, md5 namespace) ---------- */
const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace
function uuid5(input: string): string {
  const h = createHash('md5')
    .update(NAMESPACE + input, 'utf8')
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const read = (f: string) => fs.readFileSync(path.join(RAW, f), 'utf8');

interface Serving {
  id: string;
  label: string;
  grams: number;
  approx: boolean;
}

interface FoodRow {
  id: string;
  name: string;
  category: string;
  caloriesPer100g: number;
  servings: Serving[];
  source: 'catalog';
  ownerId: null;
  sourceRef: string;
  approxNote: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
}

function main() {
  const sel = JSON.parse(read('selection.json')) as Array<{
    name: string;
    source: string;
    fdcId: string | null;
    match?: string;
    category: string;
    pieceGrams?: number;
    handfulGrams?: number;
    approxCupGrams?: number;
  }>;
  const foodsCsv = parseCsv(read('food.csv'));
  const energyCsv = parseCsv(read('food_nutrient.csv'));
  const portionCsv = parseCsv(read('food_portion.csv'));
  const unitsCsv = parseCsv(read('measure_unit.csv'));
  const prov = JSON.parse(read('PROVENANCE.json')) as {
    datasets: { name: string; release: string }[];
  };

  const foodById = new Map(foodsCsv.map((r) => [r.fdc_id, r]));
  const energyByFood = new Map(energyCsv.map((r) => [r.fdc_id, Number(r.amount)]));
  const portionsByFood = new Map<string, typeof portionCsv>();
  for (const p of portionCsv) {
    const list = portionsByFood.get(p.fdc_id) ?? [];
    list.push(p);
    portionsByFood.set(p.fdc_id, list);
  }
  const unitName = new Map(unitsCsv.map((r) => [r.id, r.name]));

  const KEEP_UNITS = new Set([
    'cup', 'tablespoon', 'teaspoon', 'fl oz', 'slice', 'egg', 'piece', 'pieces',
    'pat', 'stick', 'link', 'links', 'spear', 'leaf', 'wedge', 'can', 'fillet',
    'drumstick', 'breast', 'thigh', 'chop', 'steak', 'frankfurter', 'medium',
    'large', 'small', 'each', 'patty', 'patties', 'scoop', 'order', 'wrap',
    'bun', 'roll', 'pizza', 'tortilla', 'strip', 'chunk', 'pancake', 'cookie',
    'muffin', 'bagel', 'doughnut', 'serving', 'unit', 'stalk', 'bulb', 'head',
    'nugget', 'shrimp', 'olive', 'banana', 'onion', 'sandwich', 'burrito', 'taco',
  ]);

  const build = new Date().toISOString();
  const release = prov.datasets.map((d) => d.release).join(' + ');

  const foods: FoodRow[] = [];
  const seenNames = new Set<string>();

  for (const e of sel) {
    const fdc = foodById.get(e.fdcId!);
    if (!fdc) throw new Error(`missing food.csv row for ${e.name} (${e.fdcId})`);
    const kcal = energyByFood.get(e.fdcId!);
    if (kcal === undefined || !Number.isFinite(kcal) || kcal < 0) {
      throw new Error(`missing/negative energy for ${e.name}`);
    }
    const base = fdc.description ?? e.name;

    /* --- servings --- */
    const servings: Serving[] = [];
    const usedLabels = new Set<string>();
    const pushServing = (label: string, grams: number, approx: boolean, id?: string) => {
      const key = label.toLowerCase();
      if (usedLabels.has(key)) return;
      usedLabels.add(key);
      servings.push({ id: id ?? `sv-${key}`, label, grams: Math.round(grams * 10) / 10, approx });
    };

    // always-available exact units
    pushServing('g', 1, false, 'sv-gram');
    pushServing('oz', 28.35, false, 'sv-ounce');

    // official FDC portion gram weights
    for (const p of portionsByFood.get(e.fdcId!) ?? []) {
      const amount = Number(p.amount);
      const weight = Number(p.gram_weight);
      if (!(weight > 0) || weight > 750) continue;
      const unit = unitName.get(p.measure_unit_id) ?? '';
      const gramsPerUnit = weight / (amount || 1);
      let label = (p.portion_description ?? '').trim();
      if (!label) {
        if (!KEEP_UNITS.has(unit.toLowerCase())) continue;
        label = unit.toLowerCase() === 'piece' || unit.toLowerCase() === 'each' ? 'piece' : unit.toLowerCase();
      }
      if (/quantity not specified|ns as to|nfs|guideline amount/i.test(label)) continue;
      const cleaned = cleanLabel(label, unit, amount);
      pushServing(cleaned, gramsPerUnit, false);
      if (servings.length >= 7) break;
    }

    // approximated cup/tbsp/tsp when the source has no official cup measure
    const hasOfficialCup = servings.some((s) => s.label.toLowerCase().startsWith('cup'));
    if (e.approxCupGrams && !hasOfficialCup) {
      const cup = e.approxCupGrams;
      pushServing('cup', cup, true, 'sv-cup');
      pushServing('tbsp', cup / 16, true, 'sv-tbsp');
      pushServing('tsp', cup / 48, true, 'sv-tsp');
    }

    // manual piece / handful estimates
    if (e.pieceGrams) pushServing('piece', e.pieceGrams, true, 'sv-piece');
    if (e.handfulGrams) pushServing('handful', e.handfulGrams, true, 'sv-handful');

    foods.push({
      id: uuid5(`usda-fdc:${e.fdcId}`),
      name: e.name,
      category: e.category,
      caloriesPer100g: Math.round(kcal),
      servings,
      source: 'catalog',
      ownerId: null,
      sourceRef: `USDA FDC ${e.fdcId} · ${base} · release ${release}`,
      approxNote: servings.some((s) => s.approx)
        ? 'Some serving sizes are approximations (marked per serving) and may vary.'
        : null,
      createdAt: build,
      updatedAt: build,
      deletedAt: null,
    });
    seenNames.add(e.name);
  }

  foods.sort((a, b) => a.name.localeCompare(b.name));
  const dupNames = foods.filter((f, i) => foods.findIndex((g) => g.name === f.name) !== i);
  if (dupNames.length) throw new Error(`duplicate food names: ${dupNames.map((f) => f.name).join(', ')}`);

  const out = {
    metadata: {
      sourceName: prov.datasets.map((d) => d.name).join('; '),
      releases: prov.datasets.map((d) => d.release),
      sourceUrl: prov.datasets[0]?.url ?? 'https://fdc.nal.usda.gov/download-datasets.html',
      license: prov.datasets[0]?.license ?? '',
      version: `usda-fdc-${release}`,
      generatedAt: build,
      foodCount: foods.length,
      notes: prov.notes,
    },
    foods,
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${foods.length} foods -> ${path.relative(process.cwd(), OUT)}`);
  const approxCount = foods.filter((f) => f.servings.some((s) => s.approx)).length;
  console.log(`foods with approx servings: ${approxCount}/${foods.length}`);
  const officialPortions = foods.reduce((n, f) => n + f.servings.filter((s) => !s.approx).length, 0);
  console.log(`total servings: ${foods.reduce((n, f) => n + f.servings.length, 0)} (${officialPortions} official FDC)`);
}

/** Clean a portion label like "1 cup" / "2.0 tablespoon" / "1 medium (2-3/4\" dia)" */
function cleanLabel(desc: string, unit: string, amount: number): string {
  let label = desc.trim();
  // strip leading amount ("1 ", "2.0 ") from descriptions like "1 cup"
  label = label.replace(/^\d+(\.\d+)?\s*/, '');
  if (!label) label = unit;
  // collapse whitespace, trim punctuation
  label = label.replace(/\s+/g, ' ').replace(/[",']/g, '').trim();
  if (!label) label = 'piece';
  return label.length > 28 ? label.slice(0, 28) + '…' : label;
}

main();
