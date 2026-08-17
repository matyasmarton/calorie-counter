/**
 * Bridge adapter tests: the app side of the local LLM bridge, exercised
 * against an in-test HTTP stub implementing the proxy contract
 * (/health, /health/bonsai, /complete, /v1/chat/completions).
 */
import {
  createBridgeAdapter,
  DEFAULT_LLM_BASE_URL,
  LOCAL_AI_ENABLED_KEY,
  type BridgeAdapter,
} from '@/local-ai/bridge';
import { parseMealText } from '@/local-ai/pipeline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface StubRoutes {
  health?: number;          // status for GET /health
  bonsaiHealth?: number;    // status for GET /health/bonsai
  completeStatus?: number;  // status for POST /complete
  completeBody?: unknown;   // body for POST /complete
  chatStatus?: number;      // status for POST /v1/chat/completions
  chatBody?: unknown;       // body for POST /v1/chat/completions
}

let server: http.Server;
let baseUrl: string;
let routes: StubRoutes = {};
const received: { path: string; body: unknown }[] = [];

function stub(r: StubRoutes) {
  routes = r;
}

beforeEach(async () => {
  received.length = 0;
  routes = {};
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      received.push({ path: req.url ?? '/', body });
      res.setHeader('Content-Type', 'application/json');
      const url = req.url ?? '/';
      if (url === '/health') {
        res.writeHead(routes.health ?? 200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (url === '/health/bonsai') {
        res.writeHead(routes.bonsaiHealth ?? 200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (url === '/v1/models') {
        res.writeHead(200);
        res.end(JSON.stringify({ data: [{ id: 'prism-ml/Ternary-Bonsai-4B-mlx-2bit' }] }));
        return;
      }
      if (url === '/complete') {
        res.writeHead(routes.completeStatus ?? 200);
        const body = routes.completeBody ?? { type: 'call', function_calls: [], confidence: 1 };
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
        return;
      }
      if (url === '/v1/chat/completions') {
        res.writeHead(routes.chatStatus ?? 200);
        res.end(JSON.stringify(routes.chatBody ?? { choices: [{ message: { content: '' } }] }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

function adapter(): BridgeAdapter {
  return createBridgeAdapter({ baseUrl, modelName: 'cactus-needle-2' }) as BridgeAdapter;
}

const VALID_ENVELOPE = {
  type: 'call',
  success: true,
  function_calls: [
    {
      name: 'parse_meal',
      arguments: {
        mealDescription: 'chicken burrito with rice',
        ingredients: [
          { raw: 'chicken breast', foodQuery: 'chicken breast', amount: 1, servingLabel: 'piece' },
          { raw: 'white rice', foodQuery: 'rice', amount: 1, servingLabel: 'cup' },
        ],
      },
    },
  ],
  reasoning: "'chicken breast' -> chicken breast; 'rice' -> rice",
  confidence: 0.94,
};

describe('bridge adapter — health → model states', () => {
  it('reports needle-2 ready when /health answers 200', async () => {
    const a = adapter();
    await a.refresh();
    const models = a.getModels();
    expect(a.isReady()).toBe(true);
    expect(models.find((m) => m.id === 'needle-2')?.status).toBe('ready');
  });

  it('reports needle-2 unavailable with a reason when /health is down', async () => {
    stub({ health: 503 });
    const a = adapter();
    await a.refresh();
    expect(a.isReady()).toBe(false);
    const needle = a.getModels().find((m) => m.id === 'needle-2');
    expect(needle?.status).toBe('unavailable');
    expect(needle?.detail).toMatch(/offline/);
    expect(a.unavailableReason()).toMatch(/offline/);
  });

  it('reports the configured bonsai model ready when /health/bonsai answers 200', async () => {
    const a = adapter();
    await a.refresh();
    const bonsai = a.getModels().find((m) => m.id === 'bonsai-4b');
    expect(bonsai?.status).toBe('ready');
    // the unconfigured sibling stays opt-in unavailable
    expect(a.getModels().find((m) => m.id === 'bonsai-8b-1bit')?.status).toBe('unavailable');
  });

  it('marks bonsai downloading while the server is still loading the model', async () => {
    stub({ bonsaiHealth: 503 });
    const a = adapter();
    await a.refresh();
    expect(a.getModels().find((m) => m.id === 'bonsai-4b')?.status).toBe('downloading');
  });

  it('keeps needle usable when bonsai is down (bonsai is an upgrade, not a dependency)', async () => {
    stub({ bonsaiHealth: 503 });
    const a = adapter();
    await a.refresh();
    expect(a.isReady()).toBe(true);
  });

  it('setEnabled(false) disables everything; re-enable + refresh restores readiness', async () => {
    const a = adapter();
    await a.refresh();
    expect(a.isReady()).toBe(true);
    a.setEnabled(false);
    expect(a.isReady()).toBe(false);
    expect(a.unavailableReason()).toContain('turned off');
    expect(a.getModels().find((m) => m.id === 'needle-2')?.detail).toContain('turned off');
    a.setEnabled(true);
    expect(a.isReady()).toBe(false); // state returns only after refresh
    await a.refresh();
    expect(a.isReady()).toBe(true);
  });
});

describe('bridge adapter — needle generation', () => {
  it('unwraps the pipeline prompt and posts the raw user text (needle path)', async () => {
    stub({ bonsaiHealth: 503, completeBody: VALID_ENVELOPE });
    const a = adapter();
    await a.refresh();
    const result = await a.generate({
      modelId: 'needle-2',
      prompt: 'Extract the meal into strict JSON matching the schema. Input: chicken burrito with rice',
      jsonSchema: { type: 'object' },
    });
    expect(received.find((r) => r.path === '/complete')?.body).toEqual({
      input: 'chicken burrito with rice',
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.mealDescription).toBe('chicken burrito with rice');
    expect(parsed.ingredients).toHaveLength(2);
    expect(parsed.confidence).toBe(0.94);
    expect(result.toolCalls).toEqual([]);
    expect(result.pendingApproval).toBe(false);
  });

  it('sends the prompt verbatim when it does not carry the pipeline prefix', async () => {
    stub({ bonsaiHealth: 503, completeBody: VALID_ENVELOPE });
    const a = adapter();
    await a.refresh();
    await a.generate({ modelId: 'needle-2', prompt: 'custom prompt text' });
    expect(received.find((r) => r.path === '/complete')?.body).toEqual({ input: 'custom prompt text' });
  });

  it('throws when the model returns no tool call (off-topic / refusal)', async () => {
    stub({ bonsaiHealth: 503, completeBody: { type: 'call', success: true, function_calls: [], reasoning: 'no tool serves this', confidence: 0.9 } });
    const a = adapter();
    await a.refresh();
    await expect(a.generate({ modelId: 'needle-2', prompt: 'Extract the meal into strict JSON matching the schema. Input: hello' })).rejects.toThrow(/could not parse/);
  });

  it('throws with the HTTP status on a 500 from the server', async () => {
    stub({ bonsaiHealth: 503, completeStatus: 500, completeBody: { error: 'boom' } });
    const a = adapter();
    await a.refresh();
    await expect(a.generate({ modelId: 'needle-2', prompt: 'x' })).rejects.toThrow(/HTTP 500/);
  });

  it('throws a clear error on non-JSON responses', async () => {
    stub({ bonsaiHealth: 503, completeStatus: 200, completeBody: 'not json' });
    const a = adapter();
    await a.refresh();
    await expect(a.generate({ modelId: 'needle-2', prompt: 'x' })).rejects.toThrow(/non-JSON/);
  });

  it('throws when the bridge is offline before any request', async () => {
    stub({ health: 503 });
    const a = adapter();
    await a.refresh();
    await expect(a.generate({ modelId: 'needle-2', prompt: 'x' })).rejects.toThrow(/offline/);
  });
});

describe('bridge adapter — bonsai planning generation', () => {
  it('synthesizes the parse_meal_text tool call from the pipeline planner prompt', async () => {
    stub({
      chatBody: {
        choices: [{ message: { content: 'Parse the meal text: "lecsó with peppers" using the parse_meal_text tool.' } }],
      },
    });
    const a = adapter();
    const result = await a.generate({
      modelId: 'bonsai-4b',
      prompt:
        'Plan this meal log request in ONE short sentence, then request the parse_meal_text tool with the exact user text as the argument. Never include nutrient values or food amounts of your own. User text: lecsó with peppers',
      manualToolApproval: true,
    });
    expect(result.toolCalls).toEqual([{ name: 'parse_meal_text', arguments: { text: 'lecsó with peppers' } }]);
    expect(result.pendingApproval).toBe(true);
  });

  it('parses a fenced tool-request JSON from the model text when no User text marker exists', async () => {
    stub({
      chatBody: {
        choices: [
          {
            message: {
              content: '```json\n{"type":"call","name":"parse_meal_text","arguments":{"text":"chicken burrito"}}\n```',
            },
          },
        ],
      },
    });
    const a = adapter();
    const result = await a.generate({
      modelId: 'bonsai-4b',
      prompt: 'Plan this meal log request…',
      manualToolApproval: true,
    });
    expect(result.toolCalls).toEqual([{ name: 'parse_meal_text', arguments: { text: 'chicken burrito' } }]);
    expect(result.pendingApproval).toBe(true);
  });

  it('accepts string-encoded arguments', async () => {
    stub({
      chatBody: {
        choices: [{ message: { content: '{"type":"call","name":"parse_meal_text","arguments":"{\\"text\\":\\"x\\"}"}' } }],
      },
    });
    const a = adapter();
    const result = await a.generate({ modelId: 'bonsai-4b', prompt: 'p' });
    expect(result.toolCalls[0]!.arguments).toEqual({ text: 'x' });
  });

  it('returns no tool calls when the model text is not a tool request', async () => {
    stub({ chatBody: { choices: [{ message: { content: 'I would plan a meal parse.' } }] } });
    const a = adapter();
    const result = await a.generate({ modelId: 'bonsai-4b', prompt: 'p' });
    expect(result.toolCalls).toEqual([]);
    expect(result.pendingApproval).toBe(false);
    expect(result.text).toBe('I would plan a meal parse.');
  });

  it('throws with the HTTP status when the bonsai endpoint fails', async () => {
    stub({ chatStatus: 500, chatBody: { error: 'boom' } });
    const a = adapter();
    await expect(a.generate({ modelId: 'bonsai-4b', prompt: 'p' })).rejects.toThrow(/HTTP 500/);
  });
});

describe('bridge adapter — needle generation (Bonsai-backed extraction)', () => {
  const EXTRACTION = {
    mealDescription: 'lecsó with peppers, onion, tomato',
    ingredients: [
      { raw: 'pepper', foodQuery: 'pepper', amount: 2 },
      { raw: 'onion', foodQuery: 'onion', amount: 1 },
    ],
    confidence: 0.95,
  };

  it('routes extraction to Bonsai with the prose field-spec prompt when Bonsai is ready', async () => {
    stub({
      bonsaiHealth: 200,
      chatBody: { choices: [{ message: { content: JSON.stringify(EXTRACTION) } }] },
    });
    const a = adapter();
    await a.refresh();
    const result = await a.generate({
      modelId: 'needle-2',
      prompt: 'Extract the meal into strict JSON matching the schema. Input: lecsó with peppers, onion, tomato',
      jsonSchema: { type: 'object' },
    });
    const chat = received.find((r) => r.path === '/v1/chat/completions')?.body as {
      model?: string;
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(chat.model).toBe('prism-ml/Ternary-Bonsai-4B-mlx-2bit');
    expect(chat.messages?.[0]?.role).toBe('system');
    expect(chat.messages?.[0]?.content).toContain('mealDescription');
    expect(chat.messages?.[1]?.content).toBe('Input: lecsó with peppers, onion, tomato');
    const parsed = JSON.parse(result.text);
    expect(parsed.ingredients).toHaveLength(2);
    expect(parsed.confidence).toBe(0.95);
    expect(received.find((r) => r.path === '/complete')).toBeUndefined();
  });

  it('unwraps the planner JSON blob to the raw text before extraction', async () => {
    stub({
      bonsaiHealth: 200,
      chatBody: { choices: [{ message: { content: JSON.stringify(EXTRACTION) } }] },
    });
    const a = adapter();
    await a.refresh();
    await a.generate({
      modelId: 'needle-2',
      prompt: 'Extract the meal into strict JSON matching the schema. Input: {"text":"chicken burrito"}',
    });
    const chat = received.find((r) => r.path === '/v1/chat/completions')?.body as {
      messages?: Array<{ content?: string }>;
    };
    expect(chat.messages?.[1]?.content).toBe('Input: chicken burrito');
  });

  it('falls back to the needle server when Bonsai returns no parseable JSON', async () => {
    stub({ bonsaiHealth: 200, chatBody: { choices: [{ message: { content: 'I cannot do that.' } }] }, completeBody: VALID_ENVELOPE });
    const a = adapter();
    await a.refresh();
    const result = await a.generate({
      modelId: 'needle-2',
      prompt: 'Extract the meal into strict JSON matching the schema. Input: chicken burrito with rice',
    });
    const parsed = JSON.parse(result.text);
    expect(parsed.confidence).toBe(0.94); // envelope confidence from the needle path
    expect(received.find((r) => r.path === '/complete')?.body).toEqual({ input: 'chicken burrito with rice' });
  });
});

describe('bridge adapter — pipeline integration', () => {
  it('parseMealText resolves a MealDraft through the stub bridge (needle-direct)', async () => {
    stub({ bonsaiHealth: 503, completeBody: VALID_ENVELOPE });
    const a = adapter();
    await a.refresh();
    const draft = await parseMealText(a, 'chicken burrito with rice');
    expect(draft.mealDescription).toBe('chicken burrito with rice');
    expect(draft.ingredients).toHaveLength(2);
    expect(draft.ingredients[0]).toMatchObject({ raw: 'chicken breast', foodQuery: 'chicken breast' });
    expect(draft.confidence).toBe(0.94);
    expect(draft.needsReview).toBe(false);
  });

  it('parseMealText marks the draft for review when confidence is below 0.8', async () => {
    stub({ bonsaiHealth: 503, completeBody: { ...VALID_ENVELOPE, confidence: 0.6 } });
    const a = adapter();
    await a.refresh();
    const draft = await parseMealText(a, 'chicken burrito with rice');
    expect(draft.needsReview).toBe(true);
  });

  it('parseMealText rejects the draft when the envelope lacks a tool call', async () => {
    stub({ bonsaiHealth: 503, completeBody: { type: 'call', function_calls: [], confidence: 0.9 } });
    const a = adapter();
    await a.refresh();
    await expect(parseMealText(a, 'lecsó')).rejects.toThrow(/could not parse/);
  });

  it('parseMealText runs the full Bonsai-plan → Needle-execute loop when Bonsai is ready', async () => {
    stub({
      bonsaiHealth: 200,
      chatBody: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                mealDescription: 'chicken burrito with rice',
                ingredients: [
                  { raw: 'chicken', foodQuery: 'chicken', amount: 1, servingLabel: 'piece' },
                  { raw: 'rice', foodQuery: 'rice', amount: 1, servingLabel: 'cup' },
                ],
                confidence: 0.95,
              }),
            },
          },
        ],
      },
    });
    const a = adapter();
    await a.refresh();
    const draft = await parseMealText(a, 'chicken burrito with rice');
    expect(draft.mealDescription).toBe('chicken burrito with rice');
    expect(draft.ingredients).toHaveLength(2);
    expect(draft.confidence).toBe(0.95);
    // the Bonsai extraction received the raw user text (planner blob unwrapped)
    const chat = received.filter((r) => r.path === '/v1/chat/completions').at(-1)?.body as {
      messages?: Array<{ content?: string }>;
    };
    expect(chat.messages?.[1]?.content).toBe('Input: chicken burrito with rice');
    // no needle server round trip happened (Bonsai did the extraction)
    expect(received.find((r) => r.path === '/complete')).toBeUndefined();
  });
});

describe('bridge adapter — constants', () => {
  it('exports the expected default base URL and persistence key', () => {
    expect(DEFAULT_LLM_BASE_URL).toBe('http://127.0.0.1:8090');
    expect(LOCAL_AI_ENABLED_KEY).toBe('local-ai.enabled');
  });
});
