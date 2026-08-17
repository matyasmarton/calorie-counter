/**
 * Meal parsing pipeline: Bonsai (coordinator) → Needle 2 (parser) → review.
 *
 * Flow:
 *  1. If Bonsai is ready, send the user text with a strict instruction to
 *     emit ONLY a short plan plus a `parse_meal_text` tool request.
 *  2. The tool request invokes Needle 2 with a strict JSON schema.
 *     `manualToolApproval` is on where supported — no tool executes
 *     without the user's explicit approval.
 *  3. If Bonsai is unavailable, call Needle directly.
 *  4. `parseMealDraft` validates the schema; the returned draft is shown
 *     for review BEFORE anything is written. Neither model ever supplies
 *     nutrient values or writes to the repository.
 */
import { parseMealDraft } from './mealDraft';
import type { MealDraft } from './types';
import type { NativeModelAdapter } from './adapter';

export const NEEDLE_2_SCHEMA = {
  type: 'object',
  required: ['mealDescription', 'ingredients', 'confidence'],
  properties: {
    mealDescription: { type: 'string' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        required: ['raw'],
        properties: {
          raw: { type: 'string' },
          foodQuery: { type: ['string', 'null'] },
          amount: { type: ['number', 'null'] },
          servingLabel: { type: ['string', 'null'] },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export interface ParseOptions {
  /** When true, require manual approval before the parse tool executes. */
  requireApproval?: boolean;
}

/**
 * Parse messy meal text into a validated, review-required MealDraft.
 * Uses Bonsai as coordinator when ready; otherwise calls Needle directly.
 * Throws only on hard failures (no runtime); schema problems surface as
 * `needsReview` drafts, never as silent data.
 */
export async function parseMealText(
  adapter: NativeModelAdapter,
  text: string,
  opts: ParseOptions = {},
): Promise<MealDraft> {
  if (!adapter.isReady()) {
    throw new Error(adapter.unavailableReason() ?? 'No local model runtime available');
  }
  const models = adapter.getModels();
  const bonsaiReady = models.some((m) => m.id.startsWith('bonsai') && m.status === 'ready');
  const needleReady = models.some((m) => m.id === 'needle-2' && m.status === 'ready');

  let raw: unknown;
  if (bonsaiReady) {
    // Bonsai coordinates: short plan + tool request only.
    const bonsai = await adapter.generate({
      modelId: 'bonsai-4b',
      prompt:
        `Plan this meal log request in ONE short sentence, then request the ` +
        `parse_meal_text tool with the exact user text as the argument. ` +
        `Never include nutrient values or food amounts of your own. User text: ${text}`,
      manualToolApproval: opts.requireApproval,
    });
    const tool = bonsai.toolCalls.find((t) => t.name === 'parse_meal_text');
    if (tool?.arguments && needleReady) {
      const needle = await adapter.generate({
        modelId: 'needle-2',
        prompt: `Extract the meal into strict JSON matching the schema. Input: ${JSON.stringify(tool.arguments)}`,
        jsonSchema: NEEDLE_2_SCHEMA,
        manualToolApproval: opts.requireApproval,
      });
      raw = parseNeedleJson(needle.text);
    } else {
      raw = parseNeedleJson(bonsai.text);
    }
  } else if (needleReady) {
    const needle = await adapter.generate({
      modelId: 'needle-2',
      prompt: `Extract the meal into strict JSON matching the schema. Input: ${text}`,
      jsonSchema: NEEDLE_2_SCHEMA,
      manualToolApproval: opts.requireApproval,
    });
    raw = parseNeedleJson(needle.text);
  } else {
    throw new Error('Needle 2 is not installed; manual logging remains available');
  }
  return parseMealDraft(raw);
}

function parseNeedleJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Model wrapped the JSON in prose/code fences — strip the first JSON
    // object and retry once; failure surfaces as a schema error.
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Model output was not valid JSON');
  }
}
