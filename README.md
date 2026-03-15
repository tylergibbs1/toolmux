# toolmux

Smart MCP proxy. Connect N MCP servers, expose one endpoint with 3 meta-tools.

Instead of dumping 50+ tool definitions into your agent's context window, toolmux gives the agent 3 tools — `discover`, `describe`, `call` — and lets it find and invoke what it needs on demand.

## The problem

When you connect multiple MCP servers to an agent, every tool from every server gets injected into the context window. 5 servers with 20 tools each = 100 tool definitions the model has to parse on every turn. This wastes tokens, degrades tool selection accuracy, and hits context limits fast.

## How toolmux solves it

```
Agent ←→ toolmux (3 tools) ←→ GitHub MCP (28 tools)
                             ←→ Slack MCP (15 tools)
                             ←→ Filesystem MCP (14 tools)
                             ←→ Linear MCP (22 tools)
```

The agent sees 3 tools instead of 79. When it needs something, it searches by intent:

```
discover("create github issue")  →  github__create_issue
describe("github__create_issue") →  { inputSchema: { title, body, repo, ... } }
call("github__create_issue", { title: "Bug", body: "...", repo: "foo/bar" })
```

## Quick start

```bash
# Clone and install
git clone https://github.com/tylergibbs/toolmux
cd toolmux
npm install

# Create config
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

# Test it
npx tsx src/cli.ts --help
```

## Add to your agent

### Claude Code

```bash
claude mcp add toolmux -- npx tsx /path/to/toolmux/src/cli.ts
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "toolmux": {
      "command": "npx",
      "args": ["tsx", "/path/to/toolmux/src/cli.ts"]
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
      "args": ["tsx", "/path/to/toolmux/src/cli.ts"]
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

All string values in config support `$VAR` and `${VAR}` expansion. This lets you keep secrets out of the config file:

```json
{
  "env": { "API_KEY": "$MY_API_KEY" }
}
```

## Tools exposed to the agent

### `discover`

Search all connected servers for tools matching a natural language query.

```
discover({ query: "send a message" })
discover({ query: "github issues", limit: 5 })
discover({ query: "" })  // list all tools
```

### `describe`

Get the full input schema for a specific tool.

```
describe({ tool: "slack__post_message" })
```

### `call`

Invoke a tool, routing to the correct upstream server.

```
call({
  tool: "github__create_issue",
  arguments: { owner: "me", repo: "myrepo", title: "Bug report" }
})
```

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
│  Cursor) │  3 meta-tools  │  Pool +  │◄──────────────────────►│ MCP Srv 3 │
│          │                │  Index   │    N upstream servers   │    ...    │
└─────────┘                 └──────────┘                        └───────────┘
```

- **No daemon** — single process, starts and stops with the agent
- **No database** — tool index lives in memory
- **No auth layer** — credentials are passed through to upstream servers via config

## License

MIT
