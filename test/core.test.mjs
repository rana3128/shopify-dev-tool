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

test('waiting fails fast when the process exits', async () => {
  const config = validateConfig({ processes: { p: { cmd: 'exit 3', capture: { v: '(x)' } } } });
  config.root = process.cwd();
  const procs = new Processes(config);
  procs.start('p');
  await assert.rejects(procs.waitVar('p', 'v', 5000), /stopped before/);
  assert.equal(procs.state.p.status, 'failed');
});
