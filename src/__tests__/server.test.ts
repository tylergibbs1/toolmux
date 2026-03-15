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

  it("exposes exactly 2 tools: execute and search", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("execute");
    expect(names).toContain("search");
    expect(names).toHaveLength(2);
  });

  it("search returns matching tools", async () => {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "read file" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("filesystem__read_file");
  });

  it("search with empty query returns all tools", async () => {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("github__list_repos");
    expect(text).toContain("filesystem__read_file");
  });

  it("search with no matches gives helpful message", async () => {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "nonexistent_xyz" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("No tools match");
  });

  it("search with include_schema returns full schemas", async () => {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "read file", include_schema: true },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed[0].tool).toBe("filesystem__read_file");
    expect(parsed[0].inputSchema.properties).toHaveProperty("path");
  });

  it("search concise mode is compact", async () => {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    // Concise mode: "name: description" per line, no JSON
    expect(text).not.toContain("{");
    expect(text).toContain(":");
  });
});
