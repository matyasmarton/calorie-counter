/**
 * Browser-safe bridge adapter: talks to the local LLM bridge (CORS proxy in
 * scripts/local-llm-proxy.mjs) over plain fetch — no node:child_process, no
 * API keys, nothing leaves the machine.
 *
 * Backends behind the proxy:
 *  - needle server (`POST /complete`): Cactus Needle 2, the grammar-
 *    constrained parser. Its response envelope carries `function_calls[0].
 *    arguments` plus a calibrated `confidence`, which maps 1:1 onto the
 *    app's MealDraft contract.
 *  - mlx_lm.server (`POST /v1/chat/completions`): Bonsai, the planner.
 *    Tool requests are prompt-based (the pipeline's existing instruction),
 *    so the bridge never depends on mlx server `tools` support.
 */
import type {
  LocalModelId,
  LocalModelPlatform,
  LocalModelState,
  NativeModelAdapter,
} from './adapter';

export type { LocalModelId, LocalModelPlatform, LocalModelState } from './adapter';

export const DEFAULT_LLM_BASE_URL =
  process.env.EXPO_PUBLIC_LLM_BASE_URL ?? 'http://127.0.0.1:8090';

/** Persisted on/off toggle key (AsyncStorage; localStorage on web). */
export const LOCAL_AI_ENABLED_KEY = 'local-ai.enabled';

/** The mlx model id reported ready when the Bonsai server answers. */
const BONSAI_MODEL_ID: LocalModelId =
  process.env.EXPO_PUBLIC_LLM_BONSAI_MODEL === 'bonsai-8b-1bit' ? 'bonsai-8b-1bit' : 'bonsai-4b';

/** Exact prefix of the pipeline's needle-direct prompt (src/local-ai/pipeline.ts). */
const PIPELINE_NEEDLE_PREFIX = 'Extract the meal into strict JSON matching the schema. Input: ';

const NEEDLE_OFFLINE = 'Local model server is offline. Start it with the desktop launcher or scripts/start-local-llm.sh.';
const DISABLED_REASON = 'Local AI is turned off in Settings';
const BONSAI_OPTIN_DETAIL = 'Opt-in planner: requires mlx-lm + model download (see scripts/start-local-llm.sh)';

export interface BridgeConfig {
  /** Proxy origin, e.g. http://127.0.0.1:8090. */
  baseUrl: string;
  /** OpenAI `model` label sent to chat completions. */
  modelName: string;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripToolJson(content: string): { name: string; arguments: Record<string, unknown> } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const r = obj as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : null;
  if (!name) return null;
  let args = r.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== 'object') return null;
  return { name, arguments: args as Record<string, unknown> };
}

export function createBridgeAdapter(cfg: BridgeConfig): NativeModelAdapter {
  return new BridgeAdapter(cfg);
}

export class BridgeAdapter implements NativeModelAdapter {
  readonly platform: LocalModelPlatform = 'desktop';
  private models: LocalModelState[];
  private enabled = true;
  private needleReady = false;
  private bonsaiModelName: string | null = null;

  constructor(private readonly cfg: BridgeConfig) {
    this.models = (['needle-2', 'bonsai-4b', 'bonsai-8b-1bit'] as LocalModelId[]).map((id) => ({
      id,
      platform: this.platform,
      status: 'unavailable' as const,
      detail: id === 'bonsai-4b' || id === 'bonsai-8b-1bit' ? BONSAI_OPTIN_DETAIL : null,
      benchmarkPassed: false,
    }));
  }

  isReady(): boolean {
    return this.enabled && this.needleReady;
  }

  unavailableReason(): string | null {
    if (!this.enabled) return DISABLED_REASON;
    if (!this.needleReady) return NEEDLE_OFFLINE;
    return null;
  }

  getModels(): LocalModelState[] {
    return this.models.map((m) => ({ ...m }));
  }

