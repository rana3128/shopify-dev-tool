// Local page + API. Listens on 127.0.0.1 only; every action needs the token embedded in the page.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { template } from './config.mjs';
import { runConnect } from './connect.mjs';
import { Processes } from './procs.mjs';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
const MAX_BODY = 10_000;

export function createApp(config) {
  const token = randomBytes(24).toString('hex');
  const secrets = {}; // typed in the page (store password); memory only
  const procs = new Processes(config, {
    env: () => (secrets.storePassword ? { SHOPIFY_FLAG_STORE_PASSWORD: secrets.storePassword } : {}),
  });
  const clients = new Set();
  let connectSteps = [];
  let connecting = false;

  const links = () => Object.fromEntries(Object.entries(config.links).flatMap(([label, t]) => {
    try { return [[label, template(t, procs.vars)]]; } catch { return []; }
  }));
  const publicVars = () => Object.fromEntries(Object.entries(procs.vars).map(([k, v]) => [k, maskKey(v)]));
  const state = () => ({
    name: config.name,
    processes: Object.entries(config.processes).map(([name, p]) => ({ name, label: p.label || name, hidden: !!p.hidden, optional: !!p.optional, cmd: p.cmd })),
    status: procs.snapshot(),
    vars: publicVars(),
    links: links(),
    connect: connectSteps,
    connecting,
    hasPassword: !!secrets.storePassword,
  });
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  procs.on('status', () => broadcast('state', state()));
  procs.on('vars', () => broadcast('state', state()));
  procs.on('log', (l) => broadcast('log', l));

  const actions = {
    start: ({ name }) => procs.start(need(name)),
    stop: ({ name }) => procs.stop(need(name)),
    restart: ({ name }) => procs.restart(need(name)),
    stopAll: () => procs.stopAll(),
    password: ({ value }) => { secrets.storePassword = typeof value === 'string' && value ? value : undefined; broadcast('state', state()); },
    logs: ({ name }) => procs.state[need(name)].logs,
    connect: () => {
      if (connecting) return;
      connecting = true;
      runConnect(config, procs, (steps) => { connectSteps = steps; broadcast('state', state()); })
        .finally(() => { connecting = false; broadcast('state', state()); });
    },
  };
  const need = (name) => {
    if (!config.processes[name]) throw new Error(`unknown process ${name}`);
    return name;
  };

  const server = createServer(async (req, res) => {
    // Refuse requests for other host names (DNS rebinding).
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, 'forbidden');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      const html = readFileSync(UI, 'utf8').replace('__TOKEN__', token);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      if (!sameToken(url.searchParams.get('token'), token)) return send(res, 403, 'bad token');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const m = url.pathname.match(/^\/api\/(\w+)$/);
    if (req.method === 'POST' && m && actions[m[1]]) {
      if (!sameToken(req.headers['x-token'], token)) return send(res, 403, 'bad token');
      try {
        const body = await readJson(req);
        const result = await actions[m[1]](body);
        return send(res, 200, JSON.stringify(result ?? { ok: true }), 'application/json');
      } catch (e) {
        return send(res, 400, JSON.stringify({ error: e.message }), 'application/json');
      }
    }
    send(res, 404, 'not found');
  });

  return { server, procs, token };
}

const maskKey = (s) => String(s).replace(/([?&]key=)[^&\s]+/g, '$1…');

function sameToken(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function readJson(req) {
  return new Promise((done, fail) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) { fail(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { done(data ? JSON.parse(data) : {}); } catch { fail(new Error('invalid JSON')); } });
  });
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
