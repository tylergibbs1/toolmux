import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  const tmpDir = join(tmpdir(), "toolmux-test-" + Date.now());
  let configPath: string;

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
    configPath = join(tmpDir, "toolmux.json");
  });

  afterEach(async () => {
    try { await unlink(configPath); } catch {}
  });

  it("loads a valid config", async () => {
    const config = {
      servers: [{
        name: "test",
        transport: { type: "stdio", command: "echo", args: ["hello"] },
      }],
    };
    await writeFile(configPath, JSON.stringify(config));

    const result = await loadConfig(configPath);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0].name).toBe("test");
    expect(result.servers[0].transport.type).toBe("stdio");
  });

  it("throws for missing config", async () => {
    await expect(loadConfig("/nonexistent/path.json")).rejects.toThrow(
      "Config file not found"
    );
  });

  it("throws for missing servers array", async () => {
    await writeFile(configPath, JSON.stringify({ foo: "bar" }));
    await expect(loadConfig(configPath)).rejects.toThrow("servers");
  });

  it("throws for server without name", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ servers: [{ transport: { type: "stdio", command: "echo" } }] })
    );
    await expect(loadConfig(configPath)).rejects.toThrow("name");
  });

  it("throws for server without transport", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ servers: [{ name: "test" }] })
    );
    await expect(loadConfig(configPath)).rejects.toThrow("transport");
  });

  it("expands environment variables", async () => {
    process.env.TOOLMUX_TEST_TOKEN = "secret123";
    const config = {
      servers: [{
        name: "test",
        transport: {
          type: "stdio",
          command: "echo",
          env: { TOKEN: "$TOOLMUX_TEST_TOKEN" },
        },
      }],
    };
    await writeFile(configPath, JSON.stringify(config));

    const result = await loadConfig(configPath);
    const transport = result.servers[0].transport as { env: Record<string, string> };
    expect(transport.env.TOKEN).toBe("secret123");

    delete process.env.TOOLMUX_TEST_TOKEN;
  });

  it("expands ${VAR} syntax", async () => {
    process.env.TOOLMUX_BRACED = "braced_value";
    const config = {
      servers: [{
        name: "test",
        transport: {
          type: "http",
          url: "https://example.com",
          headers: { "Authorization": "Bearer ${TOOLMUX_BRACED}" },
        },
      }],
    };
    await writeFile(configPath, JSON.stringify(config));

    const result = await loadConfig(configPath);
    const transport = result.servers[0].transport as { headers: Record<string, string> };
    expect(transport.headers.Authorization).toBe("Bearer braced_value");

    delete process.env.TOOLMUX_BRACED;
  });

  it("replaces missing env vars with empty string", async () => {
    const config = {
      servers: [{
        name: "test",
        transport: {
          type: "stdio",
          command: "echo",
          env: { TOKEN: "$DEFINITELY_NOT_SET_12345" },
        },
      }],
    };
    await writeFile(configPath, JSON.stringify(config));

    const result = await loadConfig(configPath);
    const transport = result.servers[0].transport as { env: Record<string, string> };
    expect(transport.env.TOKEN).toBe("");
  });
});
