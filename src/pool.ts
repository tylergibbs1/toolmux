import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { UpstreamConfig, ServerTransport } from "./config.js";

export type IndexedTool = {
  server: string;
  originalName: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export type UpstreamConnection = {
  config: UpstreamConfig;
  client: Client;
  tools: IndexedTool[];
};

function createTransport(transport: ServerTransport) {
  switch (transport.type) {
    case "stdio":
      return new StdioClientTransport({
        command: transport.command,
        args: transport.args,
        env: transport.env
          ? { ...process.env, ...transport.env } as Record<string, string>
          : undefined,
      });
    case "http":
      return new StreamableHTTPClientTransport(new URL(transport.url), {
        requestInit: transport.headers
          ? { headers: transport.headers }
          : undefined,
      });
    case "sse":
      return new SSEClientTransport(new URL(transport.url), {
        requestInit: transport.headers
          ? { headers: transport.headers }
          : undefined,
      });
  }
}

function toNamespace(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

export class Pool {
  private connections: Map<string, UpstreamConnection> = new Map();
  private allTools: IndexedTool[] = [];

  get totalTools(): number {
    return this.allTools.length;
  }

  get serverCount(): number {
    return this.connections.size;
  }

  async connect(configs: UpstreamConfig[]): Promise<void> {
    const active = configs.filter((c) => !c.disabled);

    const results = await Promise.allSettled(
      active.map((config) => this.connectOne(config))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        console.error(
          `[toolmux] Failed to connect to "${active[i].name}": ${result.reason}`
        );
      }
    }

    this.rebuildIndex();
  }

  private async connectOne(config: UpstreamConfig): Promise<void> {
    const client = new Client(
      { name: "toolmux", version: "0.1.0" },
      { capabilities: {} }
    );

    const transport = createTransport(config.transport);
    await client.connect(transport);

    const namespace = toNamespace(config.name);
    const tools: IndexedTool[] = [];

    let cursor: string | undefined;
    do {
      const response = await client.listTools({ cursor });
      for (const tool of response.tools) {
        tools.push({
          server: config.name,
          originalName: tool.name,
          qualifiedName: `${namespace}__${tool.name}`,
          description: tool.description ?? "",
          inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
          outputSchema: undefined,
        });
      }
      cursor = response.nextCursor;
    } while (cursor);

    this.connections.set(config.name, { config, client, tools });
    console.error(
      `[toolmux] Connected "${config.name}" — ${tools.length} tools`
    );
  }

  private rebuildIndex() {
    this.allTools = [];
    for (const conn of this.connections.values()) {
      this.allTools.push(...conn.tools);
    }
    console.error(
      `[toolmux] Index: ${this.allTools.length} tools from ${this.connections.size} servers`
    );
  }

  /** Search tools by query. Scores by name match, word overlap, and description match. */
  discover(query: string, limit: number = 20): IndexedTool[] {
    if (!query.trim()) {
      return this.allTools.slice(0, limit);
    }

    const q = query.toLowerCase();
    const words = q.split(/[\s_\-]+/).filter(Boolean);

    const scored = this.allTools
      .map((tool) => {
        const name = tool.originalName.toLowerCase();
        const qname = tool.qualifiedName.toLowerCase();
        const desc = tool.description.toLowerCase();
        const all = `${qname} ${desc}`;

        let score = 0;

        // Exact name match
        if (name === q || qname === q) score += 100;
        // Name contains full query
        else if (name.includes(q)) score += 70;
        else if (qname.includes(q)) score += 60;

        // Word-level matching
        for (const w of words) {
          if (name.includes(w)) score += 25;
          else if (desc.includes(w)) score += 10;
        }

        // Bonus: all words present
        if (words.length > 1 && words.every((w) => all.includes(w))) {
          score += 30;
        }

        return { tool, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => s.tool);
  }

  describe(qualifiedName: string): IndexedTool | null {
    return this.allTools.find((t) => t.qualifiedName === qualifiedName) ?? null;
  }

  async call(
    qualifiedName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const tool = this.allTools.find((t) => t.qualifiedName === qualifiedName);
    if (!tool) {
      const suggestions = this.discover(qualifiedName, 3);
      const hint = suggestions.length > 0
        ? ` Did you mean: ${suggestions.map((s) => s.qualifiedName).join(", ")}?`
        : " Use discover to find available tools.";
      throw new Error(`Tool not found: "${qualifiedName}".${hint}`);
    }

    const conn = this.connections.get(tool.server);
    if (!conn) {
      throw new Error(`Server "${tool.server}" is not connected.`);
    }

    return await conn.client.callTool({
      name: tool.originalName,
      arguments: args,
    });
  }

  listServers(): { name: string; toolCount: number }[] {
    return Array.from(this.connections.entries()).map(([name, conn]) => ({
      name,
      toolCount: conn.tools.length,
    }));
  }

  listTools(server?: string): IndexedTool[] {
    if (server) {
      return this.allTools.filter((t) => t.server === server);
    }
    return this.allTools;
  }

  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      try {
        await conn.client.close();
      } catch {
        // ignore close errors
      }
    }
    this.connections.clear();
    this.allTools = [];
  }
}
