import type { IndexedTool } from "./pool.js";

/**
 * Convert a JSON Schema to a TypeScript type signature string.
 * Handles objects, arrays, enums, oneOf/anyOf/allOf, $ref, const.
 */
export function schemaToTs(schema: Record<string, unknown>, maxLen = 300): string {
  if (typeof schema.$ref === "string") {
    return schema.$ref.split("/").at(-1) ?? "unknown";
  }

  if ("const" in schema) {
    return JSON.stringify(schema.const);
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return truncate(schema.enum.map((v) => JSON.stringify(v)).join(" | "), maxLen);
  }

  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const items = Array.isArray(schema[key]) ? (schema[key] as Record<string, unknown>[]) : [];
    if (items.length > 0) {
      const sep = key === "allOf" ? " & " : " | ";
      const parts = items.map((item) => schemaToTs(item, maxLen)).filter(Boolean);
      if (parts.length > 0) return truncate(parts.join(sep), maxLen);
    }
  }

  if (schema.type === "array") {
    const itemType = schema.items ? schemaToTs(schema.items as Record<string, unknown>, maxLen) : "unknown";
    return `${itemType}[]`;
  }

  if (schema.type === "object" || schema.properties) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const keys = Object.keys(props);
    if (keys.length === 0) {
      return schema.additionalProperties ? "Record<string, unknown>" : "object";
    }

    const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
    const parts = keys.map((k) => {
      const opt = required.has(k) ? "" : "?";
      return `${k}${opt}: ${schemaToTs(props[k], maxLen)}`;
    });
    return truncate(`{ ${parts.join("; ")} }`, maxLen);
  }

  if (Array.isArray(schema.type)) {
    return schema.type.join(" | ");
  }

  if (typeof schema.type === "string") {
    return schema.type;
  }

  return "unknown";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 4) + " ...";
}

/**
 * Generate a TypeScript declaration block for all tools.
 * This gets injected into the LLM's context so it knows what's callable.
 */
export function generateTypeDeclarations(tools: IndexedTool[]): string {
  const lines: string[] = ["declare const tools: {"];

  for (const tool of tools) {
    const inputType = schemaToTs(tool.inputSchema);
    // Keep descriptions short — just enough to disambiguate
    const desc = tool.description
      ? tool.description.replace(/\*\//g, "* /").split(/[.!]\s/)[0].slice(0, 80)
      : "";

    if (desc) {
      lines.push(`  /** ${desc} */`);
    }
    lines.push(`  ${tool.qualifiedName}(input: ${inputType}): Promise<unknown>;`);
  }

  lines.push("};");
  return lines.join("\n");
}

/**
 * Build the description for the execute tool, including available tools and types.
 */
export function buildExecuteDescription(tools: IndexedTool[]): string {
  const typeBlock = generateTypeDeclarations(tools);

  const parts = [
    "Run JS in sandbox. Call tools via await tools.name(args). Return a value. No fetch.",
    typeBlock,
  ];

  return parts.join("\n");
}
