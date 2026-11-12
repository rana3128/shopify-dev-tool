import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkEditable, template, validateConfig } from '../src/config.mjs';
import { replaceInFiles } from '../src/connect.mjs';
import { captureFrom, Processes, renderLine } from '../src/procs.mjs';
import { graphqlEndpoint } from '../src/shopify.mjs';

const TUNNEL_RE = '(https://[a-z0-9-]+\\.trycloudflare\\.com)';
const GRAPHIQL_RE = 'GraphiQL URL \\(Admin API\\): (\\S+)';

test('template fills known variables and refuses unknown ones', () => {
  assert.equal(template('{a}/x?b={b}', { a: 'https://t', b: 1 }), 'https://t/x?b=1');
  assert.throws(() => template('{missing}', {}), /isn't known yet/);
});

test('captures the tunnel URL from a real cloudflared line', () => {
  const line = '2026-11-06T07:40:01Z INF |  https://career-indie-reviewed-jazz.trycloudflare.com                                   |';
  assert.deepEqual(captureFrom(line, { tunnelUrl: TUNNEL_RE }), { tunnelUrl: 'https://career-indie-reviewed-jazz.trycloudflare.com' });
});

test('renders shopify app dev --json lines and captures the GraphiQL URL', () => {
  const raw = '{"timestamp":"2026-11-06T07:45:48Z","source":"app dev","level":"info","message":"GraphiQL URL (Admin API): http://localhost:3457/graphiql?key=abc123"}';
  const text = renderLine(raw, 'jsonl');
  assert.equal(text, '[app dev] GraphiQL URL (Admin API): http://localhost:3457/graphiql?key=abc123');
  assert.deepEqual(captureFrom(text, { graphiqlUrl: GRAPHIQL_RE }), { graphiqlUrl: 'http://localhost:3457/graphiql?key=abc123' });
  assert.equal(renderLine('not json', 'jsonl'), 'not json');
});

test('GraphiQL URL → Admin API endpoint', () => {
  assert.equal(graphqlEndpoint('http://localhost:3457/graphiql?key=k1', '2026-04'),
    'http://localhost:3457/graphiql/graphql.json?key=k1&api_version=2026-04');
  assert.throws(() => graphqlEndpoint('http://localhost:3457/graphiql', '2026-04'), /no \?key=/);
});

test('protected and outside files are refused', () => {
  const root = '/proj';
  const protect = ['shopify.app.toml'];
  assert.equal(checkEditable(root, 'shopify.app.dev.toml', protect), '/proj/shopify.app.dev.toml');
  assert.throws(() => checkEditable(root, 'shopify.app.toml', protect), /protected/);
  assert.throws(() => checkEditable(root, './shopify.app.toml', protect), /protected/);
  assert.throws(() => checkEditable(root, '../other/x.toml', protect), /outside/);
  assert.throws(() => checkEditable(root, '/etc/hosts', protect), /relative/);
});

test('replaceInFiles swaps the old tunnel host and keeps paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdt-'));
  writeFileSync(join(root, 'shopify.app.dev.toml'), 'application_url = "https://old-one.trycloudflare.com/admin"\nuri = "https://old-one.trycloudflare.com/webhooks"\n');
  const out = replaceInFiles(root, ['shopify.app.toml'],
    { files: ['shopify.app.dev.toml'], pattern: 'https://[a-z0-9-]+\\.trycloudflare\\.com', with: '{tunnelUrl}' },
    { tunnelUrl: 'https://new-two.trycloudflare.com' });
  assert.match(out, /updated/);
  assert.equal(readFileSync(join(root, 'shopify.app.dev.toml'), 'utf8'),
    'application_url = "https://new-two.trycloudflare.com/admin"\nuri = "https://new-two.trycloudflare.com/webhooks"\n');
});

test('config validation reports every problem', () => {
  assert.throws(() => validateConfig({ processes: { a: {} }, connect: [{ start: 'b' }, { nope: 1 }] }),
    (e) => /needs a "cmd"/.test(e.message) && /unknown process "b"/.test(e.message) && /needs one of/.test(e.message));
  const ok = validateConfig({ processes: { a: { cmd: 'echo hi' } } });
  assert.deepEqual(ok.protect, ['shopify.app.toml']);
});

test('a process runs, captures a value, and stops with its children', async () => {
  const config = validateConfig({ processes: { p: { cmd: 'echo "url: https://x-y.trycloudflare.com"; sleep 30 & wait', capture: { tunnelUrl: TUNNEL_RE } } } });
  config.root = process.cwd();
  const procs = new Processes(config);
  procs.start('p');
  assert.equal(await procs.waitVar('p', 'tunnelUrl', 5000), 'https://x-y.trycloudflare.com');
  await procs.stop('p');
  assert.equal(procs.state.p.status, 'stopped');
});

test('connect: skips steps whose file is missing, continues past optional failures, runs commands', async () => {
  const { runConnect } = await import('../src/connect.mjs');
  const config = validateConfig({
    processes: { p: { cmd: 'sleep 30' } },
    connect: [
      { run: 'echo hello', label: 'run' },
      { start: 'p', when: { exists: 'no-such-file' }, label: 'skip' },
      { run: 'echo boom >&2; exit 2', optional: true, label: 'warn' },
      { run: 'echo after', label: 'after' },
    ],
  });
  config.root = process.cwd();
  const procs = new Processes(config);
  let last;
  const ok = await runConnect(config, procs, (s) => { last = s; });
  assert.equal(ok, true);
  assert.deepEqual(last.map((s) => s.state), ['done', 'skipped', 'warn', 'done']);
  assert.equal(last[0].detail, 'hello');
  assert.equal(last[2].detail, 'boom');
  assert.equal(procs.state.p.status, 'stopped');
});

