#!/usr/bin/env node
// Local LLM bridge proxy — the ONLY origin the browser app fetches.
//
// Owns CORS deterministically (neither the needle server nor mlx_lm.server
// document CORS) and hides the per-backend ports from the app:
//   POST /complete               -> needle server  (LLM_PORT)
//   POST /v1/chat/completions    -> Bonsai backend (LLM_BONSAI_PORT)
//   GET  /v1/models              -> Bonsai backend
//   GET  /health                 -> probe needle /complete with {"input":"ping"}
//   GET  /health/bonsai          -> probe the Bonsai backend's /v1/models
//   GET  /models                 -> what is on disk, and what is live
//   POST /models/download        -> start a download (202 | 404 | 409)
//   GET  /models/download/status -> progress + log tail of the active download
//   POST /models/use             -> restart the Bonsai backend on another model
//
// Model management lives here rather than in the app: a browser tab cannot run
// a command or see a real filesystem path. Downloads land in the oMLX library
// (~/.omlx/models/<org>/<name>) because that layout is simultaneously a plain
// MLX model directory (mlx_lm.server --model <dir>) and the directory oMLX
// already scans — so both runtimes can serve what we download.
//
// Env: LLM_PORT (8080), LLM_BONSAI_PORT (8082), LLM_PROXY_PORT (8090),
//      LLM_HOST (127.0.0.1), LLM_BONSAI_API_KEY (bearer token the backend
//      requires — oMLX is keyed by default), LLM_BIN (needle binary),
//      OMLX_LIBRARY_DIR (~/.omlx/models), OMLX_BIN, HF_CACHE_DIR
//      (~/.cache/huggingface/hub), LLM_PYTHON (python3),
//      LLM_BONSAI_RUNNER (auto | mlx_lm | omlx), LLM_BONSAI_MODEL,
//      LLM_BONSAI_LOG, LLM_PID_DIR (${TMPDIR:-/tmp}), LLM_START_SCRIPT,
//      MODEL_DOWNLOAD_CMD (override; {ID}/{REPO}/{DEST} substituted).
// Zero dependencies: node:http + global fetch.

import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HOST = process.env.LLM_HOST ?? '127.0.0.1';
const NEEDLE_PORT = process.env.LLM_PORT ?? '8080';
const BONSAI_PORT = process.env.LLM_BONSAI_PORT ?? '8082';
const PROXY_PORT = process.env.LLM_PROXY_PORT ?? '8090';
const BONSAI_API_KEY = process.env.LLM_BONSAI_API_KEY ?? '';
const LLM_PYTHON = process.env.LLM_PYTHON ?? 'python3';
const BONSAI_RUNNER = process.env.LLM_BONSAI_RUNNER ?? 'auto';
const BONSAI_MODEL = process.env.LLM_BONSAI_MODEL ?? 'prism-ml/Ternary-Bonsai-4B-mlx-2bit';
const OMLX_LIBRARY_DIR = process.env.OMLX_LIBRARY_DIR ?? path.join(os.homedir(), '.omlx', 'models');
const HF_CACHE_DIR = process.env.HF_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'huggingface', 'hub');
const NEEDLE_BIN =
  process.env.LLM_BIN ??
  path.join(os.homedir(), 'Library', 'Caches', 'calorie-counter', 'needle', 'macos-arm64', 'needle');
const PID_DIR = process.env.LLM_PID_DIR ?? process.env.TMPDIR ?? '/tmp';
// Namespaced by port so a second bridge (the smoke test's test-port bridge)
// cannot clobber this one's ownership record or error log.
const BONSAI_PID_FILE = path.join(PID_DIR, `calorie-counter-bonsai-${BONSAI_PORT}.pid`);
const BONSAI_LOG =
  process.env.LLM_BONSAI_LOG ?? path.join(PID_DIR, `calorie-counter-bonsai-${BONSAI_PORT}.log`);
const START_SCRIPT =
  process.env.LLM_START_SCRIPT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'start-local-llm.sh');

