/**
 * Proxy route tests: the real scripts/local-llm-proxy.mjs, spawned as a child
 * process against stub backends, a temp model library, and a fake oMLX. The
 * bridge-adapter suite covers the app side against a stub proxy; this covers
 * the proxy side — status codes, inventory shape, download semantics, and the
 * rule that it may only stop servers it started itself.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

const PROXY_SCRIPT = path.resolve(process.cwd(), 'scripts', 'local-llm-proxy.mjs');
const BONSAI_4B = 'prism-ml/Ternary-Bonsai-4B-mlx-2bit';
const BONSAI_8B = 'prism-ml/Ternary-Bonsai-8B-mlx-1bit';

/** A fake oMLX: serves the subdirectories of --model-dir, like the real one. */
const FAKE_OMLX = `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const modelDir = args[args.indexOf('--model-dir') + 1] ?? '';
const port = Number(args[args.indexOf('--port') + 1]);
const ids = [];
try {
  for (const org of fs.readdirSync(modelDir)) {
    for (const name of fs.readdirSync(path.join(modelDir, org))) ids.push(name);
  }
} catch {}
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: ids.map((id) => ({ id })) })); return; }
  res.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
}).listen(port, '127.0.0.1');
`;

/** A backend that belongs to nobody: it answers, but no PID file claims it. */
const BARE_LISTENER = `require('node:http').createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'someone-elses-model' }] }));
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function freePort(): Promise<number> {
  const server = http.createServer();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', resolve);
  await promise;
  const { port } = server.address() as AddressInfo;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
}

async function listenOn(port: number, handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(port, '127.0.0.1', resolve);
  await promise;
  return server;
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Real child processes over real sockets. Their clocks cannot be faked, and
 * the condition being awaited lives in another process, so this polls the
 * actual condition under a bounded deadline rather than guessing a duration.
 */
async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

interface Env {
  root: string;
  libraryDir: string;
  hfCacheDir: string;
  pidFile: string;
  proxyPort: number;
  bonsaiPort: number;
  needleUp: { value: boolean };
  served: { value: string[] };
  get: (route: string) => Promise<{ status: number; json: Record<string, unknown> }>;
  post: (route: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
  awaitDownloadSettled: () => Promise<Record<string, unknown>>;
  requestRaw: (route: string, init?: RequestInit) => Promise<Response>;
  stop: () => Promise<void>;
}

/**
 * A complete, isolated bridge: stub needle, a Bonsai port in one of four
 * states, temp dirs, and a real proxy process. Every test builds its own, so
 * nothing leaks between them.
 */
async function startEnv(
  options: { bonsai?: 'stub' | 'outsider' | 'managed' | 'free'; env?: Record<string, string> } = {},
): Promise<Env> {
  const bonsaiMode = options.bonsai ?? 'stub';
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-proxy-'));
  const libraryDir = path.join(root, 'omlx-models');
  const hfCacheDir = path.join(root, 'hf-hub');
  const pidDir = path.join(root, 'pids');
  await fsp.mkdir(pidDir, { recursive: true });
  await fsp.mkdir(libraryDir, { recursive: true });
  await fsp.mkdir(hfCacheDir, { recursive: true });

  const omlxBin = path.join(root, 'omlx');
  await fsp.writeFile(omlxBin, FAKE_OMLX);
  await fsp.chmod(omlxBin, 0o755);

  const needleUp = { value: true };
  const served = { value: [BONSAI_4B.replace('/', '--')] };

  const needle = await listenOn(0, (_req, res) => {
    res.writeHead(needleUp.value ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'call', success: true, function_calls: [], confidence: 1 }));
  });
  const needlePort = (needle.address() as AddressInfo).port;

  const bonsaiPort = await freePort();
  // The ownership record is namespaced by port, so bridges cannot collide.
  const pidFile = path.join(pidDir, `calorie-counter-bonsai-${bonsaiPort}.pid`);
  const children: ChildProcess[] = [];
  let bonsaiServer: http.Server | null = null;

  if (bonsaiMode === 'stub') {
    bonsaiServer = await listenOn(bonsaiPort, (req, res) => {
      if (!served.value.length) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not ready' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        req.url === '/v1/models'
          ? JSON.stringify({ data: served.value.map((id) => ({ id })) })
          : JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
      );
    });
  } else if (bonsaiMode === 'outsider') {
    bonsaiServer = await listenOn(bonsaiPort, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'someone-elses-model' }] }));
    });
  } else if (bonsaiMode === 'managed') {
    // A separate process, so the proxy can legitimately stop it by PID.
    const child = spawn('node', ['-e', BARE_LISTENER], {
      env: { ...process.env, PORT: String(bonsaiPort) },
      stdio: 'ignore',
    });
    children.push(child);
    await waitFor(() => reachable(`http://127.0.0.1:${bonsaiPort}/v1/models`), 'managed backend');
    await fsp.writeFile(pidFile, String(child.pid));
  }

  cleanups.push(async () => {
    for (const child of children) child.kill('SIGKILL');
    if (bonsaiServer) {
      const closed = Promise.withResolvers<void>();
      bonsaiServer.close(() => closed.resolve());
      await closed.promise;
    }
    const needleClosed = Promise.withResolvers<void>();
    needle.close(() => needleClosed.resolve());
    await needleClosed;
  });

  const proxyPort = await freePort();
  const proxy = spawn('node', [PROXY_SCRIPT], {
    env: {
      ...process.env,
      LLM_HOST: '127.0.0.1',
      LLM_PORT: String(needlePort),
      LLM_BONSAI_PORT: String(bonsaiPort),
      LLM_PROXY_PORT: String(proxyPort),
      LLM_PID_DIR: pidDir,
      OMLX_LIBRARY_DIR: libraryDir,
      HF_CACHE_DIR: hfCacheDir,
      OMLX_BIN: omlxBin,
      LLM_BIN: path.join(root, 'needle-bin'),
      LLM_BONSAI_RUNNER: 'omlx',
      ...options.env,
    },
    stdio: 'ignore',
  });
  children.push(proxy);
  await waitFor(() => reachable(`http://127.0.0.1:${proxyPort}/health`), 'proxy to start');

  const requestRaw = (route: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${proxyPort}${route}`, init);

  const call = async (method: 'GET' | 'POST', route: string, body?: unknown) => {
    const res = await requestRaw(route, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  return {
    root,
    libraryDir,
    hfCacheDir,
    pidFile,
    proxyPort,
    bonsaiPort,
    needleUp,
    served,
    get: (route) => call('GET', route),
    post: (route, body) => call('POST', route, body),
    requestRaw,
    awaitDownloadSettled: () =>
      waitFor(
        async () => {
          const { json } = await call('GET', '/models/download/status');
          if (json.running === true) return false;
          return true;
        },
        'download to settle',
        30_000,
      ).then(async () => (await call('GET', '/models/download/status')).json),
    stop: async () => {
      proxy.kill('SIGKILL');
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

describe('proxy — health and inventory', () => {
  it('reports needle readiness through the app-facing /health route', async () => {
    const env = await startEnv();
    try {
      expect((await env.get('/health')).status).toBe(200);
      env.needleUp.value = false;
      expect((await env.get('/health')).status).toBe(503);
    } finally {
      await env.stop();
    }
  });

  it('lists each model with the source it was found in', async () => {
    const env = await startEnv();
    try {
      await fsp.mkdir(path.join(env.libraryDir, BONSAI_8B), { recursive: true });
      await fsp.mkdir(path.join(env.hfCacheDir, `models--${BONSAI_4B.replace('/', '--')}`), { recursive: true });

      const { status, json } = await env.get('/models');
      expect(status).toBe(200);
      const models = json.models as Array<Record<string, unknown>>;
      expect(models.map((m) => m.id)).toEqual(['needle-2', 'bonsai-4b', 'bonsai-8b-1bit']);
      expect(models.find((m) => m.id === 'bonsai-4b')).toMatchObject({
        downloaded: true,
        source: 'hf-cache',
        active: true,
        servedAs: BONSAI_4B.replace('/', '--'),
      });
      expect(models.find((m) => m.id === 'bonsai-8b-1bit')).toMatchObject({
        downloaded: true,
        source: 'omlx-library',
        active: false,
        servedAs: null,
      });
      expect(models.find((m) => m.id === 'needle-2')).toMatchObject({ downloaded: false, active: true });
    } finally {
      await env.stop();
    }
  });

  it('distinguishes a backend that is starting from one that is not running', async () => {
    const starting = await startEnv();
    const absent = await startEnv({ bonsai: 'free' });
    try {
      starting.served.value = [];
      const upButBusy = await starting.get('/health/bonsai');
      expect(upButBusy.status).toBe(503);
      expect(upButBusy.json.listening).toBe(true);

      const nothingThere = await absent.get('/health/bonsai');
      expect(nothingThere.status).toBe(503);
      expect(nothingThere.json.listening).toBe(false);
    } finally {
      await starting.stop();
      await absent.stop();
    }
  });
});

describe('proxy — downloads', () => {
  it('rejects an unknown model id and a malformed body', async () => {
    const env = await startEnv();
    try {
      const unknown = await env.post('/models/download', { id: 'nope' });
      expect(unknown.status).toBe(404);
      expect(unknown.json.error).toMatch(/unknown model id/);

      const malformed = await env.requestRaw('/models/download', { method: 'POST', body: 'not json' });
      expect(malformed.status).toBe(400);
    } finally {
      await env.stop();
    }
  });

  it('runs the configured command with the id, repo and destination substituted', async () => {
    const env = await startEnv({
      env: {
        MODEL_DOWNLOAD_CMD: `mkdir -p '{DEST}' && printf '%s' '{ID}|{REPO}' > '{DEST}/receipt.txt'`,
      },
    });
    try {
      const started = await env.post('/models/download', { id: 'bonsai-8b-1bit' });
      expect(started.status).toBe(202);
      expect(started.json.dest).toBe(path.join(env.libraryDir, BONSAI_8B));

      const settled = await env.awaitDownloadSettled();
      expect(settled).toMatchObject({ running: false, done: true, error: null, progress: 1 });

      const receipt = await fsp.readFile(path.join(env.libraryDir, BONSAI_8B, 'receipt.txt'), 'utf8');
      expect(receipt).toBe(`bonsai-8b-1bit|${BONSAI_8B}`);

      // the artifact the command produced is what the inventory now reports
      const models = (await env.get('/models')).json.models as Array<Record<string, unknown>>;
      expect(models.find((m) => m.id === 'bonsai-8b-1bit')).toMatchObject({
        downloaded: true,
        source: 'omlx-library',
      });
    } finally {
      await env.stop();
    }
  });

  it('reports a failed command as an error with the command output kept', async () => {
    const env = await startEnv({
      env: { MODEL_DOWNLOAD_CMD: `echo 'no space left on device' >&2; exit 3` },
    });
    try {
      expect((await env.post('/models/download', { id: 'bonsai-4b' })).status).toBe(202);
      const settled = await env.awaitDownloadSettled();
      expect(settled.running).toBe(false);
      expect(settled.done).toBe(false);
      expect(String(settled.error)).toMatch(/exited 3/);
      expect(String(settled.error)).toMatch(/no space left on device/);
      expect(settled.logTail as string[]).toContain('no space left on device');
    } finally {
      await env.stop();
    }
  });

  it('refuses a second download while one is in flight', async () => {
    const env = await startEnv({ env: { MODEL_DOWNLOAD_CMD: 'sleep 20' } });
    try {
      expect((await env.post('/models/download', { id: 'bonsai-4b' })).status).toBe(202);
      const second = await env.post('/models/download', { id: 'bonsai-8b-1bit' });
      expect(second.status).toBe(409);
      expect(second.json.error).toMatch(/download in progress/);
    } finally {
      await env.stop();
    }
  });
});

describe('proxy — model switching', () => {
  it('refuses needle-2, which has no selectable model', async () => {
    const env = await startEnv();
    try {
      const { status, json } = await env.post('/models/use', { id: 'needle-2' });
      expect(status).toBe(400);
      expect(json.error).toMatch(/no selectable model/);
    } finally {
      await env.stop();
    }
  });

  it('rejects a folder that is not an MLX model directory', async () => {
    const env = await startEnv();
    try {
      const empty = path.join(env.root, 'not-a-model');
      await fsp.mkdir(empty, { recursive: true });
      const { status, json } = await env.post('/models/use', { path: empty });
      expect(status).toBe(400);
      expect(json.error).toMatch(/config\.json/);
    } finally {
      await env.stop();
    }
  });

  it('refuses to take a port from a process it did not start', async () => {
    const env = await startEnv({ bonsai: 'outsider' });
    try {
      const { status, json } = await env.post('/models/use', { id: 'bonsai-4b' });
      expect(status).toBe(409);
      expect(json.error).toMatch(/not bridge-managed/);

      // the occupant is still there, untouched
      const still = await fetch(`http://127.0.0.1:${env.bonsaiPort}/v1/models`);
      const body = (await still.json()) as { data: Array<{ id: string }> };
      expect(body.data[0]!.id).toBe('someone-elses-model');
    } finally {
      await env.stop();
    }
  });

  it('replaces its own backend and confirms the requested model is being served', async () => {
    const env = await startEnv({ bonsai: 'managed' });
    try {
      await fsp.mkdir(path.join(env.libraryDir, BONSAI_4B), { recursive: true });
      const { status, json } = await env.post('/models/use', { id: 'bonsai-4b' });
      expect(status).toBe(200);
      expect(json.status).toBe('ok');
      expect(json.runner).toBe('omlx');
      expect(json.served).toContain('Ternary-Bonsai-4B-mlx-2bit');

      // the predecessor is gone and the replacement answers on the same port
      const live = await fetch(`http://127.0.0.1:${env.bonsaiPort}/v1/models`);
      const ids = ((await live.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
      expect(ids).toEqual(['Ternary-Bonsai-4B-mlx-2bit']);
      expect(Number(await fsp.readFile(env.pidFile, 'utf8'))).toBeGreaterThan(0);
    } finally {
      await env.stop();
    }
  });
});

describe('proxy — CORS', () => {
  it('answers preflight with permissive headers for the app origin', async () => {
    const env = await startEnv();
    try {
      const res = await env.requestRaw('/complete', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'POST' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await env.stop();
    }
  });

  it('answers an unknown route with 404 rather than hanging', async () => {
    const env = await startEnv();
    try {
      const res = await env.requestRaw('/nope');
      expect(res.status).toBe(404);
    } finally {
      await env.stop();
    }
  });
});
