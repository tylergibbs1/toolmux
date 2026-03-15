#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Pool } from "./pool.js";
import { createToolmuxServer } from "./server.js";

function parseArgs(argv: string[]): { config?: string; help: boolean; version: boolean } {
  const args = argv.slice(2);
  let config: string | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version" || arg === "-v") version = true;
    else if (arg === "--config" || arg === "-c") config = args[++i];
    else if (!arg.startsWith("-")) config ??= arg;
  }

  return { config, help, version };
}

const HELP = `
toolmux — Smart MCP proxy

Connects to multiple MCP servers and exposes them through a single
MCP endpoint with discover/describe/call meta-tools.

Usage:
  toolmux [options] [config-path]

Options:
  -c, --config <path>  Path to config file (default: auto-detect)
  -h, --help           Show this help
  -v, --version        Show version

Config auto-detection searches:
  ./toolmux.json, ./.toolmux.json, ~/.config/toolmux/config.json, ~/toolmux.json

Environment variables in config values are expanded ($VAR or \${VAR}).

Example config (toolmux.json):
  {
    "servers": [
      {
        "name": "github",
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN" }
        }
      }
    ]
  }

Add to Claude Code:
  claude mcp add toolmux -- npx tsx /path/to/toolmux/src/cli.ts

Add to Claude Desktop (claude_desktop_config.json):
  {
    "mcpServers": {
      "toolmux": {
        "command": "npx",
        "args": ["tsx", "/path/to/toolmux/src/cli.ts"]
      }
    }
  }
`.trim();

async function main() {
  const { config, help, version } = parseArgs(process.argv);

  if (help) {
    console.log(HELP);
    process.exit(0);
  }

  if (version) {
    console.log("toolmux 0.1.0");
    process.exit(0);
  }

  const cfg = await loadConfig(config);
  const active = cfg.servers.filter((s) => !s.disabled);

  console.error(`[toolmux] Connecting to ${active.length} server(s)...`);

  const pool = new Pool();
  await pool.connect(cfg.servers);

  const server = createToolmuxServer(pool);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[toolmux] Ready — ${pool.totalTools} tools from ${pool.serverCount} servers`);

  const shutdown = async () => {
    console.error("[toolmux] Shutting down...");
    await pool.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[toolmux] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
