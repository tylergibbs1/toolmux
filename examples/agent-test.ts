#!/usr/bin/env npx tsx
/**
 * Real-world agent test: Claude + toolmux + filesystem MCP server
 *
 * This script:
 * 1. Starts toolmux as a child process (which connects to the filesystem MCP server)
 * 2. Connects to toolmux via MCP client
 * 3. Gets toolmux's meta-tools (execute, discover, describe, call)
 * 4. Sends a task to Claude and runs the tool loop
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/agent-test.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "src", "cli.ts");

// --- Config ---
const MODEL = "claude-sonnet-4-6";
const MAX_TURNS = 10;
const TASK =
  "List the files in /tmp and tell me how many there are. If there are any .txt files, read the first one you find and tell me what's in it.";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY to run this test");
    process.exit(1);
  }

  console.log("--- toolmux agent test ---\n");

  // 1. Start toolmux as an MCP server via stdio
  console.log("Starting toolmux...");
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", CLI_PATH],
    env: { ...process.env } as Record<string, string>,
  });

  const mcpClient = new Client(
    { name: "agent-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await mcpClient.connect(transport);

  // 2. Get toolmux's tools
  const { tools: mcpTools } = await mcpClient.listTools();
  console.log(
    `Connected — toolmux exposes ${mcpTools.length} tools: ${mcpTools.map((t) => t.name).join(", ")}\n`
  );

  // 3. Convert MCP tools to Anthropic format
  const anthropicTools: Anthropic.Tool[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));

  // 4. Run the agent loop
  const anthropic = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: TASK },
  ];

  console.log(`User: ${TASK}\n`);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: anthropicTools,
      messages,
    });

    // Process response blocks
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        console.log(`Claude: ${block.text}`);
      } else if (block.type === "tool_use") {
        console.log(`\n[tool_use] ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);

        // Call toolmux via MCP
        const result = await mcpClient.callTool({
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });

        const resultText = (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n");

        // Truncate for display
        const preview = resultText.length > 500
          ? resultText.slice(0, 497) + "..."
          : resultText;
        console.log(`[result] ${preview}\n`);

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: resultText,
        });
      }
    }

    // Add assistant message to history
    messages.push({ role: "assistant", content: response.content });

    // If there were tool calls, add results and continue
    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }

    // Stop if no more tool calls
    if (response.stop_reason === "end_turn") {
      console.log("\n--- done ---");
      break;
    }
  }

  await mcpClient.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
