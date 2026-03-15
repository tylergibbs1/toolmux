/**
 * Sandbox worker — runs in a forked child process.
 * Uses Node.js vm module (V8 isolate contexts) for code execution.
 * The tools proxy sends IPC messages back to parent for dispatch.
 */

import { createContext, runInContext } from "node:vm";

const pendingCalls = new Map();
let nextCallId = 1;

/** Build a nested proxy that captures property access paths and proxies calls via IPC */
function makeToolsProxy(path = []) {
  return new Proxy(() => undefined, {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return makeToolsProxy([...path, prop]);
    },
    apply(_target, _thisArg, args) {
      const toolPath = path.join(".");
      if (!toolPath) throw new Error("Tool path missing");

      const callId = `call_${nextCallId++}`;
      return new Promise((resolve, reject) => {
        pendingCalls.set(callId, { resolve, reject });
        process.send({
          type: "tool-call",
          callId,
          path: toolPath,
          args: args[0] ?? {},
        });
      });
    },
  });
}

/** Wrap user code in an async IIFE */
function wrapCode(code) {
  const trimmed = code.trim();

  // Detect arrow function
  const isArrow =
    (trimmed.startsWith("async") || trimmed.startsWith("(")) &&
    trimmed.includes("=>");

  if (isArrow) {
    return [
      '"use strict";',
      "(async () => {",
      `  const __fn = (${trimmed});`,
      "  if (typeof __fn !== 'function') throw new Error('Code must be a function');",
      "  return await __fn();",
      "})()",
    ].join("\n");
  }

  return ['"use strict";', "(async () => {", code, "})()"].join("\n");
}

function serialize(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function fmtArg(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Handle messages from parent
process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;

  // Tool call response from parent
  if (msg.type === "tool-response") {
    const pending = pendingCalls.get(msg.callId);
    if (!pending) return;
    pendingCalls.delete(msg.callId);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.value);
    return;
  }

  // Execute code in a V8 context
  if (msg.type === "evaluate") {
    const logs = [];

    // Create an isolated V8 context with only safe globals + tools proxy
    const sandbox = {
      tools: makeToolsProxy(),
      console: {
        log: (...args) => logs.push(`[log] ${args.map(fmtArg).join(" ")}`),
        warn: (...args) => logs.push(`[warn] ${args.map(fmtArg).join(" ")}`),
        error: (...args) => logs.push(`[error] ${args.map(fmtArg).join(" ")}`),
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      URL: globalThis.URL,
      URLSearchParams: globalThis.URLSearchParams,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      JSON: globalThis.JSON,
      Math: globalThis.Math,
      Date: globalThis.Date,
      Promise: globalThis.Promise,
      Object: globalThis.Object,
      Array: globalThis.Array,
      Map: globalThis.Map,
      Set: globalThis.Set,
      RegExp: globalThis.RegExp,
      Error: globalThis.Error,
      structuredClone: globalThis.structuredClone,
    };

    // vm.createContext creates a V8 context — code cannot access
    // the parent's globals, require, process, fs, net, etc.
    const ctx = createContext(sandbox, {
      name: "toolmux-sandbox",
      codeGeneration: { strings: false, wasm: false },
    });

    try {
      const wrapped = wrapCode(msg.code);
      const result = await runInContext(wrapped, ctx, {
        timeout: 30_000,
        displayErrors: true,
      });

      process.send({
        type: "result",
        id: msg.id,
        value: serialize(result),
        logs,
      });
    } catch (err) {
      process.send({
        type: "result",
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
        logs,
      });
    }
  }
});

// Signal ready
process.send({ type: "ready" });
