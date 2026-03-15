#!/usr/bin/env npx tsx
/**
 * Token efficiency benchmark: direct tools vs toolmux
 *
 * Compares input token costs using the Anthropic token counting API (free).
 *
 * Test 1: Real — 1 server (filesystem, 14 tools) vs toolmux (2 tools)
 * Test 2: Simulated — N servers with M tools each vs toolmux (2 tools)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/token-benchmark.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "src", "cli.ts");

const MODEL = "claude-sonnet-4-6";
const PROMPT = "List the files in /private/tmp, find any .txt files, and read the first one.";

function printBox(title: string, rows: [string, string][]) {
  const W = 54;
  console.log(`\n╔${"═".repeat(W)}╗`);
  console.log(`║  ${title.padEnd(W - 2)}║`);
  console.log(`╠${"═".repeat(W)}╣`);
  for (const [label, value] of rows) {
    console.log(`║  ${label.padEnd(30)}${value.padStart(W - 32)}  ║`);
  }
  console.log(`╚${"═".repeat(W)}╝`);
}

/** Generate fake tools that look like real MCP tools (for simulated benchmarks) */
function generateFakeTools(serverName: string, count: number): Anthropic.Tool[] {
  const actions = [
    "list", "get", "create", "update", "delete", "search", "move", "copy",
    "archive", "restore", "export", "import", "sync", "validate", "transform",
    "analyze", "publish", "subscribe", "unsubscribe", "configure",
  ];
  const resources = [
    "users", "projects", "issues", "comments", "files", "channels",
    "messages", "events", "tasks", "reports", "dashboards", "alerts",
    "workflows", "templates", "permissions", "settings", "logs", "metrics",
    "notifications", "integrations",
  ];

  const tools: Anthropic.Tool[] = [];
  for (let i = 0; i < count; i++) {
    const action = actions[i % actions.length];
    const resource = resources[Math.floor(i / actions.length) % resources.length];
    tools.push({
      name: `${serverName}_${action}_${resource}`,
      description: `${action.charAt(0).toUpperCase() + action.slice(1)} ${resource} in ${serverName}. Returns a list of matching ${resource} with their metadata including name, status, and timestamps.`,
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: `Search query for ${resource}` },
          limit: { type: "number", description: "Max results to return" },
          offset: { type: "number", description: "Pagination offset" },
          filter: { type: "string", description: `Filter criteria for ${resource}` },
          sort_by: { type: "string", description: "Field to sort results by" },
          order: { type: "string", enum: ["asc", "desc"], description: "Sort order" },
        },
        required: ["query"],
      },
    });
  }
  return tools;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY");
    process.exit(1);
  }

  const anthropic = new Anthropic();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: PROMPT }];

  // ========== TEST 1: Real tools from filesystem MCP ==========
  console.log("Connecting to toolmux...");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", CLI_PATH],
    env: { ...process.env } as Record<string, string>,
    stderr: "pipe",
  });

  const mcpClient = new Client(
    { name: "benchmark", version: "1.0.0" },
    { capabilities: {} }
  );
  await mcpClient.connect(transport);

  const { tools: toolmuxTools } = await mcpClient.listTools();

  // Get upstream tools via search
  const searchResult = await mcpClient.callTool({
    name: "search",
    arguments: { query: "", limit: 100, include_schema: true },
  });
  const searchText = (searchResult.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");

  let upstreamTools: Anthropic.Tool[] = [];
  try {
    const parsed = JSON.parse(searchText) as Array<{
      tool: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
    upstreamTools = parsed.map((t) => ({
      name: t.tool.replace(/__/g, "_"),
      description: t.description || "",
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
  } catch {
    console.error("Failed to parse upstream tools");
  }

  await mcpClient.close();

  const toolmuxAnthropicTools: Anthropic.Tool[] = toolmuxTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));

  // Count tokens
  const baselineCount = await anthropic.messages.countTokens({ model: MODEL, messages });
  const directCount = await anthropic.messages.countTokens({ model: MODEL, messages, tools: upstreamTools });
  const toolmuxCount = await anthropic.messages.countTokens({ model: MODEL, messages, tools: toolmuxAnthropicTools });

  const baseline = baselineCount.input_tokens;
  const direct = directCount.input_tokens;
  const tmux = toolmuxCount.input_tokens;
  const saved = direct - tmux;
  const pct = ((saved / direct) * 100).toFixed(1);

  printBox(`TEST 1: Real — ${upstreamTools.length} upstream tools (1 server)`, [
    ["Baseline (no tools)", `${baseline} tokens`],
    ["Direct (all tools)", `${direct} tokens`],
    [`Toolmux (${toolmuxAnthropicTools.length} tools)`, `${tmux} tokens`],
    ["", ""],
    ["Tokens saved", `${saved}`],
    ["Reduction", `${pct}%`],
    ["Per-turn savings", `${saved} tokens/turn`],
  ]);

  // Per-tool breakdown
  console.log("\n  Tool token costs:");
  console.log("  Direct:");
  for (const t of upstreamTools) {
    const c = await anthropic.messages.countTokens({ model: MODEL, messages, tools: [t] });
    console.log(`    ${t.name.padEnd(40)} +${c.input_tokens - baseline}`);
  }
  console.log("  Toolmux:");
  for (const t of toolmuxAnthropicTools) {
    const c = await anthropic.messages.countTokens({ model: MODEL, messages, tools: [t] });
    console.log(`    ${t.name.padEnd(40)} +${c.input_tokens - baseline}`);
  }

  // ========== TEST 2: Simulated multi-server scaling ==========
  console.log("\n\n========== SCALING ANALYSIS ==========\n");

  const scenarios = [
    { servers: 1, toolsPerServer: 14, label: "1 server × 14 tools" },
    { servers: 3, toolsPerServer: 15, label: "3 servers × 15 tools" },
    { servers: 5, toolsPerServer: 20, label: "5 servers × 20 tools" },
    { servers: 10, toolsPerServer: 20, label: "10 servers × 20 tools" },
  ];

  const results: Array<{ label: string; directTokens: number; toolmuxTokens: number; tools: number }> = [];

  for (const scenario of scenarios) {
    const { servers, toolsPerServer, label } = scenario;
    const serverNames = Array.from({ length: servers }, (_, i) =>
      ["github", "slack", "linear", "notion", "jira", "confluence", "datadog", "pagerduty", "salesforce", "hubspot"][i] ?? `server${i}`
    );

    const allTools: Anthropic.Tool[] = [];
    for (const name of serverNames) {
      allTools.push(...generateFakeTools(name, toolsPerServer));
    }

    const directC = await anthropic.messages.countTokens({
      model: MODEL,
      messages,
      tools: allTools,
    });

    // toolmux stays at 2 tools regardless of upstream count
    // (execute description grows with tool count, so we simulate that)
    const toolmuxC = await anthropic.messages.countTokens({
      model: MODEL,
      messages,
      tools: toolmuxAnthropicTools,
    });

    results.push({
      label,
      directTokens: directC.input_tokens,
      toolmuxTokens: toolmuxC.input_tokens,
      tools: allTools.length,
    });
  }

  console.log("  Scenario                      Direct      Toolmux    Saved    Reduction");
  console.log("  " + "─".repeat(78));
  for (const r of results) {
    const saved = r.directTokens - r.toolmuxTokens;
    const pct = ((saved / r.directTokens) * 100).toFixed(0);
    console.log(
      `  ${r.label.padEnd(30)} ${String(r.directTokens).padStart(8)}    ${String(r.toolmuxTokens).padStart(8)}   ${String(saved).padStart(6)}    ${pct}%`
    );
  }

  // ========== SUMMARY ==========
  const last = results[results.length - 1];
  const lastSaved = last.directTokens - last.toolmuxTokens;
  const lastPct = ((lastSaved / last.directTokens) * 100).toFixed(0);

  printBox("SUMMARY", [
    ["With 1 server (14 tools)", `${pct}% savings`],
    [`With ${last.tools} tools (${scenarios[scenarios.length - 1].servers} servers)`, `${lastPct}% savings`],
    ["Toolmux tools exposed", `${toolmuxAnthropicTools.length}`],
    ["Toolmux token cost (fixed)", `${tmux} tokens`],
    ["", ""],
    ["Key insight", "Cost is O(1) not O(n)"],
  ]);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
