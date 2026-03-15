#!/usr/bin/env npx tsx
/**
 * Head-to-head comparison: toolmux vs direct MCP tools
 *
 * Runs the same tasks through:
 *   A) Direct — all 14 filesystem tools injected into Claude's context
 *   B) Toolmux — 2 meta-tools (execute + search)
 *
 * Compares: token usage, turns, success rate, and latency.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/compare.ts
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

const TEST_FILE = "/private/tmp/toolmux-compare-test.txt";

// ============================================================
// Tasks — same prompts for both modes
// ============================================================

type Task = {
  name: string;
  prompt: string;
  validate: (r: string) => boolean;
  setup?: () => void;
  teardown?: () => void;
};

const tasks: Task[] = [
  {
    name: "list directory",
    prompt: "List the files in /private/tmp. How many entries are there total?",
    validate: (r) => /\d{2,}/.test(r),
  },
  {
    name: "read file",
    prompt: "Read the file /private/tmp/toolmux-compare-test.txt and tell me what's in it.",
    setup: () => writeFileSync(TEST_FILE, "The quick brown fox jumps over the lazy dog."),
    teardown: () => { try { unlinkSync(TEST_FILE); } catch {} },
    validate: (r) => r.includes("fox") || r.includes("lazy") || r.includes("quick"),
  },
  {
    name: "write + read",
    prompt:
      "Write the text 'benchmark-value-42' to /private/tmp/toolmux-compare-test.txt, " +
      "then read it back and confirm it matches.",
    teardown: () => { try { unlinkSync(TEST_FILE); } catch {} },
    validate: (r) => r.includes("42") || r.toLowerCase().includes("match"),
  },
  {
    name: "search + read",
    prompt:
      "Find any .txt files in /private/tmp, pick the first one, and read its first 3 lines.",
    validate: (r) => r.length > 50,
  },
  {
    name: "file info",
    prompt: "Get detailed information about /private/tmp/toolmux-compare-test.txt — file size, permissions, modification date.",
    setup: () => writeFileSync(TEST_FILE, "test content for file info"),
    teardown: () => { try { unlinkSync(TEST_FILE); } catch {} },
    validate: (r) => /\d+/.test(r) && (r.toLowerCase().includes("size") || r.toLowerCase().includes("byte") || r.toLowerCase().includes("modif")),
  },
];

// ============================================================
// Runners
// ============================================================

type RunResult = {
  success: boolean;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  latencyMs: number;
};

async function connectMcpClient(command: string, args: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "compare", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function runWithToolRunner(
  anthropic: Anthropic,
  toolsList: Anthropic.Beta.BetaToolUnion[],
  prompt: string
): Promise<RunResult> {
  const start = Date.now();
  let totalInput = 0;
  let totalOutput = 0;
  let turns = 0;

  try {
    const runner = anthropic.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 4096,
      tools: toolsList,
      messages: [{ role: "user", content: prompt }],
    });

    for await (const message of runner) {
      turns++;
      totalInput += message.usage.input_tokens;
      totalOutput += message.usage.output_tokens;
    }

    const final = await runner;
    if (turns === 0) {
      totalInput = final.usage.input_tokens;
      totalOutput = final.usage.output_tokens;
      turns = 1;
    }

    const text = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return {
      success: text.length > 10,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      turns,
      latencyMs: Date.now() - start,
    };
  } catch {
    return {
      success: false,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      turns,
      latencyMs: Date.now() - start,
    };
  }
}

// ============================================================
// Main
// ============================================================

function pad(s: string | number, w: number) {
  return String(s).padStart(w);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY");
    process.exit(1);
  }

  const anthropic = new Anthropic();

  // --- Connect both modes ---
  console.log("\n  Connecting...\n");

  // Direct: connect to filesystem MCP server directly
  const directClient = await connectMcpClient("npx", [
    "-y", "@modelcontextprotocol/server-filesystem", "/private/tmp",
  ]);
  const { tools: directRawTools } = await directClient.listTools();
  const directTools = mcpTools(directRawTools, directClient);
  console.log(`  Direct:  ${directRawTools.length} tools (${directRawTools.map((t) => t.name).slice(0, 5).join(", ")}...)`);

  // Toolmux: connect through proxy
  const toolmuxClient = await connectMcpClient("npx", ["tsx", CLI_PATH]);
  const { tools: toolmuxRawTools } = await toolmuxClient.listTools();
  const toolmuxTools = mcpTools(toolmuxRawTools, toolmuxClient);
  console.log(`  Toolmux: ${toolmuxRawTools.length} tools (${toolmuxRawTools.map((t) => t.name).join(", ")})`);

  // --- Count baseline tool tokens ---
  const directToolsDef: Anthropic.Tool[] = directRawTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));
  const toolmuxToolsDef: Anthropic.Tool[] = toolmuxRawTools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: (t.inputSchema ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));

  const baseline = await anthropic.messages.countTokens({
    model: MODEL,
    messages: [{ role: "user", content: "test" }],
  });
  const directTokenCount = await anthropic.messages.countTokens({
    model: MODEL,
    messages: [{ role: "user", content: "test" }],
    tools: directToolsDef,
  });
  const toolmuxTokenCount = await anthropic.messages.countTokens({
    model: MODEL,
    messages: [{ role: "user", content: "test" }],
    tools: toolmuxToolsDef,
  });

  const directOverhead = directTokenCount.input_tokens - baseline.input_tokens;
  const toolmuxOverhead = toolmuxTokenCount.input_tokens - baseline.input_tokens;

  console.log(`\n  Tool definition overhead:`);
  console.log(`    Direct:  ${directOverhead} tokens (${directRawTools.length} tools)`);
  console.log(`    Toolmux: ${toolmuxOverhead} tokens (${toolmuxRawTools.length} tools)`);
  console.log(`    Saved:   ${directOverhead - toolmuxOverhead} tokens per turn (${((1 - toolmuxOverhead / directOverhead) * 100).toFixed(0)}%)`);

  // --- Run tasks ---
  console.log(`\n  Running ${tasks.length} tasks × 2 modes...\n`);

  const W = 78;
  console.log(`  ${"Task".padEnd(18)} ${"Mode".padEnd(10)} ${"Pass".padEnd(6)} ${"Input".padStart(7)} ${"Output".padStart(7)} ${"Total".padStart(7)} ${"Turns".padStart(6)} ${"Time".padStart(7)}`);
  console.log(`  ${"─".repeat(W)}`);

  let directTotalInput = 0, directTotalOutput = 0, directTotalTurns = 0, directTotalTime = 0, directPass = 0;
  let toolmuxTotalInput = 0, toolmuxTotalOutput = 0, toolmuxTotalTurns = 0, toolmuxTotalTime = 0, toolmuxPass = 0;

  for (const task of tasks) {
    // Run direct
    task.setup?.();
    const directResult = await runWithToolRunner(anthropic, directTools, task.prompt);
    task.teardown?.();

    const dPass = directResult.success;
    directTotalInput += directResult.inputTokens;
    directTotalOutput += directResult.outputTokens;
    directTotalTurns += directResult.turns;
    directTotalTime += directResult.latencyMs;
    if (dPass) directPass++;

    console.log(
      `  ${task.name.padEnd(18)} ${"direct".padEnd(10)} ${(dPass ? "✓" : "✗").padEnd(6)}` +
      ` ${pad(directResult.inputTokens, 7)} ${pad(directResult.outputTokens, 7)} ${pad(directResult.inputTokens + directResult.outputTokens, 7)}` +
      ` ${pad(directResult.turns, 6)} ${pad((directResult.latencyMs / 1000).toFixed(1) + "s", 7)}`
    );

    // Run toolmux
    task.setup?.();
    const toolmuxResult = await runWithToolRunner(anthropic, toolmuxTools, task.prompt);
    task.teardown?.();

    const tPass = toolmuxResult.success;
    toolmuxTotalInput += toolmuxResult.inputTokens;
    toolmuxTotalOutput += toolmuxResult.outputTokens;
    toolmuxTotalTurns += toolmuxResult.turns;
    toolmuxTotalTime += toolmuxResult.latencyMs;
    if (tPass) toolmuxPass++;

    console.log(
      `  ${"".padEnd(18)} ${"toolmux".padEnd(10)} ${(tPass ? "✓" : "✗").padEnd(6)}` +
      ` ${pad(toolmuxResult.inputTokens, 7)} ${pad(toolmuxResult.outputTokens, 7)} ${pad(toolmuxResult.inputTokens + toolmuxResult.outputTokens, 7)}` +
      ` ${pad(toolmuxResult.turns, 6)} ${pad((toolmuxResult.latencyMs / 1000).toFixed(1) + "s", 7)}`
    );
  }

  // --- Summary ---
  const directTotal = directTotalInput + directTotalOutput;
  const toolmuxTotal = toolmuxTotalInput + toolmuxTotalOutput;
  const tokenSaved = directTotal - toolmuxTotal;
  const tokenPct = directTotal > 0 ? ((tokenSaved / directTotal) * 100).toFixed(1) : "0";

  console.log(`\n  ${"═".repeat(W)}`);
  console.log(`  TOTALS`);
  console.log(`  ${"─".repeat(W)}`);
  console.log(
    `  ${"".padEnd(18)} ${"direct".padEnd(10)} ${`${directPass}/${tasks.length}`.padEnd(6)}` +
    ` ${pad(directTotalInput, 7)} ${pad(directTotalOutput, 7)} ${pad(directTotal, 7)}` +
    ` ${pad(directTotalTurns, 6)} ${pad((directTotalTime / 1000).toFixed(1) + "s", 7)}`
  );
  console.log(
    `  ${"".padEnd(18)} ${"toolmux".padEnd(10)} ${`${toolmuxPass}/${tasks.length}`.padEnd(6)}` +
    ` ${pad(toolmuxTotalInput, 7)} ${pad(toolmuxTotalOutput, 7)} ${pad(toolmuxTotal, 7)}` +
    ` ${pad(toolmuxTotalTurns, 6)} ${pad((toolmuxTotalTime / 1000).toFixed(1) + "s", 7)}`
  );

  console.log(`\n  ${"═".repeat(W)}`);
  console.log(`  COMPARISON`);
  console.log(`  ${"─".repeat(W)}`);
  console.log(`  Input tokens:    direct ${directTotalInput}  vs  toolmux ${toolmuxTotalInput}  (${directTotalInput > toolmuxTotalInput ? "toolmux saves " + (directTotalInput - toolmuxTotalInput) : "direct saves " + (toolmuxTotalInput - directTotalInput)})`);
  console.log(`  Output tokens:   direct ${directTotalOutput}  vs  toolmux ${toolmuxTotalOutput}`);
  console.log(`  Total tokens:    direct ${directTotal}  vs  toolmux ${toolmuxTotal}  (${tokenSaved > 0 ? tokenPct + "% saved" : Math.abs(Number(tokenPct)) + "% more"})`);
  console.log(`  Turns:           direct ${directTotalTurns}  vs  toolmux ${toolmuxTotalTurns}`);
  console.log(`  Latency:         direct ${(directTotalTime / 1000).toFixed(1)}s  vs  toolmux ${(toolmuxTotalTime / 1000).toFixed(1)}s`);
  console.log(`  Pass rate:       direct ${directPass}/${tasks.length}  vs  toolmux ${toolmuxPass}/${tasks.length}`);

  // Per-turn savings (the real metric)
  const directAvgInputPerTurn = Math.round(directTotalInput / directTotalTurns);
  const toolmuxAvgInputPerTurn = Math.round(toolmuxTotalInput / toolmuxTotalTurns);
  console.log(`\n  Avg input/turn:  direct ${directAvgInputPerTurn}  vs  toolmux ${toolmuxAvgInputPerTurn}  (${((1 - toolmuxAvgInputPerTurn / directAvgInputPerTurn) * 100).toFixed(0)}% less per turn)`);

  console.log();
  await directClient.close();
  await toolmuxClient.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
