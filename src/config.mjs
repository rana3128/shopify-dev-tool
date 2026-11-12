// Config file: which processes get a button, and what "Connect" does.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const CONFIG_NAMES = ['shopify-dev-tool.config.json', 'dev/shopify-dev-tool.config.json', '.config/shopify-dev-tool.json'];
const STEP_TYPES = ['start', 'restart', 'stop', 'run', 'replace', 'shopifyMetafield'];

export function findConfig(cwd, explicit) {
  if (explicit) return resolve(cwd, explicit);
  for (const name of CONFIG_NAMES) {
    const file = join(cwd, name);
    if (existsSync(file)) return file;
  }
  return null;
}

export function loadConfig(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const config = validateConfig(raw);
  // Commands run from `root`, relative to the config file (default: the config file's folder).
  config.root = resolve(dirname(file), raw.root || '.');
  return config;
}

export function validateConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');
  const processes = raw.processes || {};
  if (!Object.keys(processes).length) errors.push('"processes" needs at least one entry');
  for (const [name, p] of Object.entries(processes)) {
    if (!/^[a-z0-9_-]+$/i.test(name)) errors.push(`process name "${name}": letters, digits, - and _ only`);
    if (!p || typeof p.cmd !== 'string' || !p.cmd.trim()) errors.push(`process "${name}" needs a "cmd"`);
    for (const [v, re] of Object.entries(p?.capture || {})) {
      try { new RegExp(re); } catch (e) { errors.push(`process "${name}" capture "${v}": ${e.message}`); }
    }
    if (p?.attention != null) {
      try { new RegExp(p.attention); } catch (e) { errors.push(`process "${name}" attention: ${e.message}`); }
    }
    const k = p?.killExisting;
    if (k != null) {
      if (k.ports != null && !(Array.isArray(k.ports) && k.ports.every(Number.isInteger))) errors.push(`process "${name}" killExisting.ports must be a list of numbers`);
      if (k.match != null) { try { new RegExp(k.match); } catch (e) { errors.push(`process "${name}" killExisting.match: ${e.message}`); } }
      if (!k.ports?.length && !k.match) errors.push(`process "${name}" killExisting needs ports or match`);
    }
    if (p?.ready?.port != null && !Number.isInteger(p.ready.port)) errors.push(`process "${name}" ready.port must be a number`);
  }
  (raw.connect || []).forEach((step, i) => {
    const type = STEP_TYPES.find((t) => t in step);
    if (!type) return errors.push(`connect step ${i + 1}: needs one of ${STEP_TYPES.join(', ')}`);
    if (['start', 'restart', 'stop'].includes(type) && !processes[step[type]]) {
      errors.push(`connect step ${i + 1}: unknown process "${step[type]}"`);
    }
    if (type === 'run' && (typeof step.run !== 'string' || !step.run.trim())) errors.push(`connect step ${i + 1}: run needs a command`);
    if (step.when != null && typeof step.when?.exists !== 'string') errors.push(`connect step ${i + 1}: when needs { "exists": "<path>" }`);
    if (type === 'replace') {
      const r = step.replace;
      if (!Array.isArray(r?.files) || !r.files.length || !r.pattern || r.with == null) {
        errors.push(`connect step ${i + 1}: replace needs files[], pattern and with`);
      }
    }
    if (type === 'shopifyMetafield') {
      const m = step.shopifyMetafield;
      if (!m?.namespace || !m?.key || m.value == null) errors.push(`connect step ${i + 1}: shopifyMetafield needs namespace, key, value`);
    }
  });
  if (errors.length) throw new Error(`Invalid config:\n  - ${errors.join('\n  - ')}`);
  return {
    name: raw.name || 'Shopify local dev',
    port: raw.port || 4590,
    protect: raw.protect || ['shopify.app.toml'],
    graphqlApiVersion: raw.graphqlApiVersion || '2026-04',
    processes,
    connect: raw.connect || [],
    links: raw.links || {},
  };
}

export const stepType = (step) => STEP_TYPES.find((t) => t in step);

// "{tunnelUrl}/x" → value. Throws when a variable isn't known yet.
export function template(str, vars) {
  return String(str).replace(/\{([a-zA-Z_][\w]*)\}/g, (_, name) => {
    if (vars[name] == null) throw new Error(`{${name}} isn't known yet`);
    return vars[name];
  });
}

// Is `file` (relative to root) allowed to be edited?
export function checkEditable(root, file, protect) {
  if (isAbsolute(file)) throw new Error(`${file}: use a path relative to the project`);
  const full = resolve(root, file);
  if (!full.startsWith(root + '/') && full !== root) throw new Error(`${file}: outside the project`);
  const rel = full.slice(root.length + 1);
  if (protect.some((p) => p === rel || p === rel.split('/').pop())) throw new Error(`${file} is protected; refusing to edit it`);
  return full;
}