/** The three models the app knows about (mirrors src/local-ai/mlx.ts). */
const MODELS = {
  'needle-2': { repo: 'Cactus-Compute/needle2', kind: 'binary' },
  'bonsai-4b': { repo: 'prism-ml/Ternary-Bonsai-4B-mlx-2bit', kind: 'mlx' },
  'bonsai-8b-1bit': { repo: 'prism-ml/Ternary-Bonsai-8B-mlx-1bit', kind: 'mlx' },
};

/** Which bonsai id the configured LLM_BONSAI_MODEL repo corresponds to. */
const ACTIVE_BONSAI_ID =
  Object.keys(MODELS).find((id) => MODELS[id].kind === 'mlx' && MODELS[id].repo === BONSAI_MODEL) ?? null;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

function hfHeaders() {
  const headers = { 'User-Agent': 'calorie-counter-local-bridge' };
  if (process.env.HF_TOKEN) headers.Authorization = `Bearer ${process.env.HF_TOKEN}`;
  return headers;
}

function bonsaiHeaders() {
  return BONSAI_API_KEY ? { Authorization: `Bearer ${BONSAI_API_KEY}` } : {};
}

async function forward(req, res, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] ?? 'application/json', ...bonsaiHeaders() },
      body: req.method === 'POST' ? await readBody(req) : undefined,
      signal: controller.signal,
    });
    const text = await upstream.text();
    if (text.length > 4 * 1024 * 1024) {
      json(res, 502, { error: 'upstream response too large' });
      return;
    }
    res.writeHead(upstream.status, { 'Content-Type': 'application/json', ...CORS });
    res.end(text);
  } catch (err) {
    json(res, 502, { error: `upstream unreachable: ${String(err?.cause ?? err)}` });
  } finally {
    clearTimeout(timer);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

async function backendOk(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', headers: bonsaiHeaders(), signal: controller.signal });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function needleHealth() {
  // needle has no /health; readiness = a /complete round trip answers 200.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`http://${HOST}:${NEEDLE_PORT}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ping' }),
      signal: controller.signal,
    });
    return res.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- inventory

async function fileSize(target) {
  try {
    const st = await fsp.stat(target);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return null;
    let total = 0;
    for (const entry of await fsp.readdir(target, { withFileTypes: true })) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) total += (await fileSize(child)) ?? 0;
      else if (entry.isFile()) total += (await fsp.stat(child)).size;
    }
    return total;
  } catch {
    return null;
  }
}

async function exists(target) {
  return fsp.access(target).then(
    () => true,
    () => false,
  );
}

/** Where a download for this id lands. */
function modelDest(id) {
  const spec = MODELS[id];
  if (spec.kind === 'binary') return NEEDLE_BIN;
  const [org, name] = spec.repo.split('/');
  return path.join(OMLX_LIBRARY_DIR, org, name);
}

function hfCacheDir(id) {
  return path.join(HF_CACHE_DIR, `models--${MODELS[id].repo.replace('/', '--')}`);
}

/** On-disk inventory for one id: first matching source wins. */
async function modelOnDisk(id) {
  if (MODELS[id].kind === 'binary') {
    const size = await fileSize(NEEDLE_BIN);
    return size === null ? null : { sizeBytes: size, source: 'bridge-cache' };
  }
  const dest = modelDest(id);
  if (await exists(dest)) return { sizeBytes: await fileSize(dest), source: 'omlx-library' };
  const cache = hfCacheDir(id);
  if (await exists(cache)) return { sizeBytes: await fileSize(cache), source: 'hf-cache' };
  return null;
}

