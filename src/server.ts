import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Pool } from "./pool.js";
import { Executor } from "./executor.js";
import { buildExecuteDescription } from "./codegen.js";

export function createToolmuxServer(pool: Pool): McpServer {
  const server = new McpServer(
    { name: "toolmux", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  const executor = new Executor(pool);

  // --- execute: write and run TypeScript against all tools ---
  server.registerTool(
    "execute",
    {
      title: "Execute Code",
      description: buildExecuteDescription(pool.listTools()),
      inputSchema: {
        code: z.string().describe(
          "TypeScript/JavaScript code to execute. Use tools.qualified_name(args) to call tools. Return a value to get it back."
        ),
      },
    },
    async ({ code }) => {
      const result = await executor.execute(code);

      const parts: string[] = [];

      if (result.logs.length > 0) {
        parts.push(result.logs.join("\n"));
      }

      if (result.error) {
        parts.push(`Error: ${result.error}`);
      } else if (result.value !== undefined) {
        parts.push(
          typeof result.value === "string"
            ? result.value
            : JSON.stringify(result.value, null, 2)
        );
      }

      return {
        content: [{
          type: "text" as const,
          text: parts.join("\n\n") || "(no output)",
        }],
        isError: !!result.error,
      };
    }
  );

  // --- discover ---
  server.registerTool(
    "discover",
    {
      title: "Discover Tools",
      description: [
        "Search all connected servers for tools matching your intent.",
        "Returns ranked results with qualified names you can pass to 'call' or use in 'execute' code.",
        "Tip: Pass an empty query to list all available tools.",
      ].join("\n"),
      inputSchema: {
        query: z.string().describe(
          "Natural language search, e.g. 'send slack message', 'read file'. Empty string lists all tools."
        ),
        limit: z.number().optional().default(10).describe("Max results (default 10)"),
      },
    },
    async ({ query, limit }) => {
      const results = pool.discover(query, limit);

      if (results.length === 0) {
        const servers = pool.listServers();
        return {
          content: [{
            type: "text" as const,
            text: `No tools match "${query}".\n\nConnected servers: ${servers.map((s) => s.name).join(", ") || "(none)"}\n\nTry a broader query or empty string to list all tools.`,
          }],
        };
      }

      const lines = results.map((t) =>
        `- ${t.qualifiedName}  —  ${t.description ? (t.description.length > 100 ? t.description.slice(0, 97) + "..." : t.description) : "(no description)"}  [${t.server}]`
      );

      const totalAvailable = pool.totalTools;
      const footer = results.length < totalAvailable
        ? `\nShowing ${results.length} of ${totalAvailable} total tools.`
        : "";

      return {
        content: [{
          type: "text" as const,
          text: `${lines.join("\n")}${footer}`,
        }],
      };
    }
  );

  // --- describe ---
  server.registerTool(
    "describe",
    {
      title: "Describe Tool",
      description: [
        "Get the full input schema for a tool.",
        "Use this before 'execute' if you need to know exact argument shapes.",
      ].join("\n"),
      inputSchema: {
        tool: z.string().describe("Qualified tool name, e.g. 'filesystem__read_file'"),
      },
    },
    async ({ tool: name }) => {
      const tool = pool.describe(name);

      if (!tool) {
        const suggestions = pool.discover(name, 5);
        const hint = suggestions.length > 0
          ? `\n\nSimilar tools:\n${suggestions.map((s) => `- ${s.qualifiedName}`).join("\n")}`
          : "\n\nUse discover to search for tools.";
        return {
          content: [{ type: "text" as const, text: `Tool "${name}" not found.${hint}` }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            tool: tool.qualifiedName,
            server: tool.server,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          }, null, 2),
        }],
      };
    }
  );

  // --- call (simple single-tool invocation, no sandbox) ---
  server.registerTool(
    "call",
    {
      title: "Call Tool",
      description: [
        "Invoke a single tool directly (no code execution).",
        "For chaining multiple calls, use 'execute' instead.",
      ].join("\n"),
      inputSchema: {
        tool: z.string().describe("Qualified tool name, e.g. 'filesystem__read_file'"),
        arguments: z.record(z.unknown()).optional().default({}).describe("Tool arguments"),
      },
    },
    async ({ tool: name, arguments: args }) => {
      try {
        const result = await pool.call(name, args);

        if (
          result &&
          typeof result === "object" &&
          "content" in result &&
          Array.isArray((result as Record<string, unknown>).content)
        ) {
          return result as { content: Array<{ type: "text"; text: string }> };
        }

        return {
          content: [{
            type: "text" as const,
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    }
  );

  return server;
}
