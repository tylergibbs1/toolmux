#!/usr/bin/env npx tsx
/**
 * Test the execute (code mode) tool specifically.
 * Forces Claude to write code that chains multiple tool calls.
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
const TASK = `Use the 'execute' tool to write a script that:
1. Lists all files in /private/tmp
2. Filters to only .txt files
3. Reads the first 5 lines of each .txt file (up to 3 files max)
4. Returns a summary object with { txtFileCount, previews: [{ name, firstLines }] }

You MUST use the execute tool to do this in a single code execution, not individual tool calls.`;

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY");
    process.exit(1);
  }

  console.log("--- toolmux execute (code mode) test ---\n");

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

  const { tools: mcpTools } = await mcpClient.listTools();
  console.log(
    `Connected — ${mcpTools.length} tools: ${mcpTools.map((t) => t.name).join(", ")}\n`
  );

  const anthropicTools: Anthropic.Tool[] = mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));

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

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        console.log(`Claude: ${block.text}`);
      } else if (block.type === "tool_use") {
        const inputStr = JSON.stringify(block.input, null, 2);
        console.log(`\n[tool_use] ${block.name}`);
        if (block.name === "execute") {
          console.log(`--- code ---`);
          console.log((block.input as { code: string }).code);
          console.log(`--- end code ---`);
        } else {
          console.log(`  input: ${inputStr.slice(0, 300)}`);
        }

        const result = await mcpClient.callTool({
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });

        const resultText = (result.content as Array<{ type: string; text?: string }>)
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n");

        const preview = resultText.length > 800
          ? resultText.slice(0, 797) + "..."
          : resultText;
        console.log(`\n[result] ${preview}\n`);

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