async function bonsaiServedIds() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://${HOST}:${BONSAI_PORT}/v1/models`, {
      method: 'GET',
      headers: bonsaiHeaders(),
      signal: controller.signal,
    });
    if (res.status !== 200) return null;
    const data = await res.json();
    return (Array.isArray(data?.data) ? data.data : []).map((m) => m?.id).filter((x) => typeof x === 'string');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function listModels() {
  const needleUp = await needleHealth();
  const bonsaiIds = await bonsaiServedIds();
  const models = [];
  for (const id of Object.keys(MODELS)) {
    const disk = await modelOnDisk(id);
    // servedAs is the id the backend itself reports — the app must send that
    // exact string back, and a multi-model server (oMLX) serves several ids,
    // so "the first one" is not good enough.
    const servedAs =
      id === 'needle-2'
        ? needleUp
          ? 'needle-2'
          : null
        : (bonsaiIds?.find((s) => servedNamesMatch(MODELS[id].repo.split('/')[1], [s])) ?? null);
    models.push({
      id,
      downloaded: disk !== null,
      sizeBytes: disk?.sizeBytes ?? null,
      source: disk?.source ?? null,
      active: id === 'needle-2' ? needleUp : id === ACTIVE_BONSAI_ID && servedAs !== null,
      servedAs,
    });
  }
  return { models, bonsaiServed: bonsaiIds ?? [] };
}

// ---------------------------------------------------------------- downloads

const download = {
  id: null,
  running: false,
  done: false,
  error: null,
  progress: 0,
  logTail: [],
};

function logLine(line) {
  for (const part of String(line).split('\n')) {
    const trimmed = part.trim();
    if (trimmed) download.logTail.push(trimmed);
  }
  if (download.logTail.length > 20) download.logTail.splice(0, download.logTail.length - 20);
}

function resetDownload(id) {
  download.id = id;
  download.running = true;
  download.done = false;
  download.error = null;
  download.progress = 0;
  download.logTail = [];
}

function encodeRepoPath(file) {
  return file.split('/').map(encodeURIComponent).join('/');
}

/** Stream one file to `<target>.part` then rename, so a target is never half-written. */
async function fetchToFile(url, target, onBytes) {
  const res = await fetch(url, { headers: hfHeaders(), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error(`empty response body for ${url}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      onBytes(chunk.length);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(part));
  await fsp.rename(part, target);
}

/** Multi-file Hugging Face repo download (no huggingface_hub required). */
async function downloadHfRepo(repo, dest) {
  const res = await fetch(`https://huggingface.co/api/models/${repo}`, { headers: hfHeaders() });
  if (!res.ok) throw new Error(`model index for ${repo} failed (HTTP ${res.status})`);
  const info = await res.json();
  const files = (Array.isArray(info?.siblings) ? info.siblings : [])
    .map((s) => s?.rfilename)
    .filter((f) => typeof f === 'string' && f);
  if (!files.length) throw new Error(`model index for ${repo} listed no files`);

  await fsp.mkdir(dest, { recursive: true });
  const plan = [];
  let total = 0;
  for (const file of files) {
    const url = `https://huggingface.co/${repo}/resolve/main/${encodeRepoPath(file)}`;
    const head = await fetch(url, { method: 'HEAD', headers: hfHeaders(), redirect: 'follow' });
    if (!head.ok) {
      logLine(`skip ${file} (HTTP ${head.status})`);
      continue;
    }
    const size = Number(head.headers.get('content-length') ?? 0);
    plan.push({ file, url, size });
    total += size;
  }
  if (!plan.length) throw new Error(`no downloadable files in ${repo}`);

  let received = 0;
  logLine(`downloading ${plan.length} files (${Math.round(total / 1e6)} MB) from ${repo}`);
  for (const { file, url, size } of plan) {
    const target = path.join(dest, file);
    const existing = (await fileSize(target)) ?? null;
    if (existing !== null && size > 0 && existing === size) {
      received += size;
      download.progress = total ? Math.min(1, received / total) : 0;
      logLine(`have ${file}`);
      continue;
    }
    await fetchToFile(url, target, (bytes) => {
      received += bytes;
      download.progress = total ? Math.min(1, received / total) : 0;
    });
    logLine(`got ${file} (${size || 'unknown'} bytes)`);
  }
}

function runShell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { env: process.env });
    child.stdout.on('data', (d) => logLine(d.toString()));
    child.stderr.on('data', (d) => logLine(d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      // The reason a download failed is in the output, not the exit code.
      const last = download.logTail[download.logTail.length - 1];
      reject(new Error(last ? `exited ${code}: ${last}` : `exited ${code}`));
    });
  });
}

