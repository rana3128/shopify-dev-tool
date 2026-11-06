# shopify-dev-tool

Start a Shopify app's local stack from one page of buttons.

- One **Start / Stop / Logs** button per process: your SDK watcher, mock server, backend, `shopify app dev`, a tunnel.
- One **Connect everything** button, which:
  1. starts the tunnel and reads its URL;
  2. writes the URL into your dev app config, so the app's dashboard URL points at your machine;
  3. restarts `shopify app dev` and reads the **GraphiQL link** from its output, so there's no pressing `g` and copying;
  4. sets a shop metafield through that GraphiQL link, so the storefront points at your machine.
- Link buttons (GraphiQL, app in admin, storefront) appear once their values are known.

It needs no server, no domain and no extra accounts: only Node 20+, Shopify CLI and (for the tunnel) `cloudflared`.
It has zero npm dependencies.

## Use

```bash
cd your-shopify-app
npx shopify-dev-tool            # or: node path/to/shopify-dev-tool/bin/cli.mjs
```

A page opens at `http://127.0.0.1:4590/`. Ctrl-C in the terminal stops every process it started.

Options: `--config <file>`, `--port <n>`, `--no-open`.

## Config

The tool looks for `shopify-dev-tool.config.json`, `dev/shopify-dev-tool.config.json` or
`.config/shopify-dev-tool.json`.

```json
{
  "name": "My app local dev",
  "root": ".",
  "protect": ["shopify.app.toml"],
  "processes": {
    "web":    { "label": "Web", "cmd": "npm run dev", "cwd": "web", "ready": { "port": 8080 } },
    "app":    { "label": "Dev app", "cmd": "shopify app dev -c my-dev --json", "logFormat": "jsonl",
                "capture": { "graphiqlUrl": "GraphiQL URL \\(Admin API\\): (\\S+)", "previewUrl": "Preview URL: (\\S+)" } },
    "tunnel": { "label": "Tunnel", "cmd": "cloudflared tunnel --no-autoupdate --url http://localhost:8080",
                "capture": { "tunnelUrl": "(https://[a-z0-9-]+\\.trycloudflare\\.com)" } }
  },
  "connect": [
    { "start": "web" },
    { "start": "tunnel", "waitFor": "tunnelUrl" },
    { "replace": { "files": ["shopify.app.my-dev.toml"], "pattern": "https://[a-z0-9-]+\\.trycloudflare\\.com", "with": "{tunnelUrl}" } },
    { "restart": "app", "waitFor": "graphiqlUrl", "timeoutMs": 300000 },
    { "shopifyMetafield": { "namespace": "my_app", "key": "dev_url", "value": "{tunnelUrl}" } }
  ],
  "links": { "GraphiQL": "{graphiqlUrl}", "App in admin": "{previewUrl}", "Storefront": "https://{store}" }
}
```

| Key | Meaning |
|---|---|
| `root` | Folder commands run from, relative to the config file. |
| `processes.<id>.cmd` | Shell command. `cwd` and `env` are optional. |
| `ready.port` | The process counts as "running" once this port accepts connections. |
| `capture` | `{ var: regex }`. The first group of a match on any output line becomes `{var}`. |
| `logFormat: "jsonl"` | Shows JSON log lines (`shopify app dev --json`) as `[source] message`. |
| `connect` | Steps, in order. Each step can have a `label`. |
| `start` / `restart` / `stop` | `start` keeps a process that's already running, so its tunnel URL stays the same. `waitFor` waits until a variable is captured. |
| `replace` | Regex replace in files. `with` can use variables. |
| `shopifyMetafield` | Sets a shop metafield through the GraphiQL link (`{graphiqlUrl}` by default). Sets `{store}`. |
| `protect` | Files that `replace` must never edit. Defaults to `shopify.app.toml`, the live app's config. |
| `graphqlApiVersion` | Admin API version for metafield calls (default `2026-04`). |

## Safety

- Listens on `127.0.0.1` only and rejects other `Host` headers. Every action needs a random token
  that's embedded in the page, so other websites can't press the buttons.
- `replace` only edits files inside `root` that aren't in `protect`.
- The GraphiQL key and the store password stay in memory only. The tool writes neither to disk, and step details hide the key.
- Each process runs in its own process group. Stop, Stop all and Ctrl-C end its children too.

## Limits

- macOS and Linux. Windows process-group stopping isn't supported yet.
- `cloudflared` quick tunnels give a new URL each time the tunnel restarts. Connect keeps a running tunnel,
  so Connect can be clicked again safely.

## Licence

MIT