test('waiting fails fast when the process exits', async () => {
  const config = validateConfig({ processes: { p: { cmd: 'exit 3', capture: { v: '(x)' } } } });
  config.root = process.cwd();
  const procs = new Processes(config);
  procs.start('p');
  await assert.rejects(procs.waitVar('p', 'v', 5000), /stopped before/);
  assert.equal(procs.state.p.status, 'failed');
});

test('connect: a waiting step shows live output, turns "attention" on a matching line, and a timeout says the last line', async () => {
  const { runConnect } = await import('../src/connect.mjs');
  const config = validateConfig({
    processes: {
      login: { cmd: 'echo "To run this command, log in to Shopify."; echo "Open https://accounts.example.com/activate?key=secret"; sleep 30', attention: 'log in to', capture: { v: 'never (x)' } },
      slow: { cmd: 'echo "still building"; sleep 30', capture: { v2: 'never (x)' } },
    },
    connect: [
      { start: 'login', waitFor: 'v', timeoutMs: 2500, optional: true, label: 'login' },
      { start: 'slow', waitFor: 'v2', timeoutMs: 1500, label: 'slow' },
    ],
  });
  config.root = process.cwd();
  const procs = new Processes(config);
  const seen = [];
  const ok = await runConnect(config, procs, (s) => seen.push(s.map((x) => ({ ...x }))));
  await procs.stopAll();
  assert.equal(ok, false);
  const attention = seen.find((s) => s[0].state === 'attention');
  assert.ok(attention, 'login step turned attention');
  assert.match(attention[0].detail, /log in to Shopify/);
  assert.match(attention[0].detail, /key=…/, 'secret key masked');
  assert.ok(!attention[0].detail.includes('secret'));
  assert.ok(seen.some((s) => s[1].state === 'running' && /s · still building/.test(s[1].detail)), 'live detail while waiting');
  const last = seen.at(-1);
  assert.equal(last[0].state, 'warn');
  assert.equal(last[1].state, 'failed');
  assert.match(last[1].detail, /timed out .*Last output: still building/);
});

test('terminal log: steps, status and output lines, secrets masked, --quiet hides output', async () => {
  const { createApp } = await import('../src/server.mjs');
  const make = (quiet) => {
    const config = validateConfig({ processes: { p: { cmd: 'echo "GraphiQL URL (Admin API): http://localhost:1/graphiql?key=abc"', capture: { graphiqlUrl: 'GraphiQL URL \\(Admin API\\): (\\S+)' } } }, connect: [{ start: 'p', waitFor: 'graphiqlUrl', label: 'Start p' }] });
    config.root = process.cwd();
    const lines = [];
    const app = createApp(config, { log: (who, msg) => lines.push(`${who} ${msg}`), quiet });
    return { app, lines };
  };
  for (const quiet of [false, true]) {
    const { app, lines } = make(quiet);
    const base = await new Promise((r) => app.server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${app.server.address().port}`)));
    await fetch(`${base}/api/connect`, { method: 'POST', headers: { 'x-token': app.token } });
    for (let i = 0; i < 50 && !lines.some((l) => /connect finished|connect stopped/.test(l)); i++) await new Promise((r) => setTimeout(r, 100));
    app.server.close();
    await app.procs.stopAll();
    const all = lines.join('\n');
    assert.match(all, /connect started/);
    assert.match(all, /connect ✓ Start p/);
    assert.match(all, /connect finished/);
    assert.match(all, /vars \{graphiqlUrl\} = http:\/\/localhost:1\/graphiql\?key=…/);
    assert.ok(!all.includes('key=abc'), 'key masked');
    assert.equal(/p │ GraphiQL/.test(all), !quiet);
  }
});

test('killExisting: stops leftovers on the port or matching the command, never its own processes', async () => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const port = await new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const marker = `sdt-leftover-${process.pid}`;
  // Two "leftovers" from an earlier run: one holds the port, one matches by command line.
  const holder = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1'); setTimeout(() => {}, 60000)`], { detached: true, stdio: 'ignore' });
  const named = spawn('/bin/sh', ['-c', `sleep 60; : ${marker}`], { detached: true, stdio: 'ignore' });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50; i++) { try { await new Promise((ok, no) => { const c = require_connect(port, ok, no); }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  const config = validateConfig({ processes: {
    keep: { cmd: `sleep 60; : ${marker}-own` },
    p: { cmd: 'sleep 30', killExisting: { ports: [port], match: `${marker}($|-own)` }, ready: { port } },
  } });
  config.root = process.cwd();
  const procs = new Processes(config);
  await procs.start('keep'); // the tool's own process also matches the pattern: it must survive
  await procs.start('p');
  const logs = procs.state.p.logs.map((l) => l.text).join('\n');
  assert.match(logs, new RegExp(`stopping leftover pid ${holder.pid} \\(port ${port}\\)`));
  assert.match(logs, new RegExp(`stopping leftover pid ${named.pid} \\(command matches\\)`));
  assert.equal(alive(holder.pid), false);
  assert.equal(alive(named.pid), false);
  assert.equal(procs.state.keep.status, 'running');
  await procs.stopAll();
  assert.throws(() => validateConfig({ processes: { a: { cmd: 'x', killExisting: {} } } }), /needs ports or match/);
});

function require_connect(port, ok, no) {
  return import('node:net').then(({ connect }) => { const c = connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); ok(); }); c.once('error', no); });
}
