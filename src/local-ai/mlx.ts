/**
 * Desktop MLX adapter (Apple Silicon).
 *
 * Stock MLX runs ternary Q2_0 on Apple Silicon, so the desktop Bonsai path
 * needs no custom llama.cpp fork. The adapter shells out to the MLX Python
 * runtime (mlx-lm) when present; otherwise it reports unavailable and the
 * app falls back to manual logging. One-bit Q1_0 requires Prism's MLX fork
 * until upstream lands, so `bonsai-8b-1bit` stays opt-in and benchmarked.
 */
import { UnavailableAdapter, type NativeModelAdapter } from './adapter';
import type { LocalModelId, LocalModelPlatform, LocalModelState } from './types';

export const MLX_MODELS: Record<LocalModelId, { repo: string; quant: string }> = {
  'needle-2': { repo: 'REPLACE_WITH_VERIFIED_NEEDLE2_MLX_REPO', quant: '' },
  'bonsai-4b': { repo: 'prism-ml/Ternary-Bonsai-4B-mlx-2bit', quant: '2bit' },
  'bonsai-8b-1bit': { repo: 'prism-ml/Ternary-Bonsai-8B-mlx-1bit', quant: '1bit' },
};

/** Returns the desktop adapter: MLX-backed when the runtime exists, else unavailable. */
export function createMlxAdapter(): NativeModelAdapter {
  return new MlxAdapter('desktop');
}

class MlxAdapter implements NativeModelAdapter {
  private models: LocalModelState[];
  private ready = false;

  constructor(readonly platform: LocalModelPlatform) {
    this.models = (['needle-2', 'bonsai-4b', 'bonsai-8b-1bit'] as LocalModelId[]).map((id) => ({
      id,
      platform,
      status: 'unavailable',
      detail: 'Not downloaded',
      benchmarkPassed: false,
    }));
  }

  isReady(): boolean {
    return this.ready;
  }

  unavailableReason(): string | null {
    return this.ready ? null : 'MLX runtime not available';
  }

  getModels(): LocalModelState[] {
    return this.models;
  }

  async initialize(): Promise<void> {
    // Probe for the mlx-lm CLI once. Missing → stays unavailable (manual logging).
    try {
      const { execFile } = await import('node:child_process');
      const ok = await new Promise<boolean>((resolve) => {
        execFile('python3', ['-c', 'import mlx_lm'], { timeout: 10_000 }, (err) => resolve(!err));
      });
      this.ready = ok;
    } catch {
      this.ready = false;
    }
  }

  async downloadModel(id: LocalModelId, onProgress?: (f: number) => void): Promise<void> {
    this.setStatus(id, 'downloading', 'Downloading…');
    onProgress?.(0);
    // mlx-lm pulls from Hugging Face on first use; progress is coarse.
    onProgress?.(1);
    this.setStatus(id, 'ready', null);
  }

  async cancelDownload(): Promise<void> {}
  async loadModel(): Promise<void> {}
  async unloadModel(): Promise<void> {}

  async deleteModel(id: LocalModelId): Promise<void> {
    this.setStatus(id, 'unavailable', 'Not downloaded');
  }

  async generate(req: {
    modelId: LocalModelId;
    prompt: string;
    jsonSchema?: Record<string, unknown>;
    manualToolApproval?: boolean;
  }): Promise<{ text: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>; pendingApproval: boolean }> {
    const spec = MLX_MODELS[req.modelId];
    const { execFile } = await import('node:child_process');
    const prompt = req.jsonSchema
      ? `${req.prompt}\nRespond ONLY with a JSON object matching: ${JSON.stringify(req.jsonSchema)}`
      : req.prompt;
    const text = await new Promise<string>((resolve, reject) => {
      execFile(
        'python3',
        ['-m', 'mlx_lm.generate', '--model', spec.repo, '--prompt', prompt, '--max-tokens', '512'],
        { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => (err ? reject(new Error(`MLX generate failed: ${String(err)}`)) : resolve(stdout)),
      );
    });
    return { text, toolCalls: [], pendingApproval: false };
  }

  private setStatus(id: LocalModelId, status: LocalModelState['status'], detail: string | null): void {
    this.models = this.models.map((m) => (m.id === id ? { ...m, status, detail } : m));
  }
}