/**
 * Start one download. Satisfies the plan's contract: child exit 0 AND the
 * artifact ends up on disk, otherwise the log tail is the error.
 */
async function startDownload(id) {
  resetDownload(id);
  const spec = MODELS[id];
  const dest = modelDest(id);
  try {
    const template = process.env.MODEL_DOWNLOAD_CMD;
    if (template) {
      const command = template
        .replaceAll('{ID}', id)
        .replaceAll('{REPO}', spec.repo)
        .replaceAll('{DEST}', dest);
      logLine(`$ ${command}`);
      await runShell(command);
    } else if (spec.kind === 'binary') {
      // One implementation of the needle fetch (cache path, verification,
      // ad-hoc signing) lives in the launcher; this delegates to it.
      logLine(`$ LLM_DOWNLOAD_ONLY=1 LLM_BACKEND=needle sh ${START_SCRIPT}`);
      await runShell(`LLM_DOWNLOAD_ONLY=1 LLM_BACKEND=needle sh '${START_SCRIPT}'`);
    } else {
      await downloadHfRepo(spec.repo, dest);
    }
    const disk = await modelOnDisk(id);
    if (!disk) throw new Error(`download finished but nothing is at ${dest}`);
    download.progress = 1;
    download.done = true;
    logLine(`done: ${id} (${disk.sizeBytes} bytes, ${disk.source})`);
  } catch (err) {
    download.error = String(err?.message ?? err);
    logLine(`error: ${download.error}`);
  } finally {
    download.running = false;
  }
}

// ------------------------------------------------------------- runner switch

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '') }));
  });
}

async function portListeners(port) {
  const { ok, stdout } = await run('lsof', ['-tnP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (!ok) return [];
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portListeners(port)).length) return true;
    await sleep(500);
  }
  return !(await portListeners(port)).length;
}

async function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await backendOk(`http://${HOST}:${BONSAI_PORT}/v1/models`, 3000)) return true;
    await sleep(2000);
  }
  return false;
}

async function omlxBinary() {
  if (process.env.OMLX_BIN) return (await exists(process.env.OMLX_BIN)) ? process.env.OMLX_BIN : null;
  const which = await run('sh', ['-c', 'command -v omlx']);
  if (which.ok && which.stdout.trim()) return which.stdout.trim();
  const fallback = path.join(os.homedir(), '.omlx', 'bin', 'omlx');
  return (await exists(fallback)) ? fallback : null;
}

async function canImportMlxLm() {
  const { ok } = await run(LLM_PYTHON, ['-c', 'import mlx_lm']);
  return ok;
}

async function detectRunner() {
  if (BONSAI_RUNNER === 'mlx_lm' || BONSAI_RUNNER === 'omlx') return BONSAI_RUNNER;
  if (await canImportMlxLm()) return 'mlx_lm';
  if (await omlxBinary()) return 'omlx';
  return 'none';
}

