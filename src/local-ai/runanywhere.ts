/**
 * RunAnywhere React Native adapter.
 *
 * The documented SDK (@runanywhere/core + @runanywhere/llamacpp +
 * react-native-nitro-modules) only exists inside RunAnywhere AI Studio or a
 * native build — standard Expo Go lacks the native modules. This module
 * imports the SDK lazily so a plain web/Expo Go build never crashes: the
 * adapter reports `unavailable` with a clear reason instead.
 *
 * RunAnywhere Q2_0 (ternary Bonsai) support on Android is UNVERIFIED —
 * registration/download/load must pass an actual device test before
 * `bonsai-4b`/`bonsai-8b-1bit` are enabled; `needle-2` (standard GGUF) is
 * enabled as the default parser once its download+load succeeds.
 */
import { UnavailableAdapter, type NativeModelAdapter } from './adapter';
import type { LocalModelId, LocalModelPlatform, LocalModelState } from './types';

export const RUNANYWHERE_MODELS: Record<LocalModelId, { url: string; framework: string; sizeMb: number }> = {
  // Needle 2 GGUF (llama.cpp framework) — standard quantization.
  'needle-2': { url: 'REPLACE_WITH_VERIFIED_NEEDLE2_GGUF_URL', framework: 'llama_cpp', sizeMb: 0 },
  // Ternary Bonsai Q2_0 GGUF — REQUIRES the Prism llama.cpp fork for CPU/NEON;
  // RunAnywhere compatibility must be proven on-device before enabling.
  'bonsai-4b': { url: 'REPLACE_WITH_VERIFIED_BONSAI_4B_Q2_0_URL', framework: 'llama_cpp', sizeMb: 0 },
  // 1-bit 8B — Q1_0 is merged upstream in llama.cpp.
  'bonsai-8b-1bit': { url: 'REPLACE_WITH_VERIFIED_BONSAI_8B_Q1_0_URL', framework: 'llama_cpp', sizeMb: 0 },
};

/**
 * Create the platform adapter. Returns a lazy SDK-backed adapter inside
 * RunAnywhere AI Studio / native builds, and the unavailable adapter in
 * standard Expo Go or web. `platform` is 'android' on React Native.
 */
export function createRunAnywhereAdapter(platform: LocalModelPlatform): NativeModelAdapter {
  // Lazy require: the package is only resolvable in AI Studio/native builds.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ra = require('@runanywhere/core');
    if (ra && typeof ra.registerBackend === 'function') {
      return new RunAnywhereAdapter(platform, ra);
    }
  } catch {
    // module not present — standard Expo Go / web
  }
  return new UnavailableAdapter(
    platform,
    platform === 'android'
      ? 'Live models need RunAnywhere AI Studio or a native build (standard Expo Go has no native modules)'
      : 'Live models are not available in this build',
  );
}

class RunAnywhereAdapter implements NativeModelAdapter {
  private models: LocalModelState[];
  private ready = false;

  constructor(
    readonly platform: LocalModelPlatform,
    private readonly ra: {
      registerBackend: (b: unknown) => void;
      registerModel?: (m: unknown) => void;
      downloadModel?: (id: string, cb: (p: number) => void) => Promise<void>;
      cancelDownload?: (id: string) => Promise<void>;
      loadModel?: (id: string) => Promise<void>;
      unloadModel?: (id: string) => Promise<void>;
      deleteModel?: (id: string) => Promise<void>;
      generate?: (req: unknown) => Promise<{ text: string; toolCalls: unknown[] }>;
    },
  ) {
    const states: LocalModelState[] = (['needle-2', 'bonsai-4b', 'bonsai-8b-1bit'] as LocalModelId[]).map((id) => ({
      id,
      platform,
      status: 'unavailable',
      detail: 'Not downloaded',
      benchmarkPassed: false,
    }));
    this.models = states;
  }

  isReady(): boolean {
    return this.ready;
  }

  unavailableReason(): string | null {
    return this.ready ? null : 'Model runtime not initialized';
  }

  getModels(): LocalModelState[] {
    return this.models;
  }

  async initialize(): Promise<void> {
    // Register the llama.cpp backend, then mark the adapter ready so
    // individual models can be downloaded. Model readiness stays per-model.
    this.ra.registerBackend({ id: 'llama_cpp' });
    this.ready = true;
  }

  async downloadModel(id: LocalModelId, onProgress?: (f: number) => void): Promise<void> {
    const spec = RUNANYWHERE_MODELS[id];
    this.setStatus(id, 'downloading', 'Downloading…');
    await this.ra.downloadModel?.(id, (p) => onProgress?.(p));
    this.setStatus(id, 'ready', null);
  }

  async cancelDownload(id: LocalModelId): Promise<void> {
    await this.ra.cancelDownload?.(id);
    this.setStatus(id, 'unavailable', 'Download cancelled');
  }

  async loadModel(id: LocalModelId): Promise<void> {
    await this.ra.loadModel?.(id);
    this.setStatus(id, 'ready', null);
  }

  async unloadModel(id: LocalModelId): Promise<void> {
    await this.ra.unloadModel?.(id);
  }

  async deleteModel(id: LocalModelId): Promise<void> {
    await this.ra.deleteModel?.(id);
    this.setStatus(id, 'unavailable', 'Not downloaded');
  }

  async generate(req: {
    modelId: LocalModelId;
    prompt: string;
    jsonSchema?: Record<string, unknown>;
    manualToolApproval?: boolean;
  }): Promise<{ text: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>; pendingApproval: boolean }> {
    const out = await this.ra.generate?.({
      model: req.modelId,
      prompt: req.prompt,
      jsonSchema: req.jsonSchema,
      autoExecute: req.manualToolApproval ? false : undefined,
    });
    const text = out?.text ?? '';
    const toolCalls = (out?.toolCalls ?? []) as Array<{ name: string; arguments: Record<string, unknown> }>;
    return { text, toolCalls, pendingApproval: toolCalls.length > 0 && req.manualToolApproval === true };
  }

  private setStatus(id: LocalModelId, status: LocalModelState['status'], detail: string | null): void {
    this.models = this.models.map((m) => (m.id === id ? { ...m, status, detail } : m));
  }
}
