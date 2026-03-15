import { describe, it, expect } from "vitest";
import { schemaToTs, generateTypeDeclarations } from "../codegen.js";
import type { IndexedTool } from "../pool.js";

describe("schemaToTs", () => {
  it("handles simple string type", () => {
    expect(schemaToTs({ type: "string" })).toBe("string");
  });

  it("handles simple number type", () => {
    expect(schemaToTs({ type: "number" })).toBe("number");
  });

  it("handles boolean type", () => {
    expect(schemaToTs({ type: "boolean" })).toBe("boolean");
  });

  it("handles object with properties", () => {
    const result = schemaToTs({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    expect(result).toContain("name: string");
    expect(result).toContain("age?: number");
    expect(result).toMatch(/^\{.*\}$/);
  });

  it("handles required vs optional", () => {
    const result = schemaToTs({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
      required: ["a"],
    });
    expect(result).toContain("a: string");
    expect(result).toContain("b?: string");
  });

  it("handles array type", () => {
    const result = schemaToTs({
      type: "array",
      items: { type: "string" },
    });
    expect(result).toBe("string[]");
  });

  it("handles nested objects", () => {
    const result = schemaToTs({
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
      },
    });
    expect(result).toContain("address?:");
    expect(result).toContain("city: string");
  });

  it("handles enum", () => {
    const result = schemaToTs({
      type: "string",
      enum: ["open", "closed", "merged"],
    });
    expect(result).toBe('"open" | "closed" | "merged"');
  });

  it("handles const", () => {
    expect(schemaToTs({ const: "fixed" })).toBe('"fixed"');
  });

  it("handles oneOf", () => {
    const result = schemaToTs({
      oneOf: [{ type: "string" }, { type: "number" }],
    });
    expect(result).toBe("string | number");
  });

  it("handles allOf", () => {
    const result = schemaToTs({
      allOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    });
    expect(result).toContain("&");
  });

  it("handles $ref", () => {
    expect(schemaToTs({ $ref: "#/definitions/User" })).toBe("User");
  });

  it("handles empty object", () => {
    expect(schemaToTs({ type: "object" })).toBe("object");
  });

  it("handles object with additionalProperties", () => {
    expect(schemaToTs({ type: "object", additionalProperties: true })).toBe("Record<string, unknown>");
  });

  it("returns unknown for empty schema", () => {
    expect(schemaToTs({})).toBe("unknown");
  });
});

describe("generateTypeDeclarations", () => {
  const tools: IndexedTool[] = [
    {
      server: "github",
      originalName: "create_issue",
      qualifiedName: "github__create_issue",
      description: "Create a GitHub issue",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          repo: { type: "string" },
        },
        required: ["title", "repo"],
      },
    },
    {
      server: "slack",
      originalName: "post_message",
      qualifiedName: "slack__post_message",
      description: "Post a Slack message",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string" },
          text: { type: "string" },
        },
        required: ["channel", "text"],
      },
    },
  ];

  it("generates valid TypeScript declarations", () => {
    const result = generateTypeDeclarations(tools);
    expect(result).toContain("declare const tools");
    expect(result).toContain("github__create_issue");
    expect(result).toContain("slack__post_message");
    expect(result).toContain("Promise<unknown>");
  });

  it("includes JSDoc comments with descriptions", () => {
    const result = generateTypeDeclarations(tools);
    expect(result).toContain("Create a GitHub issue");
    expect(result).toContain("Post a Slack message");
  });

  it("includes input types", () => {
    const result = generateTypeDeclarations(tools);
    expect(result).toContain("title: string");
    expect(result).toContain("body?: string");
    expect(result).toContain("channel: string");
  });
});
