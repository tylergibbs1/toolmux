import { describe, it, expect, beforeEach } from "vitest";
import { Pool, type IndexedTool } from "../pool.js";

/** Create a pool with pre-loaded tools for testing (bypasses MCP connection) */
function createTestPool(tools: IndexedTool[]): Pool {
  const pool = new Pool();
  // Access private fields for testing
  const p = pool as unknown as {
    allTools: IndexedTool[];
    connections: Map<string, unknown>;
  };
  p.allTools = tools;

  // Set up fake connections so serverCount works
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

const FIXTURES: IndexedTool[] = [
  {
    server: "github",
    originalName: "create_issue",
    qualifiedName: "github__create_issue",
    description: "Create a new issue in a GitHub repository",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" } },
      required: ["title"],
    },
  },
  {
    server: "github",
    originalName: "list_issues",
    qualifiedName: "github__list_issues",
    description: "List issues in a GitHub repository",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, repo: { type: "string" } },
    },
  },
  {
    server: "github",
    originalName: "list_repos",
    qualifiedName: "github__list_repos",
    description: "List repositories for a user or organization",
    inputSchema: { type: "object", properties: {} },
  },
  {
    server: "slack",
    originalName: "post_message",
    qualifiedName: "slack__post_message",
    description: "Post a message to a Slack channel",
    inputSchema: {
      type: "object",
      properties: { channel: { type: "string" }, text: { type: "string" } },
      required: ["channel", "text"],
    },
  },
  {
    server: "slack",
    originalName: "list_channels",
    qualifiedName: "slack__list_channels",
    description: "List all Slack channels",
    inputSchema: { type: "object", properties: {} },
  },
  {
    server: "filesystem",
    originalName: "read_file",
    qualifiedName: "filesystem__read_file",
    description: "Read the contents of a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    server: "filesystem",
    originalName: "write_file",
    qualifiedName: "filesystem__write_file",
    description: "Write content to a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
];

describe("Pool", () => {
  let pool: Pool;

  beforeEach(() => {
    pool = createTestPool(FIXTURES);
  });

  describe("discover", () => {
    it("finds tools by exact name", () => {
      const results = pool.discover("read_file");
      expect(results[0].qualifiedName).toBe("filesystem__read_file");
    });

    it("finds tools by qualified name", () => {
      const results = pool.discover("github__create_issue");
      expect(results[0].qualifiedName).toBe("github__create_issue");
    });

    it("finds tools by description keywords", () => {
      const results = pool.discover("slack message");
      expect(results[0].qualifiedName).toBe("slack__post_message");
    });

    it("ranks exact name matches above description matches", () => {
      const results = pool.discover("list_issues");
      expect(results[0].originalName).toBe("list_issues");
    });

    it("returns multiple matches sorted by relevance", () => {
      const results = pool.discover("list");
      expect(results.length).toBeGreaterThanOrEqual(3);
      // All "list" tools should appear
      const names = results.map((t) => t.originalName);
      expect(names).toContain("list_issues");
      expect(names).toContain("list_repos");
      expect(names).toContain("list_channels");
    });

    it("respects the limit parameter", () => {
      const results = pool.discover("list", 2);
      expect(results.length).toBe(2);
    });

    it("returns empty array for no matches", () => {
      const results = pool.discover("nonexistent_xyz_tool");
      expect(results).toEqual([]);
    });

    it("returns all tools with empty query", () => {
      const results = pool.discover("", 100);
      expect(results.length).toBe(FIXTURES.length);
    });

    it("handles multi-word queries", () => {
      const results = pool.discover("create issue github");
      expect(results[0].qualifiedName).toBe("github__create_issue");
    });
  });

  describe("describe", () => {
    it("returns tool by qualified name", () => {
      const tool = pool.describe("github__create_issue");
      expect(tool).not.toBeNull();
      expect(tool!.originalName).toBe("create_issue");
      expect(tool!.server).toBe("github");
      expect(tool!.inputSchema).toHaveProperty("properties");
    });

    it("returns null for unknown tool", () => {
      const tool = pool.describe("unknown__tool");
      expect(tool).toBeNull();
    });
  });

  describe("listServers", () => {
    it("returns all connected servers with tool counts", () => {
      const servers = pool.listServers();
      expect(servers).toHaveLength(3);
      const names = servers.map((s) => s.name);
      expect(names).toContain("github");
      expect(names).toContain("slack");
      expect(names).toContain("filesystem");

      const github = servers.find((s) => s.name === "github")!;
      expect(github.toolCount).toBe(3);
    });
  });

  describe("listTools", () => {
    it("lists all tools", () => {
      expect(pool.listTools()).toHaveLength(FIXTURES.length);
    });

    it("filters by server", () => {
      const slackTools = pool.listTools("slack");
      expect(slackTools).toHaveLength(2);
      expect(slackTools.every((t) => t.server === "slack")).toBe(true);
    });
  });

  describe("totalTools and serverCount", () => {
    it("reports correct counts", () => {
      expect(pool.totalTools).toBe(7);
      expect(pool.serverCount).toBe(3);
    });
  });
});
