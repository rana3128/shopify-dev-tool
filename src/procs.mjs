// Runs the configured processes: start/stop, status, logs, and values captured from their output.
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { resolve } from 'node:path';

const MAX_LOG_LINES = 500;
const STOP_GRACE_MS = 5000;
const READY_POLL_MS = 500;
const LEFTOVER_GRACE_MS = 3000;

const run = (cmd, args) => new Promise((done, fail) => {
  execFile(cmd, args, (err, stdout) => {
    // lsof exits 1 when nothing matches: that's an empty answer, not a failure.
    if (err && !(cmd === 'lsof' && err.code === 1)) fail(err); else done(stdout);
  });
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Processes this one would clash with, left over from an earlier run (another terminal, a crashed tool):
// listening on one of `spec.ports`, or with a command line matching `spec.match`.
// `ownGroups` are the process groups the tool started; those, and the tool itself, are never listed.
export async function findLeftovers(spec, ownGroups = new Set()) {
  const list = (await run('ps', ['-Ao', 'pid=,pgid=,command='])).split('\n').flatMap((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), pgid: Number(m[2]), cmd: m[3] }] : [];
  });
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const found = new Map();
  for (const port of spec.ports || []) {
    for (const pid of (await run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])).split(/\s+/).filter(Boolean).map(Number)) {
      found.set(pid, { pid, cmd: byPid.get(pid)?.cmd || '?', why: `port ${port}` });
    }
  }
  if (spec.match) {
    const re = new RegExp(spec.match);
    for (const p of list) if (re.test(p.cmd)) found.set(p.pid, { pid: p.pid, cmd: p.cmd, why: 'command matches' });
  }
  return [...found.values()].filter(({ pid }) => pid !== process.pid && pid !== process.ppid && !ownGroups.has(byPid.get(pid)?.pgid));
}

