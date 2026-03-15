#!/usr/bin/env npx tsx
/**
 * Battle test: comprehensive edge-case testing of toolmux with Claude Agent SDK
 *
 * Uses the Anthropic SDK's mcpTools helper + toolRunner for automatic tool loops.
 * Tests real-world scenarios that exercise every edge case.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/battle-test.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/battle-test.ts --test "chained calls"
 */

import Anthropic from "@anthropic-ai/sdk";
import { mcpTools } from "@anthropic-ai/sdk/helpers/beta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "src", "cli.ts");
const MODEL = "claude-sonnet-4-6";

// ============================================================
// Test definitions
// ============================================================

type TestCase = {
  name: string;
  description: string;
  prompt: string;
  validate: (result: string) => { pass: boolean; reason: string };
  setup?: () => void;
  teardown?: () => void;
};

const TEST_FILE = "/private/tmp/toolmux-battle-test.txt";
const TEST_FILE_2 = "/private/tmp/toolmux-battle-test-2.txt";

const tests: TestCase[] = [
  // --- 1. Basic execute: can the agent call a single tool via code? ---
  {
    name: "single tool call",
    description: "Agent calls one tool through execute",
    prompt: "List the allowed directories. Return just the directory paths, nothing else.",
    validate: (r) => ({
      pass: r.includes("/private/tmp") || r.includes("tmp"),
      reason: "Should mention /private/tmp or /tmp",
    }),
  },

  // --- 2. Chained calls: multiple tools in one execute ---
  {
    name: "chained calls",
    description: "Agent chains multiple tool calls in one execute block",
    setup: () => writeFileSync(TEST_FILE, "line1\nline2\nline3\nline4\nline5"),
    teardown: () => { try { unlinkSync(TEST_FILE); } catch {} },
    prompt:
      "Using the execute tool, write code that: " +
      "1) Lists the files in /private/tmp " +
      "2) Finds toolmux-battle-test.txt " +
      "3) Reads it " +
      "4) Returns an object { found: true, lineCount: <number of lines>, content: <file content> }",
    validate: (r) => ({
      pass: (r.includes("line1") || r.includes("5") || r.includes("found")),
      reason: "Should find the file and return its content or line count",
    }),
  },

  // --- 3. Error handling: tool call that fails ---
  {
    name: "error handling",
    description: "Agent handles a tool error gracefully",
    prompt:
      "Try to read the file /private/tmp/this-file-definitely-does-not-exist-xyz.txt and tell me what happened.",
    validate: (r) => {
      const lower = r.toLowerCase();
      return {
        pass:
          lower.includes("not found") ||
          lower.includes("does not exist") ||
          lower.includes("error") ||
          lower.includes("no such") ||
          lower.includes("failed") ||
          lower.includes("couldn't"),
        reason: "Should report the file doesn't exist",
      };
    },
  },

  // --- 4. Search then execute: agent uses search to find tools ---
  {
    name: "search then execute",
    description: "Agent uses search to discover tools, then executes code",
    prompt:
      "I need to create a new directory. First search for relevant tools, then use execute to create a directory called /private/tmp/toolmux-battle-dir.",
    validate: (r) => {
      const lower = r.toLowerCase();
      return {
        pass:
          lower.includes("created") ||
          lower.includes("directory") ||
          lower.includes("success"),
        reason: "Should confirm directory creation",
      };
    },
    teardown: () => {
      try {
        require("node:fs").rmdirSync("/private/tmp/toolmux-battle-dir");
      } catch {}
    },
  },

  // --- 5. Parallel tool calls in code: Promise.all ---
  {
    name: "parallel calls",
    description: "Agent uses Promise.all to call multiple tools in parallel",
    setup: () => {
      writeFileSync(TEST_FILE, "alpha");
      writeFileSync(TEST_FILE_2, "beta");
    },
    teardown: () => {
      try { unlinkSync(TEST_FILE); } catch {}
      try { unlinkSync(TEST_FILE_2); } catch {}
    },
    prompt:
      "Using execute, read BOTH /private/tmp/toolmux-battle-test.txt and /private/tmp/toolmux-battle-test-2.txt " +
      "in parallel using Promise.all, and return an object with both file contents.",
    validate: (r) => ({
      pass: r.includes("alpha") && r.includes("beta"),
      reason: "Should contain both file contents",
    }),
  },

  // --- 6. Write then read: verify round-trip ---
  {
    name: "write then read",
    description: "Agent writes a file then reads it back to verify",
    teardown: () => { try { unlinkSync(TEST_FILE); } catch {} },
    prompt:
      "Using execute, write 'toolmux round trip test 12345' to /private/tmp/toolmux-battle-test.txt, " +
      "then read it back and confirm the content matches. Return { written: true, verified: <boolean>, content: <string> }.",
    validate: (r) => ({
      pass: r.includes("12345") || (r.includes("written") && r.includes("true")),
      reason: "Should write and read back the content",
    }),
  },

  // --- 7. Conditional logic in code ---
  {
    name: "conditional logic",
    description: "Agent writes code with if/else based on tool results",
    setup: () => writeFileSync(TEST_FILE, "important data here"),
    teardown: () => { try { unlinkSync(TEST_FILE); } catch {} },
    prompt:
      "Using execute, read /private/tmp/toolmux-battle-test.txt. " +
      "If it contains the word 'important', return { status: 'critical', action: 'backup needed' }. " +
      "Otherwise return { status: 'normal', action: 'none' }.",
    validate: (r) => ({
      pass: r.includes("critical") && r.includes("backup"),
      reason: "Should detect 'important' and return critical status",
    }),
  },

  // --- 8. Large result handling: listing many files ---
  {
    name: "large result",
    description: "Agent handles a large tool response without choking",
    prompt:
      "Using execute, list the directory /private/tmp and count how many entries there are. Return just the number.",
    validate: (r) => ({
      pass: /\d{2,}/.test(r),
      reason: "Should return a count of 10+ entries",
    }),
  },

  // --- 9. Tool not found: agent calls a nonexistent tool ---
  {
    name: "nonexistent tool",
    description: "Agent handles calling a tool that doesn't exist",
    prompt:
      "Using execute, try to call tools.nonexistent_server__fake_tool({ query: 'test' }) and tell me what error you get.",
    validate: (r) => {
      const lower = r.toLowerCase();
      return {
        pass:
          lower.includes("not found") ||
          lower.includes("error") ||
          lower.includes("undefined") ||
          lower.includes("does not exist"),
        reason: "Should report the tool doesn't exist",
      };
    },
  },

  // --- 10. Multi-step workflow: search → inspect → execute ---
  {
    name: "full workflow",
    description: "Agent uses search with include_schema, then writes targeted code",
    setup: () => writeFileSync(TEST_FILE, "Hello World\nSecond Line\nThird Line"),
    teardown: () => { try { unlinkSync(TEST_FILE); } catch {} },
    prompt:
      "I want to get info about a specific file. First use search with include_schema=true to find a tool that gets file info. " +
      "Then use execute to get the info for /private/tmp/toolmux-battle-test.txt. Tell me the file size.",
    validate: (r) => ({
      pass: /\d+/.test(r) && (r.toLowerCase().includes("size") || r.toLowerCase().includes("byte")),
      reason: "Should return file size info",
    }),
  },
];

