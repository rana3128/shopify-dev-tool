// "Connect everything": runs the config's connect steps in order and reports each one.
import { readFileSync, writeFileSync } from 'node:fs';
import { checkEditable, stepType, template } from './config.mjs';
import { setShopMetafield } from './shopify.mjs';

const DEFAULT_WAIT_MS = 120_000;

export function describeStep(step) {
  if (step.label) return step.label;
  const type = stepType(step);
  const v = step[type];
  switch (type) {
    case 'start': return `Start ${v}${step.waitFor ? ` and get {${step.waitFor}}` : ''}`;
    case 'restart': return `Restart ${v}${step.waitFor ? ` and get {${step.waitFor}}` : ''}`;
    case 'stop': return `Stop ${v}`;
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
    steps[i].state = 'running';
    send();
    try {
      let detail = '';
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
      Object.assign(steps[i], { state: 'failed', detail: e.message });
      send();
      return false;
    }
  }
  return true;
}

// Don't show the GraphiQL key in step details; the link button has the full URL.
const maskKey = (s) => String(s).replace(/([?&]key=)[^&\s]+/g, '$1…');