  /** BridgeAdapter-only: persist-free runtime switch. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.needleReady = false;
      for (const id of ['needle-2', 'bonsai-4b', 'bonsai-8b-1bit'] as LocalModelId[]) {
        this.setStatus(id, 'unavailable', DISABLED_REASON);
      }
    }
  }

  /** BridgeAdapter-only: probe both backends and refresh model states. Never throws. */
  async refresh(): Promise<void> {
    let needleOk = false;
    try {
      const res = await fetchJson(`${this.cfg.baseUrl}/health`, { method: 'GET' }, 5000);
      needleOk = res.status === 200;
    } catch {
      needleOk = false;
    }
    this.needleReady = this.enabled && needleOk;
    this.setStatus('needle-2', needleOk && this.enabled ? 'ready' : 'unavailable', needleOk ? null : NEEDLE_OFFLINE);

    let bonsaiOk = false;
    let bonsaiLoading = false;
    try {
      const res = await fetchJson(`${this.cfg.baseUrl}/health/bonsai`, { method: 'GET' }, 5000);
      if (res.status === 200) bonsaiOk = true;
      else if (res.status === 503) bonsaiLoading = true;
    } catch {
      // unreachable
    }
    if (bonsaiOk) {
      // mlx server validates the `model` field against the loaded model id.
      try {
        const res = await fetchJson(`${this.cfg.baseUrl}/v1/models`, { method: 'GET' }, 5000);
        const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
        const id = data?.data?.[0]?.id;
        if (typeof id === 'string' && id) this.bonsaiModelName = id;
      } catch {
        // keep the previously captured id
      }
    }
    for (const id of ['bonsai-4b', 'bonsai-8b-1bit'] as LocalModelId[]) {
      if (!this.enabled) {
        this.setStatus(id, 'unavailable', DISABLED_REASON);
      } else if (id === BONSAI_MODEL_ID) {
        if (bonsaiOk) this.setStatus(id, 'ready', null);
        else if (bonsaiLoading) this.setStatus(id, 'downloading', 'Model downloading/loading on first start (≈1.1 GB for 4B)');
        else this.setStatus(id, 'unavailable', BONSAI_OPTIN_DETAIL);
      } else {
        this.setStatus(id, 'unavailable', BONSAI_OPTIN_DETAIL);
      }
    }
  }

  async generate(req: {
    modelId: LocalModelId;
    prompt: string;
    jsonSchema?: Record<string, unknown>;
    manualToolApproval?: boolean;
  }): Promise<{ text: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>; pendingApproval: boolean }> {
    if (!this.isReady() && req.modelId !== BONSAI_MODEL_ID) {
      throw new Error(this.unavailableReason() ?? 'No local model runtime available');
    }
    if (req.modelId === 'needle-2') {
      return this.generateNeedle(req.prompt);
    }
    return this.generateBonsai(req.prompt, req.manualToolApproval === true);
  }

  private async generateNeedle(prompt: string) {
    // The pipeline wraps the raw user text; needle's grammar already enforces
    // the schema, so the model must receive the raw text, not the wrapper.
    let input = prompt.startsWith(PIPELINE_NEEDLE_PREFIX) ? prompt.slice(PIPELINE_NEEDLE_PREFIX.length) : prompt;
    // The planner path passes the tool arguments (a JSON blob {"text": ...}).
    try {
      const parsed = JSON.parse(input) as { text?: unknown };
      if (typeof parsed.text === 'string') input = parsed.text;
    } catch {
      // plain text — keep it
    }
    // Bonsai (a full 4B LLM) extracts reliably; needle (45M, 256-token
    // window) is the grammar-safe fallback when Bonsai is unavailable.
    if (this.bonsaiModelName) {
      const text = await this.extractWithBonsai(input);
      if (text) return { text, toolCalls: [], pendingApproval: false };
    }
    return this.extractWithNeedle(input);
  }

