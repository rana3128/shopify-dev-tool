#!/usr/bin/env node
// shopify-dev-tool [--config <file>] [--port <n>] [--no-open] [--quiet]
import { spawn } from 'node:child_process';
import { CONFIG_NAMES, findConfig, loadConfig } from '../src/config.mjs';
import { createApp } from '../src/server.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log(`usage: shopify-dev-tool [--config <file>] [--port <n>] [--no-open] [--quiet]\n  --quiet  terminal shows steps and status only, not every output line\nlooks for: ${CONFIG_NAMES.join(', ')}`);
  process.exit(0);
}

const file = findConfig(process.cwd(), opt('--config'));
if (!file) {
  console.error(`No config found. Create one of: ${CONFIG_NAMES.join(', ')} (see README).`);
  process.exit(1);
}
let config;
try {
  config = loadConfig(file);
} catch (e) {
  console.error(`${file}: ${e.message}`);
  process.exit(1);
}

const port = Number(opt('--port') || config.port);
// "12:01:02 app        message"; later lines of a multi-line message are indented under the first.
const WHO_WIDTH = 10;
const stamp = () => new Date().toTimeString().slice(0, 8);
const log = (who, msg) => {
  const pad = ' '.repeat(stamp().length + WHO_WIDTH + 2);
  console.log(`${stamp()} ${who.padEnd(WHO_WIDTH)} ${String(msg).split('\n').join(`\n${pad}`)}`);
};
const { server, procs } = createApp(config, { log, quiet: args.includes('--quiet') });
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use: is the tool already open? Or pass --port.` : e.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`${config.name}: ${url}  (config ${file})\nCtrl-C stops everything.`);
  if (!args.includes('--no-open')) openBrowser(url);
});

let quitting = false;
const quit = async () => {
  if (quitting) return process.exit(1); // second Ctrl-C: force
  quitting = true;
  console.log('\nStopping all processes…');
  await procs.stopAll();
  process.exit(0);
};
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

function openBrowser(url) {
  const [cmd, ...a] = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
