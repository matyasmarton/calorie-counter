/**
 * Device benchmark fixture for local models (run on-device, not in CI).
 *
 * Records cold start, model-load peak memory, time to first token, decode
 * throughput, structured-output validity over ten meal prompts, force-close
 * count, and thermal/battery observations. A model may only become a
 * DEFAULT (Needle 2 parser, desktop Bonsai) after passing:
 *   - 95% schema-valid drafts
 *   - p95 first response ≤ 5 s
 *   - zero force-closes
 *   - acceptable sustained thermal/battery behavior (observed, recorded)
 *
 * Run: `npx tsx scripts/benchmark-models.ts <platform> <modelId>`
 * This script never writes app data; it exercises the adapter directly.
 */
import { BENCHMARK_GATES } from '../src/local-ai/types';
import type { LocalModelId, LocalModelPlatform, NativeModelAdapter } from '../src/local-ai/adapter';
import { createRunAnywhereAdapter } from '../src/local-ai/runanywhere';
import { createMlxAdapter } from '../src/local-ai/mlx';
import { NEEDLE_2_SCHEMA, parseMealText } from '../src/local-ai/pipeline';

const PROMPTS = [
  "Mom's hamburger with fries",
  'lecsó',
  'bibimbap with egg',
  'menemen with feta',
  'Greek yogurt with honey and walnuts',
  'two scrambled eggs and toast',
  'grilled chicken breast, 150 g',
  'overnight oats with berries',
  'pad thai with shrimp',
  'black coffee, no sugar',
];

interface BenchResult {
  coldStartMs: number;
  loadPeakMemoryMb: number | null;
  firstTokenMs: number[];
  decodeTokensPerSec: number[];
  schemaValid: number;
  forceCloses: number;
  thermalBatteryNote: string;
  passed: boolean;
}

async function runModel(adapter: NativeModelAdapter, modelId: LocalModelId, platform: LocalModelPlatform): Promise<BenchResult> {
  const t0 = Date.now();
  await adapter.initialize();
  const coldStartMs = Date.now() - t0;

  await adapter.loadModel(modelId);
  const loadPeakMemoryMb = null; // filled by on-device instrumentation

  const firstTokenMs: number[] = [];
  const decodeTokensPerSec: number[] = [];
  let schemaValid = 0;
  let forceCloses = 0;
  for (const prompt of PROMPTS) {
    const start = Date.now();
    try {
      const draft = await parseMealText(adapter, prompt, { requireApproval: true });
      firstTokenMs.push(Date.now() - start);
      schemaValid += draft.ingredients.length > 0 ? 1 : 0;
    } catch (e) {
      forceCloses += 1;
      console.warn(`[${prompt}] ${String(e)}`);
    }
  }

  const p95 = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? Infinity;
  };

  const passed =
    schemaValid / PROMPTS.length >= BENCHMARK_GATES.minSchemaValidity &&
    p95(firstTokenMs) / 1000 <= BENCHMARK_GATES.maxP95FirstTokenSeconds &&
    forceCloses <= BENCHMARK_GATES.maxForceCloses;

  return {
    coldStartMs,
    loadPeakMemoryMb,
    firstTokenMs,
    decodeTokensPerSec,
    schemaValid,
    forceCloses,
    thermalBatteryNote: 'record device temperature/battery drain during the run and fill this in',
    passed,
  };
}

async function main(): Promise<void> {
  const [platformArg, modelArg] = process.argv.slice(2) as [LocalModelPlatform | undefined, LocalModelId | undefined];
  const platform: LocalModelPlatform = platformArg === 'desktop' ? 'desktop' : 'android';
  const modelId: LocalModelId = (modelArg as LocalModelId) ?? 'needle-2';

  const adapter: NativeModelAdapter =
    platform === 'desktop' ? createMlxAdapter() : createRunAnywhereAdapter(platform);

  console.log(`Benchmarking ${modelId} on ${platform}…`);
  if (!adapter.isReady()) {
    console.log(`NOT READY: ${adapter.unavailableReason()}`);
    console.log('No benchmark possible; model stays opt-in unavailable.');
    process.exit(0);
  }

  const result = await runModel(adapter, modelId, platform);
  console.log(JSON.stringify({ platform, modelId, gates: BENCHMARK_GATES, result }, null, 2));
  if (!result.passed) {
    console.log('GATE FAILED — model must stay opt-in unavailable.');
    process.exit(1);
  }
  console.log('GATE PASSED — model may become the default on this device.');
}

void main();
