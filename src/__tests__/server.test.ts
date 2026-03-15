import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Pool, type IndexedTool } from "../pool.js";
import { createToolmuxServer } from "../server.js";

const TOOLS: IndexedTool[] = [
  {
    server: "github",
    originalName: "list_repos",
    qualifiedName: "github__list_repos",
    description: "List repositories for a user",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    },
  },
  {
    server: "filesystem",
    originalName: "read_file",
    qualifiedName: "filesystem__read_file",
    description: "Read file contents",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

function createTestPool(tools: IndexedTool[]): Pool {
  const pool = new Pool();
  const p = pool as unknown as {
    allTools: IndexedTool[];
    connections: Map<string, unknown>;
  };
  p.allTools = tools;
  const servers = new Set(tools.map((t) => t.server));
  for (const name of servers) {
    p.connections.set(name, {
      config: { name, transport: { type: "stdio", command: "echo" } },
      client: {},
      tools: tools.filter((t) => t.server === name),
    });
  }
  return pool;
}

describe("toolmux MCP server", () => {
  let client: Client;
  let pool: Pool;

  beforeAll(async () => {
    pool = createTestPool(TOOLS);
    const server = createToolmuxServer(pool);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      (() => {
        client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
        return client.connect(clientTransport);
      })(),
    ]);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("exposes exactly 4 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("execute");
    expect(names).toContain("discover");
    expect(names).toContain("describe");
    expect(names).toContain("call");
    expect(names).toHaveLength(4);
  });

  it("discover returns matching tools", async () => {
    const result = await client.callTool({
      name: "discover",
      arguments: { query: "read file" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("filesystem__read_file");
  });

  it("discover with empty query returns all tools", async () => {
    const result = await client.callTool({
      name: "discover",
      arguments: { query: "" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("github__list_repos");
    expect(text).toContain("filesystem__read_file");
  });

  it("discover with no matches gives helpful message", async () => {
    const result = await client.callTool({
      name: "discover",
      arguments: { query: "nonexistent_xyz" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("No tools match");
    expect(text).toContain("Connected servers");
  });

  it("describe returns full schema", async () => {
    const result = await client.callTool({
      name: "describe",
      arguments: { tool: "filesystem__read_file" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.tool).toBe("filesystem__read_file");
    expect(parsed.server).toBe("filesystem");
    expect(parsed.inputSchema.properties).toHaveProperty("path");
  });

  it("describe for unknown tool suggests alternatives", async () => {
    const result = await client.callTool({
      name: "describe",
      arguments: { tool: "github__read_file" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("not found");
    // Should suggest similar tools
    expect(text).toMatch(/Similar tools|discover/);
  });

  it("call errors for unknown tool with suggestions", async () => {
    const result = await client.callTool({
      name: "call",
      arguments: { tool: "github__read_file", arguments: {} },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("not found");
    expect(result.isError).toBe(true);
  });
});