async function readPidFile() {
  const raw = await fsp.readFile(BONSAI_PID_FILE, 'utf8').catch(() => null);
  if (!raw) return null;
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Stop ONLY a server this bridge started: PID file first, lsof confirmation second. */
async function stopManagedBonsai() {
  const listeners = await portListeners(BONSAI_PORT);
  if (!listeners.length) return { stopped: false };
  const pid = await readPidFile();
  if (pid === null || !listeners.includes(String(pid))) {
    throw Object.assign(
      new Error(
        'port occupant is not bridge-managed; stop it and rerun scripts/start-local-llm.sh, or set LLM_BONSAI_PORT',
      ),
      { status: 409 },
    );
  }
  process.kill(pid, 'SIGTERM');
  if (!(await waitForPortFree(BONSAI_PORT, 20_000))) {
    process.kill(pid, 'SIGKILL');
    if (!(await waitForPortFree(BONSAI_PORT, 10_000))) {
      throw Object.assign(new Error(`port ${BONSAI_PORT} stayed busy after SIGKILL`), { status: 503 });
    }
  }
  await fsp.rm(BONSAI_PID_FILE, { force: true });
  return { stopped: true, pid };
}

/** Make an arbitrary model directory visible to oMLX, which discovers by scan. */
async function linkIntoLibrary(source) {
  const st = await fsp.stat(source).catch(() => null);
  if (!st || !st.isDirectory()) throw Object.assign(new Error(`${source} is not a directory`), { status: 400 });
  if (!(await exists(path.join(source, 'config.json')))) {
    throw Object.assign(new Error(`${source} has no config.json — not an MLX model directory`), { status: 400 });
  }
  const link = path.join(OMLX_LIBRARY_DIR, path.basename(source));
  if (link === source) return link;
  const existing = await fsp.lstat(link).catch(() => null);
  if (existing) {
    const target = existing.isSymbolicLink() ? await fsp.readlink(link).catch(() => null) : null;
    if (target === source) return link;
    throw Object.assign(
      new Error(`${link} already exists and is not a link to ${source}`),
      { status: 409 },
    );
  }
  await fsp.mkdir(path.dirname(link), { recursive: true });
  await fsp.symlink(source, link);
  return link;
}

function normalizeModelName(value) {
  return String(value).toLowerCase().replace(/[/\\]+/g, '-').replace(/-+/g, '-');
}

function servedNamesMatch(expected, served) {
  const want = normalizeModelName(expected);
  return served.some((id) => {
    const have = normalizeModelName(id);
    return have === want || have.includes(want) || want.includes(have);
  });
}

function spawnDetached(command, args) {
  // The child inherits this descriptor; the parent's copy must be closed or
  // every switch leaks one file handle.
  const out = fs.openSync(BONSAI_LOG, 'a');
  const child = spawn(command, args, { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

async function tailLog(lines = 5) {
  const raw = await fsp.readFile(BONSAI_LOG, 'utf8').catch(() => '');
  return raw.split('\n').filter((l) => l.trim()).slice(-lines);
}

/**
 * Restart the Bonsai backend on a different model. `target` is either a model
 * id (repo, or library path) or an explicit path the user typed in Settings.
 */
async function useModel({ id, modelPath }) {
  const runner = await detectRunner();
  if (runner === 'none') {
    throw Object.assign(
      new Error('no Bonsai runtime available — install mlx-lm (pip install mlx mlx-lm) or oMLX'),
      { status: 503 },
    );
  }

  let launchTarget;
  if (modelPath) {
    const resolved = path.resolve(modelPath);
    launchTarget = runner === 'omlx' ? await linkIntoLibrary(resolved) : resolved;
  } else {
    if (!ACTIVE_BONSAI_ID || id !== ACTIVE_BONSAI_ID) {
      throw Object.assign(
        new Error(
          `the bridge is configured for ${BONSAI_MODEL || 'no bonsai model'}; set LLM_BONSAI_MODEL=${MODELS[id].repo} and retry`,
        ),
        { status: 400 },
      );
    }
    launchTarget = runner === 'omlx' ? OMLX_LIBRARY_DIR : MODELS[id].repo;
  }

  await stopManagedBonsai();

  let pid;
  if (runner === 'mlx_lm') {
    pid = spawnDetached(LLM_PYTHON, [
      '-m', 'mlx_lm.server',
      '--model', launchTarget,
      '--host', HOST,
      '--port', BONSAI_PORT,
    ]);
  } else {
    const bin = await omlxBinary();
    const args = ['serve', '--model-dir', OMLX_LIBRARY_DIR, '--host', HOST, '--port', BONSAI_PORT];
    if (BONSAI_API_KEY) args.push('--api-key', BONSAI_API_KEY);
    pid = spawnDetached(bin, args);
  }
  await fsp.writeFile(BONSAI_PID_FILE, String(pid));

  if (!(await waitForBackend(180_000))) {
    throw Object.assign(
      new Error(`Bonsai backend did not become ready; see ${BONSAI_LOG}`),
      { status: 503, logTail: await tailLog() },
    );
  }

  const served = (await bonsaiServedIds()) ?? [];
  const expected = modelPath ? path.basename(launchTarget) : MODELS[id].repo.split('/')[1];
  if (!servedNamesMatch(expected, served)) {
    throw Object.assign(
      new Error(`${expected} is not among the served models: ${served.join(', ') || 'none'}`),
      { status: 503, logTail: await tailLog() },
    );
  }
  return { status: 'ok', runner, model: expected, served, pid };
}

// -------------------------------------------------------------------- routes

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', `http://${HOST}:${PROXY_PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return (await needleHealth())
        ? json(res, 200, { status: 'ok' })
        : json(res, 503, { status: 'error', detail: 'needle server not ready' });
    }
    if (req.method === 'GET' && url.pathname === '/health/bonsai') {
      const ok = await backendOk(`http://${HOST}:${BONSAI_PORT}/v1/models`, 3000);
      if (ok) return json(res, 200, { status: 'ok', listening: true });
      // "Not answering" is two different states: a server that is up and still
      // loading the weights, and no server at all. Only the first is progress.
      const listening = (await portListeners(BONSAI_PORT)).length > 0;
      return json(res, 503, {
        status: 'loading',
        listening,
        detail: listening ? 'bonsai server is starting' : 'bonsai server is not running',
      });
    }
    if (req.method === 'GET' && url.pathname === '/models') {
      return json(res, 200, await listModels());
    }
    if (req.method === 'POST' && url.pathname === '/models/download') {
      const body = await readJson(req);
      if (body === null) return json(res, 400, { error: 'invalid JSON body' });
      if (!body.id || !Object.hasOwn(MODELS, body.id)) {
        return json(res, 404, { error: `unknown model id: ${String(body.id)}` });
      }
      if (download.running) return json(res, 409, { error: 'download in progress', id: download.id });
      void startDownload(body.id);
      return json(res, 202, { downloadId: body.id, id: body.id, dest: modelDest(body.id) });
    }
    if (req.method === 'GET' && url.pathname === '/models/download/status') {
      return json(res, 200, {
        running: download.running,
        id: download.id,
        done: download.done,
        error: download.error,
        progress: download.progress,
        logTail: download.logTail,
      });
    }
    if (req.method === 'POST' && url.pathname === '/models/use') {
      const body = await readJson(req);
      if (body === null) return json(res, 400, { error: 'invalid JSON body' });
      if (body.id === 'needle-2' && !body.path) {
        return json(res, 400, { error: 'needle-2 has no selectable model' });
      }
      if (body.path !== undefined && typeof body.path !== 'string') {
        return json(res, 400, { error: 'path must be a string' });
      }
      if (!body.path && (!body.id || !Object.hasOwn(MODELS, body.id))) {
        return json(res, 404, { error: `unknown model id: ${String(body.id)}` });
      }
      try {
        return json(res, 200, await useModel({ id: body.id, modelPath: body.path }));
      } catch (err) {
        return json(res, err?.status ?? 500, {
          error: String(err?.message ?? err),
          ...(err?.logTail ? { logTail: err.logTail } : {}),
        });
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return forward(req, res, `http://${HOST}:${BONSAI_PORT}/v1/models`, 5000);
    }
    if (req.method === 'POST' && url.pathname === '/complete') {
      return forward(req, res, `http://${HOST}:${NEEDLE_PORT}/complete`, 120_000);
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      return forward(req, res, `http://${HOST}:${BONSAI_PORT}/v1/chat/completions`, 120_000);
    }
    json(res, 404, { error: `unknown route ${req.method} ${url.pathname}` });
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(Number(PROXY_PORT), HOST, () => {
  console.log(`local LLM bridge proxy on http://${HOST}:${PROXY_PORT}`);
});
