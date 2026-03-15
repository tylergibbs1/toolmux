#!/usr/bin/env npx tsx
/**
 * Token efficiency benchmark: direct tools vs toolmux
 *
 * Compares the input token count of:
 * 1. All upstream tools injected directly (the normal MCP way)
 * 2. Toolmux's 4 meta-tools (discover, describe, call, execute)
 *
 * Uses the Anthropic token counting API (free, no inference cost).
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

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY");
    process.exit(1);
  }

  const anthropic = new Anthropic();

  // --- Step 1: Connect to toolmux to get both tool sets ---
  console.log("Connecting to toolmux...\n");

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

  // Get toolmux meta-tools
  const { tools: toolmuxTools } = await mcpClient.listTools();

  // Get the upstream tools by using discover("") to list all
  const discoverResult = await mcpClient.callTool({
    name: "discover",
    arguments: { query: "", limit: 100 },
  });
  const discoverText = (discoverResult.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("\n");

  // Get full schemas for each upstream tool
  const toolNames = discoverText
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => {
      const match = line.match(/^- (\S+)/);
      return match ? match[1] : null;
    })
    .filter(Boolean) as string[];

  const upstreamTools: Anthropic.Tool[] = [];
  for (const name of toolNames) {
    const descResult = await mcpClient.callTool({
      name: "describe",
      arguments: { tool: name },
    });
    const descText = (descResult.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!)
      .join("");

    try {
      const detail = JSON.parse(descText);
      upstreamTools.push({
        name: detail.tool.replace(/__/g, "_"),
        description: detail.description || "",
        input_schema: detail.inputSchema as Anthropic.Tool.InputSchema,
      });
    } catch {
      // skip unparseable
    }
  }

  await mcpClient.close();

  // --- Step 2: Convert to Anthropic tool format ---
  const toolmuxAnthropicTools: Anthropic.Tool[] = toolmuxTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));

  console.log(`Upstream tools: ${upstreamTools.length}`);
  console.log(`Toolmux meta-tools: ${toolmuxAnthropicTools.length}\n`);

  // --- Step 3: Count tokens for both approaches ---
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: PROMPT },
  ];

  console.log("Counting tokens...\n");

  // Direct: all upstream tools
  const directCount = await anthropic.messages.countTokens({
    model: MODEL,
    messages,
    tools: upstreamTools,
  });

  // Toolmux: 4 meta-tools
  const toolmuxCount = await anthropic.messages.countTokens({
    model: MODEL,
    messages,
    tools: toolmuxAnthropicTools,
  });

  // Baseline: no tools at all
  const baselineCount = await anthropic.messages.countTokens({
    model: MODEL,
    messages,
  });

  // --- Step 4: Report ---
  const directTokens = directCount.input_tokens;
  const toolmuxTokens = toolmuxCount.input_tokens;
  const baselineTokens = baselineCount.input_tokens;

  const toolOverheadDirect = directTokens - baselineTokens;
  const toolOverheadToolmux = toolmuxTokens - baselineTokens;
  const savings = directTokens - toolmuxTokens;
  const savingsPercent = ((savings / directTokens) * 100).toFixed(1);
  const reductionFactor = (directTokens / toolmuxTokens).toFixed(1);

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║          TOKEN EFFICIENCY BENCHMARK              ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Model:     ${MODEL.padEnd(37)}║`);
  console.log(`║  Upstream:  ${String(upstreamTools.length + " tools").padEnd(37)}║`);
  console.log(`║  Prompt:    "${PROMPT.slice(0, 33)}..."  ║`);
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Baseline (no tools):   ${String(baselineTokens).padStart(6)} tokens        ║`);
  console.log(`║  Direct (all tools):    ${String(directTokens).padStart(6)} tokens        ║`);
  console.log(`║  Toolmux (4 tools):     ${String(toolmuxTokens).padStart(6)} tokens        ║`);
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(`║  Tool overhead direct:  ${String(toolOverheadDirect).padStart(6)} tokens        ║`);
  console.log(`║  Tool overhead toolmux: ${String(toolOverheadToolmux).padStart(6)} tokens        ║`);
  console.log(`║  Tokens saved:          ${String(savings).padStart(6)} tokens        ║`);
  console.log(`║  Reduction:             ${(savingsPercent + "%").padStart(6)}               ║`);
  console.log(`║  Ratio:                 ${(reductionFactor + "x fewer").padStart(13)}        ║`);
  console.log("╚══════════════════════════════════════════════════╝");

  // Per-tool breakdown
  console.log("\n--- Tool token breakdown ---\n");
  console.log("Direct (each upstream tool injected):");
  for (const t of upstreamTools) {
    const singleToolCount = await anthropic.messages.countTokens({
      model: MODEL,
      messages,
      tools: [t],
    });
    const overhead = singleToolCount.input_tokens - baselineTokens;
    console.log(`  ${t.name.padEnd(35)} +${overhead} tokens`);
  }

  console.log("\nToolmux (meta-tools):");
  for (const t of toolmuxAnthropicTools) {
    const singleToolCount = await anthropic.messages.countTokens({
      model: MODEL,
      messages,
      tools: [t],
    });
    const overhead = singleToolCount.input_tokens - baselineTokens;
    const descLen = (t.description ?? "").length;
    console.log(`  ${t.name.padEnd(35)} +${overhead} tokens (desc: ${descLen} chars)`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
