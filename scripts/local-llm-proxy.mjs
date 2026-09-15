#!/usr/bin/env node
// Local LLM bridge proxy — the ONLY origin the browser app fetches.
//
// Owns CORS deterministically (neither the needle server nor mlx_lm.server
// document CORS) and hides the per-backend ports from the app:
//   POST /complete              -> needle server  (LLM_PORT)
//   POST /v1/chat/completions   -> mlx server     (LLM_BONSAI_PORT)
//   GET  /health                -> probe needle /complete with {"input":"ping"}
//   GET  /health/bonsai         -> probe mlx /v1/models (503 = still loading)
//
// Env: LLM_PORT (8080), LLM_BONSAI_PORT (8082), LLM_PROXY_PORT (8090),
//      LLM_HOST (127.0.0.1). Zero dependencies: node:http + global fetch.

import http from 'node:http';

const HOST = process.env.LLM_HOST ?? '127.0.0.1';
const NEEDLE_PORT = process.env.LLM_PORT ?? '8080';
const BONSAI_PORT = process.env.LLM_BONSAI_PORT ?? '8082';
const PROXY_PORT = process.env.LLM_PROXY_PORT ?? '8090';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

async function forward(req, res, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] ?? 'application/json' },
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

async function backendOk(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
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
      return json(res, ok ? 200 : 503, ok ? { status: 'ok' } : { status: 'loading', detail: 'bonsai server not ready' });
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
    json(res, 500, { error: String(err) });
  }
});

server.listen(Number(PROXY_PORT), HOST, () => {
  console.log(`local LLM bridge proxy on http://${HOST}:${PROXY_PORT}`);
});
