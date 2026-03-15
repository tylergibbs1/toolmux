import { describe, it, expect, beforeEach } from "vitest";
import { Executor } from "../executor.js";
import { Pool, type IndexedTool } from "../pool.js";

function createMockPool(): Pool {
  const pool = new Pool();
  const p = pool as unknown as {
    allTools: IndexedTool[];
    connections: Map<string, unknown>;
  };

  const tools: IndexedTool[] = [
    {
      server: "test",
      originalName: "echo",
      qualifiedName: "test__echo",
      description: "Echo back the input",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    {
      server: "test",
      originalName: "add",
      qualifiedName: "test__add",
      description: "Add two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  ];

  p.allTools = tools;

  // Mock connection with a client that handles tool calls
  const mockClient = {
    callTool: async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
      if (name === "echo") {
        return {
          content: [{ type: "text", text: (args as Record<string, unknown>)?.message as string ?? "" }],
        };
      }
      if (name === "add") {
        const a = (args as Record<string, unknown>)?.a as number ?? 0;
        const b = (args as Record<string, unknown>)?.b as number ?? 0;
        return {
          content: [{ type: "text", text: String(a + b) }],
        };
      }
      throw new Error(`Unknown tool: ${name}`);
    },
    close: async () => {},
  };

  p.connections.set("test", {
    config: { name: "test", transport: { type: "stdio", command: "echo" } },
    client: mockClient,
    tools,
  });

  return pool;
}

describe("Executor", () => {
  let executor: Executor;

  beforeEach(() => {
    const pool = createMockPool();
    executor = new Executor(pool, { timeoutMs: 10_000 });
  });

  it("executes simple code and returns result", async () => {
    const result = await executor.execute("return 1 + 2;");
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(3);
  });

  it("executes arrow function", async () => {
    const result = await executor.execute("async () => { return 42; }");
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(42);
  });

  it("captures console.log output", async () => {
    const result = await executor.execute('console.log("hello world"); return "done";');
    expect(result.logs).toContain("[log] hello world");
    expect(result.value).toBe("done");
  });

  it("handles errors gracefully", async () => {
    const result = await executor.execute('throw new Error("test error");');
    expect(result.error).toContain("test error");
  });

  it("can call tools via proxy", async () => {
    const result = await executor.execute(
      'const msg = await tools.test__echo({ message: "hello" }); return msg;'
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toBe("hello");
  });

  it("can chain multiple tool calls", async () => {
    const result = await executor.execute(`
      const sum1 = await tools.test__add({ a: 1, b: 2 });
      const sum2 = await tools.test__add({ a: 3, b: 4 });
      return { sum1: Number(sum1), sum2: Number(sum2), total: Number(sum1) + Number(sum2) };
    `);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({ sum1: 3, sum2: 7, total: 10 });
  });

  it("blocks fetch access", async () => {
    const result = await executor.execute(
      'const r = await fetch("http://example.com"); return r;'
    );
    expect(result.error).toBeDefined();
  });

  it("blocks require/import", async () => {
    const result = await executor.execute(
      'const fs = require("fs"); return fs;'
    );
    expect(result.error).toBeDefined();
  });

  it("blocks process access", async () => {
    const result = await executor.execute("return process.env;");
    expect(result.error).toBeDefined();
  });
});
