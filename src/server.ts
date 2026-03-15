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

  // --- execute: the primary tool — write code to call tools ---
  server.registerTool(
    "execute",
    {
      title: "Execute Code",
      description: buildExecuteDescription(pool.listTools()),
      inputSchema: {
        code: z.string().describe(
          "JS code. Use `await tools.name(args)` to call tools. `return` a value to get results."
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

  // --- search: find tools by intent, optionally with full schema ---
  server.registerTool(
    "search",
    {
      title: "Search Tools",
      description:
        "Find available tools by intent. Use before execute when you don't know the tool name or need to see its input schema. " +
        "Set include_schema=true to get the full JSON Schema for matching tools (avoids a second round trip).",
      inputSchema: {
        query: z.string().describe(
          "What you want to do, e.g. 'read file', 'list repos'. Empty string returns all tools."
        ),
        include_schema: z.boolean().optional().default(false).describe(
          "If true, include full inputSchema for each result. Use when you need argument details."
        ),
        limit: z.number().optional().default(10).describe("Max results"),
      },
    },
    async ({ query, include_schema, limit }) => {
      const results = pool.discover(query, limit);

      if (results.length === 0) {
        const servers = pool.listServers();
        return {
          content: [{
            type: "text" as const,
            text: `No tools match "${query}". Servers: ${servers.map((s) => s.name).join(", ") || "(none)"}. Try a broader query.`,
          }],
        };
      }

      if (include_schema) {
        // Return structured data with schemas — one round trip replaces discover + describe
        const detailed = results.map((t) => ({
          tool: t.qualifiedName,
          server: t.server,
          description: t.description.length > 120
            ? t.description.slice(0, 117) + "..."
            : t.description,
          inputSchema: t.inputSchema,
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(detailed, null, 2),
          }],
        };
      }

      // Concise list — tool name + short description
      const lines = results.map((t) => {
        const desc = t.description
          ? (t.description.length > 80 ? t.description.slice(0, 77) + "..." : t.description)
          : "";
        return `${t.qualifiedName}: ${desc}`;
      });

      const total = pool.totalTools;
      const footer = results.length < total
        ? `\n(${results.length}/${total} shown)`
        : "";

      return {
        content: [{
          type: "text" as const,
          text: lines.join("\n") + footer,
        }],
      };
    }
  );

  return server;
}
