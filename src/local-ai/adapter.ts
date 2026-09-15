/**
 * Native model lifecycle adapter.
 *
 * Two implementations exist behind one interface:
 *  - `RunAnywhereAdapter`: React Native via @runanywhere/core +
 *    @runanywhere/llamacpp (GGUF). Requires RunAnywhere AI Studio or a
 *    native build — standard Expo Go reports unavailable, never crashes.
 *  - `MlxAdapter`: desktop Apple Silicon via the MLX Python runtime
 *    (stock MLX supports ternary Q2_0; no custom llama.cpp fork needed).
 *
 * The app works with NO model installed: adapters expose `isReady` and a
 * clear `unavailableReason`, and callers fall back to manual logging.
 */
import type { LocalModelId, LocalModelPlatform, LocalModelState } from './types';

export type { LocalModelId, LocalModelPlatform } from './types';
export type { LocalModelState } from './types';

export interface ModelGenerateRequest {
  modelId: LocalModelId;
  /** Prompt sent to the model (Bonsai plan or Needle parse). */
  prompt: string;
  /** When set, the model must respond as a JSON object matching this schema. */
  jsonSchema?: Record<string, unknown>;
  /** When true, tool calls require explicit manual approval before execution. */
  manualToolApproval?: boolean;
}

export interface ModelGenerateResult {
  text: string;
  /** Tool calls requested by the model (Bonsai → parse_meal_text). */
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** True when a tool call was deferred for manual approval. */
  pendingApproval: boolean;
}

export interface NativeModelAdapter {
  readonly platform: LocalModelPlatform;
  /** True when the native runtime is present and initialized. */
  isReady(): boolean;
  /** Human-readable reason when not ready (shown in Settings). */
  unavailableReason(): string | null;
  /** Model states for the settings screen (status + benchmark gate). */
  getModels(): LocalModelState[];
  initialize(): Promise<void>;
  /** Download a model (opt-in) with progress 0–1; cancel is best-effort. */
  downloadModel(id: LocalModelId, onProgress?: (fraction: number) => void): Promise<void>;
  cancelDownload(id: LocalModelId): Promise<void>;
  loadModel(id: LocalModelId): Promise<void>;
  unloadModel(id: LocalModelId): Promise<void>;
  deleteModel(id: LocalModelId): Promise<void>;
  generate(req: ModelGenerateRequest): Promise<ModelGenerateResult>;
}

/** No native runtime present — the app's default, fully functional state. */
export class UnavailableAdapter implements NativeModelAdapter {
  constructor(
    readonly platform: LocalModelPlatform,
    private readonly reason: string,
  ) {}

  isReady(): boolean {
    return false;
  }

  unavailableReason(): string | null {
    return this.reason;
  }

  getModels(): LocalModelState[] {
    return (['needle-2', 'bonsai-4b', 'bonsai-8b-1bit'] as LocalModelId[]).map((id) => ({
      id,
      platform: this.platform,
      status: 'unavailable',
      detail: this.reason,
      benchmarkPassed: false,
    }));
  }

  async initialize(): Promise<void> {}
  async downloadModel(): Promise<void> {
    throw new Error(this.reason);
  }
  async cancelDownload(): Promise<void> {}
  async loadModel(): Promise<void> {
    throw new Error(this.reason);
  }
  async unloadModel(): Promise<void> {}
  async deleteModel(): Promise<void> {}
  async generate(): Promise<ModelGenerateResult> {
    throw new Error(this.reason);
  }
}