  private async extractWithBonsai(input: string): Promise<string | null> {
    const system =
      'You are a meal parser. Extract the meal into a JSON object with exactly these fields: ' +
      'mealDescription (string, echo the user\'s text), ingredients (array of objects, each with ' +
      'raw (string, the ingredient name without amount), foodQuery (string, a SHORT catalog search ' +
      'phrase naming only this ingredient, e.g. "pepper" — never the whole meal text, or null), ' +
      'amount (number, or null), servingLabel (string, the unit like cup/tbsp/piece/g, or null)), ' +
      'confidence (number between 0 and 1). Output only the JSON object, nothing else.';
    let res: Response;
    try {
      res = await fetchJson(
        `${this.cfg.baseUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.bonsaiModelName,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: `Input: ${input}` },
            ],
            temperature: 0.1,
            max_tokens: 512,
          }),
        },
        120_000,
      );
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
    const choices = (Array.isArray(data.choices) ? data.choices : []) as Array<{
      message?: { content?: unknown };
    }>;
    const content = String(choices[0]?.message?.content ?? '');
    let obj: unknown;
    try {
      obj = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        obj = JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return obj && typeof obj === 'object' ? JSON.stringify(obj) : null;
  }

  private async extractWithNeedle(input: string) {
    let res: Response;
    try {
      res = await fetchJson(
        `${this.cfg.baseUrl}/complete`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) },
        120_000,
      );
    } catch (err) {
      throw new Error(`Local model request failed: fetch failed (${String(err)})`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Local model request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error('Local model returned a non-JSON response');
    }
    const calls = Array.isArray(envelope.function_calls) ? envelope.function_calls : [];
    const first = calls[0] as Record<string, unknown> | undefined;
    if (!first || typeof first.arguments !== 'object' || first.arguments === null) {
      const reasoning = typeof envelope.reasoning === 'string' ? envelope.reasoning : null;
      throw new Error(`Needle 2 could not parse this meal${reasoning ? `: ${reasoning}` : ''}`);
    }
    const confidence = typeof envelope.confidence === 'number' ? envelope.confidence : null;
    const text = JSON.stringify({ ...(first.arguments as Record<string, unknown>), confidence });
    return { text, toolCalls: [], pendingApproval: false };
  }

  private async generateBonsai(prompt: string, manualApproval: boolean) {
    let res: Response;
    try {
      res = await fetchJson(
        `${this.cfg.baseUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.bonsaiModelName ?? this.cfg.modelName,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 512,
          }),
        },
        120_000,
      );
    } catch (err) {
      throw new Error(`Local model request failed: fetch failed (${String(err)})`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Local model request failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error('Local model returned a non-JSON response');
    }
    const choices = (Array.isArray(data.choices) ? data.choices : []) as Array<{
      message?: { content?: unknown };
    }>;
    const content = String(choices[0]?.message?.content ?? '');
    // The pipeline's planner prompt ends with "User text: <text>"; Bonsai
    // answers it in prose rather than a tool-request JSON, so the tool call
    // the pipeline expects is synthesized deterministically from the prompt.
    const m = prompt.match(/User text:\s*([\s\S]*)$/);
    if (m && m[1]?.trim()) {
      return {
        text: content,
        toolCalls: [{ name: 'parse_meal_text', arguments: { text: m[1].trim() } }],
        pendingApproval: manualApproval,
      };
    }
    const tool = stripToolJson(content);
    if (tool) {
      return { text: content, toolCalls: [tool], pendingApproval: manualApproval };
    }
    return { text: content, toolCalls: [], pendingApproval: false };
  }

  private setStatus(id: LocalModelId, status: LocalModelState['status'], detail: string | null): void {
    this.models = this.models.map((m) => (m.id === id ? { ...m, status, detail } : m));
  }

  async initialize(): Promise<void> {}
  async downloadModel(): Promise<void> {}
  async cancelDownload(): Promise<void> {}
  async loadModel(): Promise<void> {}
  async unloadModel(): Promise<void> {}
  async deleteModel(): Promise<void> {}
}
