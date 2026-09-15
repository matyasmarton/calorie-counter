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
const BRIDGE_DOWN = 'Local model bridge is not running. Start it with: scripts/start-local-llm.sh';
const DOWNLOADED_INACTIVE = 'Downloaded — press Use to activate';

/** Every model id the app knows about, in display order. */
const ALL_MODEL_IDS: LocalModelId[] = ['needle-2', 'bonsai-4b', 'bonsai-8b-1bit'];

/** One row of the bridge's on-disk inventory (GET /models). */
export interface LocalModelInfo {
  id: LocalModelId;
  downloaded: boolean;
  sizeBytes: number | null;
  /** Where the artifact lives: bridge-cache | hf-cache | omlx-library. */
  source: string | null;
  /** True when this id is the one the bridge currently serves. */
  active: boolean;
  /**
   * The id string the backend reports for this model, which is what chat
   * requests must send back. A multi-model server (oMLX) serves several ids,
   * so picking "the first one" would silently route to the wrong model.
   */
  servedAs: string | null;
}

export interface BridgeConfig {
  /** Proxy origin, e.g. http://127.0.0.1:8090. */
  baseUrl: string;
  /** OpenAI `model` label sent to chat completions. */
  modelName: string;
  /** How often to poll the bridge while a download runs. Tests shrink this. */
  pollIntervalMs?: number;
}

