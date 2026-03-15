import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

export type ServerTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> };

export type UpstreamConfig = {
  /** Human-readable name, used as namespace prefix for tools */
  name: string;
  transport: ServerTransport;
  /** If true, skip this server */
  disabled?: boolean;
};

export type ToolmuxConfig = {
  servers: UpstreamConfig[];
};

const CONFIG_FILENAMES = ["toolmux.json", ".toolmux.json"];

function searchPaths(): string[] {
  const paths: string[] = [];
  // 1. Current working directory
  for (const f of CONFIG_FILENAMES) paths.push(resolve(process.cwd(), f));
  // 2. XDG / ~/.config
  const xdg = process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config");
  paths.push(resolve(xdg, "toolmux", "config.json"));
  // 3. Home directory
  for (const f of CONFIG_FILENAMES) paths.push(resolve(homedir(), f));
  return paths;
}

/** Resolve env var references like $VAR or ${VAR} in string values */
function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/gi, (_, braced, bare) => {
    const name = braced ?? bare;
    return process.env[name] ?? "";
  });
}

/** Walk an object and resolve env vars in all string values */
function resolveEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveEnvVarsDeep);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveEnvVarsDeep(v);
    }
    return out;
  }
  return obj;
}

export async function loadConfig(explicitPath?: string): Promise<ToolmuxConfig> {
  let configPath: string | undefined;
  let raw: string;

  if (explicitPath) {
    configPath = resolve(explicitPath);
    try {
      raw = await readFile(configPath, "utf-8");
    } catch {
      throw new Error(
        `Config file not found: ${configPath}\n` +
        `Create one — see toolmux.example.json for the format.`
      );
    }
  } else {
    // Auto-discover config
    for (const candidate of searchPaths()) {
      if (existsSync(candidate)) {
        configPath = candidate;
        break;
      }
    }
    if (!configPath) {
      throw new Error(
        `No toolmux config found. Searched:\n` +
        searchPaths().map((p) => `  - ${p}`).join("\n") +
        `\n\nCreate a toolmux.json — see: https://github.com/tylergibbs/toolmux`
      );
    }
    raw = await readFile(configPath, "utf-8");
  }

  console.error(`[toolmux] Config: ${configPath}`);

  let parsed: ToolmuxConfig;
  try {
    parsed = resolveEnvVarsDeep(JSON.parse(raw)) as ToolmuxConfig;
  } catch (e) {
    throw new Error(`Invalid JSON in ${configPath}: ${e instanceof Error ? e.message : e}`);
  }

  if (!parsed.servers || !Array.isArray(parsed.servers)) {
    throw new Error(`Config must have a "servers" array`);
  }

  for (const s of parsed.servers) {
    if (!s.name) throw new Error(`Each server must have a "name"`);
    if (!s.transport) throw new Error(`Server "${s.name}" must have a "transport"`);
    if (!("type" in s.transport)) throw new Error(`Server "${s.name}" transport must have a "type" (stdio, http, or sse)`);
  }

  return parsed;
}