// ============================================================
// Runner
// ============================================================

async function connectToolmux(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", CLI_PATH],
    env: { ...process.env } as Record<string, string>,
    stderr: "pipe",
  });

  const client = new Client(
    { name: "battle-test", version: "1.0.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

async function runTest(
  test: TestCase,
  anthropic: Anthropic,
  mcpClient: Client,
  toolsList: Anthropic.Beta.BetaToolUnion[],
  verbose: boolean
): Promise<{ pass: boolean; reason: string; tokens: number; turns: number; error?: string }> {
  test.setup?.();

  try {
    let turns = 0;
    let totalTokens = 0;

    const runner = anthropic.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 4096,
      tools: toolsList,
      messages: [{ role: "user", content: test.prompt }],
    });

    for await (const message of runner) {
      turns++;
      totalTokens += message.usage.input_tokens + message.usage.output_tokens;

      if (verbose) {
        for (const block of message.content) {
          if (block.type === "text") {
            console.log(`\n    [text] ${block.text.slice(0, 200)}`);
          } else if (block.type === "tool_use") {
            const input = JSON.stringify(block.input).slice(0, 150);
            console.log(`\n    [tool_use] ${block.name}(${input})`);
          }
        }
      }
    }

    const finalMessage = await runner;
    // Add final message tokens if not already counted
    if (turns === 0) {
      totalTokens = finalMessage.usage.input_tokens + finalMessage.usage.output_tokens;
      turns = 1;
    }

    // Extract ALL text from the final message for validation
    const resultText = finalMessage.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (verbose) {
      console.log(`\n    [final] ${resultText.slice(0, 300)}`);
    }

    const validation = test.validate(resultText);
    return { ...validation, tokens: totalTokens, turns };
  } catch (err) {
    return {
      pass: false,
      reason: `Exception: ${err instanceof Error ? err.message : String(err)}`,
      tokens: 0,
      turns: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    test.teardown?.();
  }
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY");
    process.exit(1);
  }

  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  const filterArg = process.argv.indexOf("--test");
  const filter = filterArg !== -1 ? process.argv[filterArg + 1]?.toLowerCase() : null;

  const selectedTests = filter
    ? tests.filter((t) => t.name.toLowerCase().includes(filter))
    : tests;

  if (selectedTests.length === 0) {
    console.error(`No tests match "${filter}". Available: ${tests.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n  toolmux battle test — ${selectedTests.length} tests\n`);

  // Connect to toolmux
  const mcpClient = await connectToolmux();
  const { tools: rawTools } = await mcpClient.listTools();
  const toolsList = mcpTools(rawTools, mcpClient);

  console.log(`  Connected — ${rawTools.length} tools: ${rawTools.map((t) => t.name).join(", ")}\n`);

  const anthropic = new Anthropic();
  const results: Array<{ name: string; pass: boolean; reason: string; tokens: number; turns: number }> = [];

  for (const test of selectedTests) {
    process.stdout.write(`  ${test.name.padEnd(25)}`);

    const result = await runTest(test, anthropic, mcpClient, toolsList, verbose);
    results.push({ name: test.name, ...result });

    const icon = result.pass ? "✓" : "✗";
    const color = result.pass ? "\x1b[32m" : "\x1b[31m";
    console.log(
      `${color}${icon}\x1b[0m  ${result.reason.padEnd(45)} ${result.tokens} tok  ${result.turns} turns`
    );
  }

  // Summary
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
  const totalTurns = results.reduce((sum, r) => sum + r.turns, 0);

  console.log(`\n  ${"─".repeat(75)}`);
  const summaryColor = failed === 0 ? "\x1b[32m" : "\x1b[31m";
  console.log(
    `  ${summaryColor}${passed}/${results.length} passed\x1b[0m` +
    `  |  ${totalTokens} total tokens  |  ${totalTurns} total turns`
  );

  if (failed > 0) {
    console.log(`\n  Failed tests:`);
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`    ✗ ${r.name}: ${r.reason}`);
    }
  }

  console.log();
  await mcpClient.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
