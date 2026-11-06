// "Connect everything": runs the config's connect steps in order and reports each one.
import { exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkEditable, stepType, template } from './config.mjs';
import { setShopMetafield } from './shopify.mjs';

const DEFAULT_WAIT_MS = 120_000;

// A one-off command (e.g. "turn local overrides on"). Resolves with its last output line.
export function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((done, fail) => {
    exec(cmd, { cwd, timeout: timeoutMs, shell: '/bin/sh', env: { ...process.env, FORCE_COLOR: '0' } }, (err, stdout, stderr) => {
      const last = `${stdout}\n${stderr}`.trim().split('\n').filter(Boolean).pop() || '';
      if (err) fail(new Error(last || err.message));
      else done(last || 'done');
    });
  });
}

export function describeStep(step) {
  if (step.label) return step.label;
  const type = stepType(step);
  const v = step[type];
  switch (type) {
    case 'start': return `Start ${v}${step.waitFor ? ` and get {${step.waitFor}}` : ''}`;
    case 'restart': return `Restart ${v}${step.waitFor ? ` and get {${step.waitFor}}` : ''}`;
    case 'stop': return `Stop ${v}`;
    case 'run': return `Run ${v}`;
    case 'replace': return `Update ${v.files.join(', ')}`;
    case 'shopifyMetafield': return `Set metafield ${v.namespace}.${v.key}`;
    default: return type;
  }
}

// Replace `pattern` with `with` in each file. Returns a short summary.
export function replaceInFiles(root, protect, { files, pattern, with: replacement }, vars) {
  const value = template(replacement, vars);
  const done = [];
  for (const file of files) {
    const full = checkEditable(root, file, protect);
    const before = readFileSync(full, 'utf8');
    const after = before.replace(new RegExp(pattern, 'g'), () => value);
    if (after !== before) writeFileSync(full, after);
    done.push(`${file}: ${after === before ? 'already up to date' : 'updated'}`);
  }
  return done.join('; ');
}

export async function runConnect(config, procs, report) {
  const steps = config.connect.map((s) => ({ label: describeStep(s), state: 'pending', detail: '' }));
  const send = () => report(steps.map((s) => ({ ...s })));
  send();
  for (let i = 0; i < config.connect.length; i++) {
    const step = config.connect[i];
    const type = stepType(step);
    const name = step[type];
    const wait = step.timeoutMs || DEFAULT_WAIT_MS;
    if (step.when?.exists && !existsSync(resolve(config.root, step.when.exists))) {
      Object.assign(steps[i], { state: 'skipped', detail: `skipped: ${step.when.exists} not found` });
      send();
      continue;
    }
    steps[i].state = 'running';
    send();
    try {
      let detail = '';
      if (type === 'run') detail = await runCommand(name, config.root, wait);
      if (type === 'start' || type === 'restart') {
        // `start` keeps a process that's already running, so its URL doesn't change.
        if (type === 'restart') await procs.restart(name);
        else if (!procs.isRunning(name)) procs.start(name);
        else detail = 'already running';
        if (step.waitFor) detail = await procs.waitVar(name, step.waitFor, wait);
        else await procs.waitRunning(name, wait);
      } else if (type === 'stop') {
        await procs.stop(name);
      } else if (type === 'replace') {
        detail = replaceInFiles(config.root, config.protect, step.replace, procs.vars);
      } else if (type === 'shopifyMetafield') {
        const m = step.shopifyMetafield;
        const value = template(m.value, procs.vars);
        const graphiqlUrl = template(m.graphiqlUrl || '{graphiqlUrl}', procs.vars);
        const shop = await setShopMetafield(graphiqlUrl, config.graphqlApiVersion, { ...m, value });
        procs.setVar('store', shop);
        detail = `${shop}: ${m.namespace}.${m.key} = ${value}`;
      }
      Object.assign(steps[i], { state: 'done', detail: maskKey(detail || 'done') });
      send();
    } catch (e) {
      // An optional step that fails is reported, and the rest still run.
      Object.assign(steps[i], { state: step.optional ? 'warn' : 'failed', detail: e.message });
      send();
      if (!step.optional) return false;
    }
  }
  return true;
}

// Don't show the GraphiQL key in step details; the link button has the full URL.
const maskKey = (s) => String(s).replace(/([?&]key=)[^&\s]+/g, '$1…');