/** Read a bridge error body, keeping the proxy's own words rather than a status code. */
async function bridgeError(res: Response, prefix: string): Promise<Error> {
  let detail = '';
  try {
    const parsed = (await res.json()) as { error?: string; logTail?: string[] };
    detail = [parsed.error, ...(parsed.logTail ?? [])].filter(Boolean).join(' — ');
  } catch {
    detail = await res.text().catch(() => '');
  }
  return new Error(`${prefix} (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
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
  /** True when the proxy answered the last health probe. */
  private proxyUp = false;
  /** True when the Bonsai backend answered the last health probe. */
  private bonsaiReady = false;
  /** Last on-disk inventory reported by the bridge. */
  private inventory: LocalModelInfo[] = [];

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

  /** BridgeAdapter-only: probe each layer separately and refresh model states. Never throws. */
  async refresh(): Promise<void> {
    // Layer 1 — the proxy itself. Any HTTP answer proves it is alive, even a
    // 503; only a transport failure means the bridge is down. Without this
    // split, a dead proxy and a dead needle server looked identical, which is
    // exactly why Refresh appeared to do nothing.
    let needleOk = false;
    try {
      const res = await fetchJson(`${this.cfg.baseUrl}/health`, { method: 'GET' }, 5000);
      this.proxyUp = true;
      needleOk = res.status === 200;
    } catch {
      this.proxyUp = false;
      needleOk = false;
    }

    if (!this.proxyUp) {
      this.needleReady = false;
      this.bonsaiReady = false;
      this.inventory = [];
      for (const id of ALL_MODEL_IDS) {
        this.setStatus(id, 'unavailable', this.enabled ? BRIDGE_DOWN : DISABLED_REASON);
      }
      return;
    }

    this.needleReady = this.enabled && needleOk;
    if (!this.enabled) {
      this.setStatus('needle-2', 'unavailable', DISABLED_REASON);
    } else if (needleOk) {
      this.setStatus('needle-2', 'ready', null);
    } else {
      this.setStatus('needle-2', 'unavailable', NEEDLE_OFFLINE);
    }

    // Layer 2 — the Bonsai backend behind the proxy. A 503 means either "still
    // loading the weights" or "no server at all"; only the first is progress,
    // otherwise the row claims to be downloading forever.
    let bonsaiOk = false;
    let bonsaiStarting = false;
    try {
      const res = await fetchJson(`${this.cfg.baseUrl}/health/bonsai`, { method: 'GET' }, 5000);
      if (res.status === 200) {
        bonsaiOk = true;
      } else {
        const data = (await res.json().catch(() => ({}))) as { listening?: boolean };
        bonsaiStarting = data.listening === true;
      }
    } catch {
      // proxy answered /health but not /health/bonsai — treat as down
    }
    this.bonsaiReady = bonsaiOk;

    // Layer 3 — what is actually on disk, so a downloaded-but-idle model can
    // offer Use instead of repeating the download hint forever.
    let inventory: LocalModelInfo[] = [];
    try {
      const res = await fetchJson(`${this.cfg.baseUrl}/models`, { method: 'GET' }, 8000);
      if (res.ok) {
        const data = (await res.json()) as { models?: unknown };
        inventory = Array.isArray(data?.models) ? (data.models as LocalModelInfo[]) : [];
      }
    } catch {
      // older or busy bridge: fall back to health-only reporting
    }
    this.inventory = inventory;
    const live = inventory.find((m) => m.active && m.id !== 'needle-2');
    if (live?.servedAs) this.bonsaiModelName = live.servedAs;

    for (const id of ['bonsai-4b', 'bonsai-8b-1bit'] as LocalModelId[]) {
      const info = inventory.find((m) => m.id === id);
      if (!this.enabled) {
        this.setStatus(id, 'unavailable', DISABLED_REASON);
      } else if (bonsaiOk && id === BONSAI_MODEL_ID) {
        this.setStatus(id, 'ready', null);
      } else if (bonsaiStarting && id === BONSAI_MODEL_ID) {
        this.setStatus(id, 'downloading', 'Model downloading/loading on first start (≈1.1 GB for 4B)');
      } else if (info?.downloaded) {
        this.setStatus(id, 'unavailable', DOWNLOADED_INACTIVE);
      } else {
        this.setStatus(id, 'unavailable', BONSAI_OPTIN_DETAIL);
      }
    }
  }

  /** BridgeAdapter-only: the last inventory reported by the bridge. */
  getInventory(): LocalModelInfo[] {
    return this.inventory.map((m) => ({ ...m }));
  }

  /** BridgeAdapter-only: true when the proxy answered the last refresh. */
  isBridgeUp(): boolean {
    return this.proxyUp;
  }

  /**
   * BridgeAdapter-only: download a model through the bridge and follow its
   * progress. The proxy owns the command and the destination; this only
   * starts it and polls, surfacing the proxy's log tail verbatim on failure.
   */
  async downloadModel(id: LocalModelId, onProgress?: (fraction: number) => void): Promise<void> {
    const started = await fetchJson(
      `${this.cfg.baseUrl}/models/download`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) },
      10_000,
    );
    if (!started.ok) {
      throw await bridgeError(started, 'Download failed to start');
    }
    this.setStatus(id, 'downloading', 'Downloading…');
    onProgress?.(0);

    const interval = this.cfg.pollIntervalMs ?? 2000;
    const deadline = Date.now() + 60 * 60 * 1000;
    for (;;) {
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
      let status: {
        running?: boolean;
        error?: string | null;
        progress?: number;
        logTail?: string[];
      };
      try {
        const res = await fetchJson(`${this.cfg.baseUrl}/models/download/status`, { method: 'GET' }, 10_000);
        status = (await res.json()) as typeof status;
      } catch (err) {
        throw new Error(`Lost contact with the bridge during the download (${String(err)})`);
      }
      onProgress?.(typeof status.progress === 'number' ? status.progress : 0);
      if (status.running) {
        if (Date.now() > deadline) throw new Error('Download did not finish within an hour');
        continue;
      }
      if (status.error) {
        const tail = (status.logTail ?? []).slice(-3).join(' · ');
        throw new Error(`Download failed: ${status.error}${tail ? ` — ${tail}` : ''}`);
      }
      await this.refresh();
      return;
    }
  }

  /** BridgeAdapter-only: point the Bonsai backend at a folder on this Mac. */
  async useModelPath(path: string): Promise<void> {
    await this.postUse({ path });
  }

  private async postUse(body: { id?: LocalModelId; path?: string }): Promise<void> {
    const res = await fetchJson(
      `${this.cfg.baseUrl}/models/use`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      200_000,
    );
    if (!res.ok) {
      throw await bridgeError(res, 'Switching models failed');
    }
    await this.refresh();
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
    // Gate on the live probe, not just a remembered id: a Bonsai that died
    // after the last refresh would otherwise stall this call for the full
    // 120 s request timeout before falling back.
    if (this.bonsaiReady && this.bonsaiModelName) {
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

  /** Not supported by the bridge: a download runs to completion once started. */
  async cancelDownload(): Promise<void> {}

  /** Switch the Bonsai backend to a model id (the proxy restarts the server). */
  async loadModel(id: LocalModelId): Promise<void> {
    await this.postUse({ id });
  }

  async unloadModel(): Promise<void> {}

  /** Not supported by the bridge: the proxy owns the on-disk artifacts. */
  async deleteModel(): Promise<void> {}
}