// SIGTERM, then SIGKILL for any still alive after the grace time.
async function killPids(pids, graceMs = LEFTOVER_GRACE_MS) {
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  const until = Date.now() + graceMs;
  while (pids.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

// One output line → the text to show. `jsonl` lines (shopify app dev --json) become "[source] message".
export function renderLine(line, format) {
  if (format !== 'jsonl') return line;
  try {
    const o = JSON.parse(line);
    if (o && typeof o.message === 'string') return o.source ? `[${o.source}] ${o.message}` : o.message;
  } catch { /* not JSON: show as is */ }
  return line;
}

// Values captured from one line: { varName: firstGroup }.
export function captureFrom(text, capture = {}) {
  const found = {};
  for (const [name, re] of Object.entries(capture)) {
    const m = new RegExp(re).exec(text);
    if (m) found[name] = m[1] ?? m[0];
  }
  return found;
}

const portOpen = (port) => new Promise((done) => {
  const s = connect({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
});

export class Processes extends EventEmitter {
  constructor(config, { env = () => ({}) } = {}) {
    super();
    this.config = config;
    this.extraEnv = env; // e.g. a store password typed in the page; never written to disk
    this.vars = {};
    this.state = Object.fromEntries(Object.keys(config.processes).map((n) => [n, { status: 'stopped', logs: [] }]));
  }

  snapshot() {
    return Object.fromEntries(Object.entries(this.state).map(([n, s]) => [n, { status: s.status, code: s.code ?? null }]));
  }

  setVar(name, value) {
    if (this.vars[name] === value) return;
    if (value == null) delete this.vars[name]; else this.vars[name] = value;
    this.emit('vars', { ...this.vars });
  }

  #status(name, status, extra = {}) {
    Object.assign(this.state[name], { status, ...extra });
    this.emit('status', { name, status, code: this.state[name].code ?? null });
  }

  #log(name, text, stream = 'out') {
    const logs = this.state[name].logs;
    logs.push({ t: Date.now(), stream, text });
    if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
    this.emit('log', { name, stream, text });
  }

  // The last `n` output lines of the current run (not the tool's own "$ cmd" / "exited" lines).
  lastLines(name, n = 1) {
    return this.state[name].logs.filter((l) => l.stream !== 'sys').slice(-n).map((l) => l.text);
  }

  isRunning(name) {
    return ['starting', 'running'].includes(this.state[name].status);
  }

  async start(name) {
    const p = this.config.processes[name];
    const s = this.state[name];
    if (this.isRunning(name)) return;
    for (const v of Object.keys(p.capture || {})) this.setVar(v, null); // a new run gives new values
    s.logs = [];
    s.code = null;
    s.cancelled = false;
    this.#status(name, 'starting');
    if (p.killExisting) await this.#killLeftovers(name, p.killExisting);
    if (s.cancelled) { this.#status(name, 'stopped'); return; } // Stop was pressed meanwhile
    this.#log(name, `$ ${p.cmd}`, 'sys');
    const child = spawn(p.cmd, {
      cwd: resolve(this.config.root, p.cwd || '.'),
      shell: true,
      detached: true, // own process group, so stop() also ends its children
      env: { ...process.env, FORCE_COLOR: '0', ...(p.env || {}), ...this.extraEnv() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    s.child = child;
    for (const [stream, src] of [['out', child.stdout], ['err', child.stderr]]) {
      let buf = '';
      src.setEncoding('utf8');
      src.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) this.#line(name, line, stream);
      });
      src.on('end', () => { if (buf) this.#line(name, buf, stream); });
    }
    child.on('error', (e) => this.#log(name, `failed to start: ${e.message}`, 'sys'));
    child.on('exit', (code, signal) => {
      s.child = null;
      this.#log(name, `exited (${signal || code})`, 'sys');
      this.#status(name, s.stopping || code === 0 ? 'stopped' : 'failed', { code });
      s.stopping = false;
    });
    if (p.ready?.port) this.#waitPort(name, child, p.ready.port);
    else this.#status(name, 'running');
  }

  async #killLeftovers(name, spec) {
    const own = new Set(Object.values(this.state).flatMap((st) => (st.child ? [st.child.pid] : [])));
    try {
      const found = await findLeftovers(spec, own);
      for (const f of found) this.#log(name, `stopping leftover pid ${f.pid} (${f.why}): ${f.cmd}`, 'sys');
      if (found.length) await killPids(found.map((f) => f.pid));
    } catch (e) {
      this.#log(name, `couldn't check for leftover processes: ${e.message}`, 'sys');
    }
  }

  async #waitPort(name, child, port) {
    while (this.state[name].child === child) {
      if (await portOpen(port)) {
        if (this.state[name].child === child) this.#status(name, 'running');
        return;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }

  #line(name, raw, stream) {
    if (!raw.trim()) return;
    const p = this.config.processes[name];
    const text = renderLine(raw, p.logFormat);
    this.#log(name, text, stream);
    for (const [v, value] of Object.entries(captureFrom(text, p.capture))) this.setVar(v, value);
  }

  stop(name) {
    const s = this.state[name];
    const child = s.child;
    if (!child) {
      if (s.status === 'starting') s.cancelled = true; // still clearing leftovers
      return Promise.resolve();
    }
    s.stopping = true;
    return new Promise((done) => {
      child.once('exit', done);
      const kill = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
      kill('SIGTERM');
      setTimeout(() => { if (s.child === child) kill('SIGKILL'); }, STOP_GRACE_MS).unref();
    });
  }

  async restart(name) {
    await this.stop(name);
    await this.start(name);
  }

  stopAll() {
    return Promise.all(Object.keys(this.state).map((n) => this.stop(n)));
  }

  // Resolves once `name` is running (port open, if it has one); rejects if it exits first.
  waitRunning(name, timeoutMs) {
    return this.#waitUntil(name, () => this.state[name].status === 'running', `${name} to be ready`, timeoutMs);
  }

  // Resolves with the value once process `name` has printed variable `v`.
  waitVar(name, v, timeoutMs) {
    return this.#waitUntil(name, () => this.vars[v], `${name} to print {${v}}`, timeoutMs).then(() => this.vars[v]);
  }

  #waitUntil(name, ok, what, timeoutMs) {
    return new Promise((done, fail) => {
      const check = () => {
        if (ok()) { cleanup(); done(); return; }
        if (['failed', 'stopped'].includes(this.state[name].status)) { cleanup(); fail(new Error(`${name} stopped before ${what.replace(`${name} `, '')}`)); }
      };
      const timer = setTimeout(() => { cleanup(); fail(new Error(`timed out waiting for ${what}`)); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.off('status', check); this.off('vars', check); };
      this.on('status', check);
      this.on('vars', check);
      check();
    });
  }
}
