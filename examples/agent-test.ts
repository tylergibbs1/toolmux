#!/usr/bin/env npx tsx
/**
 * Real-world agent test: Claude + toolmux + filesystem MCP server
 *
 * Connects to toolmux, gets its 2 meta-tools (execute, search),
 * and runs Claude against a real task. Tracks token usage.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/agent-test.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/agent-test.ts --execute
 *
 * Modes:
 *   (default)   Let Claude choose how to use the tools
 *   --execute   Force Claude to use the execute tool for code mode
 */

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "src", "cli.ts");

const MODEL = "claude-sonnet-4-6";
const MAX_TURNS = 10;

const forceExecute = process.argv.includes("--execute");

const DEFAULT_TASK =
  "List the files in /private/tmp and tell me how many there are. " +
  "If there are any .txt files, read the first one you find and tell me what's in it.";

const EXECUTE_TASK =
  "Use the execute tool to write a single script that:\n" +
  "1. Lists all files in /private/tmp\n" +
  "2. Filters to only .txt files\n" +
  "3. Reads the first 5 lines of each .txt file (up to 3 files max)\n" +
  "4. Returns a summary object with { txtFileCount, previews: [{ name, firstLines }] }\n\n" +
  "Do this in one execute call, not multiple separate tool calls.";

const TASK = forceExecute ? EXECUTE_TASK : DEFAULT_TASK;

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY to run this test");
    process.exit(1);
  }

  const mode = forceExecute ? "execute (code mode)" : "auto";
  console.log(`--- toolmux agent test [${mode}] ---\n`);

  // 1. Connect to toolmux
  console.log("Starting toolmux...");
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", CLI_PATH],
    env: { ...process.env } as Record<string, string>,
    stderr: "pipe",
  });

  const mcpClient = new Client(
    { name: "agent-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await mcpClient.connect(transport);

  // 2. Get toolmux's tools
  const { tools: mcpTools } = await mcpClient.listTools();
  console.log(
    `Connected — ${mcpTools.length} tools: ${mcpTools.map((t) => t.name).join(", ")}\n`
  );

  // 3. Convert to Anthropic format
  const anthropicTools: Anthropic.Tool[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));

  // 4. Run the agent loop
  const anthropic = new Anthropic();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: TASK }];

  console.log(`User: ${TASK}\n`);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turns = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools: anthropicTools,
      messages,
    });

    turns++;
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        console.log(`Claude: ${block.text}`);
      } else if (block.type === "tool_use") {
        // Display tool call
        if (block.name === "execute") {
          const code = (block.input as { code: string }).code;
          console.log(`\n[execute]`);
          console.log(`--- code ---`);
          console.log(code);
          console.log(`--- end code ---`);
        } else {
          console.log(`\n[${block.name}] ${JSON.stringify(block.input).slice(0, 200)}`);
        }

        // Forward to toolmux
        const result = await mcpClient.callTool({
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });

        const resultText = (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n");

        const preview =
          resultText.length > 600 ? resultText.slice(0, 597) + "..." : resultText;
        console.log(`[result] ${preview}\n`);

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: resultText,
        });
      }
    }

    messages.push({ role: "assistant", content: response.content });

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }

    if (response.stop_reason === "end_turn") {
      break;
    }
  }

  // 5. Summary
  console.log("\n--- stats ---");
  console.log(`  Turns:          ${turns}`);
  console.log(`  Input tokens:   ${totalInputTokens}`);
  console.log(`  Output tokens:  ${totalOutputTokens}`);
  console.log(`  Total tokens:   ${totalInputTokens + totalOutputTokens}`);
  console.log("--- done ---");

  await mcpClient.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
