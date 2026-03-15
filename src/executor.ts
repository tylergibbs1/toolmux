import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "./pool.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, "sandbox-worker.mjs");

export type ExecuteResult = {
  value: unknown;
  error?: string;
  logs: string[];
};

export class Executor {
  private pool: Pool;
  private timeoutMs: number;

  constructor(pool: Pool, opts?: { timeoutMs?: number }) {
    this.pool = pool;
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
  }

  async execute(code: string): Promise<ExecuteResult> {
    return new Promise((resolve) => {
      const child = fork(WORKER_PATH, [], {
        serialization: "json",
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });

      let settled = false;
      const settle = (result: ExecuteResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(result);
      };

      const timer = setTimeout(() => {
        settle({ value: undefined, error: "Execution timed out", logs: [] });
      }, this.timeoutMs);

      child.on("error", (err) => {
        settle({ value: undefined, error: `Worker error: ${err.message}`, logs: [] });
      });

      child.on("exit", (code) => {
        if (!settled) {
          settle({
            value: undefined,
            error: code !== 0 ? `Worker exited with code ${code}` : undefined,
            logs: [],
          });
        }
      });

      child.on("message", async (msg: Record<string, unknown>) => {
        if (!msg || typeof msg !== "object") return;

        // Worker is ready — send code
        if (msg.type === "ready") {
          child.send({ type: "evaluate", id: "exec_1", code });
          return;
        }

        // Tool call from sandbox — dispatch to pool
        if (msg.type === "tool-call") {
          const callId = msg.callId as string;
          const toolPath = msg.path as string;
          const args = (msg.args ?? {}) as Record<string, unknown>;

          try {
            const result = await this.pool.call(toolPath, args);

            // Extract text content from MCP result
            let value: unknown = result;
            if (
              result &&
              typeof result === "object" &&
              "content" in result &&
              Array.isArray((result as Record<string, unknown>).content)
            ) {
              const content = (result as { content: Array<{ type: string; text?: string }> }).content;
              const texts = content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text!);
              // Try to parse as JSON if single text result
              if (texts.length === 1) {
                try {
                  value = JSON.parse(texts[0]);
                } catch {
                  value = texts[0];
                }
              } else {
                value = texts.join("\n");
              }
            }

            child.send({ type: "tool-response", callId, value });
          } catch (err) {
            child.send({
              type: "tool-response",
              callId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        // Execution result
        if (msg.type === "result") {
          settle({
            value: msg.value ?? undefined,
            error: msg.error as string | undefined,
            logs: (msg.logs as string[]) ?? [],
          });
        }
      });
    });
  }
}
