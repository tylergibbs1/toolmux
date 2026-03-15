# toolmux

Smart MCP proxy with code execution. Connect N MCP servers, expose one endpoint with 2 tools.

Instead of dumping 50+ tool definitions into your agent's context window, toolmux gives the agent 2 tools — `execute` and `search` — and lets it write code against a typed tool surface.

## The problem

When you connect multiple MCP servers to an agent, every tool gets injected into the context window. 5 servers with 20 tools each = 100 tool definitions the model has to parse on every turn. This wastes tokens, degrades tool selection accuracy, and hits context limits fast.

Even worse: when an agent needs to chain 5 API calls, each call round-trips through the LLM. The model reads the result, decides the next call, outputs it, reads that result... burning tokens and time on what should be a simple script.

## How toolmux solves it

```
Agent ←→ toolmux (2 tools) ←→ GitHub MCP (28 tools)
                              ←→ Slack MCP (15 tools)
                              ←→ Filesystem MCP (14 tools)
                              ←→ Linear MCP (22 tools)
```

The agent sees **2 tools instead of 79**. The token cost is O(1) — it stays the same regardless of how many upstream tools exist:

```
Scenario                      Direct      Toolmux    Reduction
1 server × 14 tools             2229        1474       34%
3 servers × 45 tools            8859        1474       83%
5 servers × 100 tools          19125        1474       92%
10 servers × 200 tools         37925        1474       96%
```

### How the agent uses it

The agent writes JavaScript that calls `tools.*` directly. Multiple calls execute in one shot — no round trips through the LLM between each call:

```js
// Agent writes this, toolmux executes it in a V8 sandbox
const repos = await tools.github__list_repos({ owner: "octocat" });
const issues = await Promise.all(
  repos.slice(0, 3).map(r =>
    tools.github__list_issues({ owner: r.owner, repo: r.name })
  )
);
return { repoCount: repos.length, issues };
```

The `execute` tool's description includes auto-generated TypeScript type declarations for every connected tool, so the LLM knows exactly what arguments to pass.

When the agent doesn't know what tools are available, it uses `search`:

```
search({ query: "create github issue", include_schema: true })
```

## Quick start

### Install from npm

```bash
npm install -g toolmux
```

Or use directly with `npx`:

```bash
npx toolmux --help
```

### Create a config

```bash
cat > toolmux.json << 'EOF'
{
  "servers": [
    {
      "name": "filesystem",
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/projects"]
      }
    }
  ]
}
EOF
```

### From source

```bash
git clone https://github.com/tylergibbs1/toolmux
cd toolmux
bun install
bun run src/cli.ts --help
```

## Add to your agent

### Claude Code

```bash
claude mcp add toolmux -- npx toolmux
```

If your `toolmux.json` is in a specific directory:

```bash
claude mcp add toolmux -- npx toolmux --config /path/to/toolmux.json
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "toolmux": {
      "command": "npx",
      "args": ["toolmux"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "toolmux": {
      "command": "npx",
      "args": ["toolmux"]
    }
  }
}
```

## Config

toolmux looks for config in this order:

1. `--config <path>` or positional arg
2. `./toolmux.json`
3. `./.toolmux.json`
4. `~/.config/toolmux/config.json`
5. `~/toolmux.json`

### Config format

```json
{
  "servers": [
    {
      "name": "github",
      "transport": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": {
          "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN"
        }
      }
    },
    {
      "name": "slack",
      "transport": {
        "type": "http",
        "url": "https://mcp.slack.com/sse",
        "headers": {
          "Authorization": "Bearer $SLACK_TOKEN"
        }
      }
    },
    {
      "name": "old-server",
      "transport": {
        "type": "sse",
        "url": "https://legacy.example.com/mcp/sse"
      },
      "disabled": true
    }
  ]
}
```

### Transport types

| Type | Use case |
|------|----------|
| `stdio` | Local MCP servers (most common). Spawns a process. |
| `http` | Remote MCP servers using Streamable HTTP transport. |
| `sse` | Legacy MCP servers using SSE transport. |

### Environment variables

All string values in config support `$VAR` and `${VAR}` expansion:

```json
{
  "env": { "API_KEY": "$MY_API_KEY" }
}
```

## Tools exposed to the agent

### `execute`

Write and run JavaScript in a sandboxed V8 context. Call any connected tool via `await tools.qualified_name(args)`. Auto-generated TypeScript type declarations are included in the tool description so the LLM knows exact signatures.

```js
const weather = await tools.weather__get_current({ location: "Austin, TX" });
if (weather.temperature > 90) {
  await tools.slack__post_message({ channel: "#team", text: "It's hot in Austin!" });
}
return weather;
```

The sandbox:
- Runs in a forked Node.js process with `vm.createContext` (V8 context isolation)
- No access to `fetch`, `require`, `process`, `fs`, or the network
- Only `tools.*` calls can reach external systems
- 30 second timeout
- `console.log()` output is captured and returned

### `search`

Find available tools by intent. Use before `execute` when you don't know the tool name or need its input schema.

```
search({ query: "send a message" })                    // concise list
search({ query: "github issues", include_schema: true }) // with full JSON schemas
search({ query: "" })                                   // list all tools
```

The `include_schema` flag lets the agent get tool names + full input schemas in one round trip (replaces the old discover → describe two-step).

## How tool names work

Each tool gets a qualified name: `{server}__{original_name}`.

- Server name is lowercased and sanitized (non-alphanumeric → `_`)
- Original tool name is preserved as-is
- Example: server `"GitHub"` + tool `"create_issue"` → `github__create_issue`

## Architecture

```
┌─────────┐     stdio      ┌──────────┐     stdio/http/sse     ┌───────────┐
│  Agent   │◄──────────────►│ toolmux  │◄──────────────────────►│ MCP Srv 1 │
│ (Claude, │                │          │◄──────────────────────►│ MCP Srv 2 │
│  Cursor) │  2 meta-tools  │  Pool +  │◄──────────────────────►│ MCP Srv 3 │
│          │                │  Index   │    N upstream servers   │    ...    │
└─────────┘                 │  V8 VM   │                        └───────────┘
                            └──────────┘
```

When the agent uses `execute`:

```
1. Agent writes code using tools.* calls
2. toolmux spawns a forked process with a V8 sandbox
3. Code runs — tools.* calls are proxied via IPC to the parent
4. Parent dispatches each call to the correct upstream MCP server
5. Results flow back through IPC → sandbox continues execution
6. Final result + console logs returned to agent
```

- **No daemon** — single process, starts and stops with the agent
- **No database** — tool index lives in memory
- **No auth layer** — credentials pass through to upstream servers via config
- **V8 isolation** — sandboxed code can't access filesystem, network, or process

## Examples

```bash
# Run the agent test (Claude + toolmux + filesystem MCP)
ANTHROPIC_API_KEY=sk-... npx tsx examples/agent-test.ts

# Force code execution mode
ANTHROPIC_API_KEY=sk-... npx tsx examples/agent-test.ts --execute

# Token efficiency benchmark
ANTHROPIC_API_KEY=sk-... npx tsx examples/token-benchmark.ts
```

## Inspired by

- [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/) — the insight that LLMs are better at writing code than making tool calls
- [Executor](https://github.com/RhysSullivan/executor) — local-first execution environment for AI agents
- [Rhys Sullivan's Execution Layer post](https://x.com/RhysSullivan) — the case for a typed execution layer

## License

MIT
