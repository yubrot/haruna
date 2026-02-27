import { describe, expect, test } from "bun:test";
import { parseSceneInput } from "./interface.ts";

describe("parseSceneInput", () => {
  test("accepts a valid TextInput object", () => {
    expect(parseSceneInput({ type: "text", content: "hello" })).toEqual({
      type: "text",
      content: "hello",
    });
  });

  test("accepts a valid TextInput as a JSON string", () => {
    const json = JSON.stringify({ type: "text", content: "hello" });
    expect(parseSceneInput(json)).toEqual({ type: "text", content: "hello" });
  });

  test("returns null for invalid JSON string", () => {
    expect(parseSceneInput("{invalid}")).toBeNull();
  });

  test("returns null when type is not 'text'", () => {
    expect(parseSceneInput({ type: "other", content: "hello" })).toBeNull();
  });

  test("returns null when content is not a string", () => {
    expect(parseSceneInput({ type: "text", content: 123 })).toBeNull();
  });

  test("returns null for null", () => {
    expect(parseSceneInput(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(parseSceneInput(undefined)).toBeNull();
  });

  test("returns null for a number", () => {
    expect(parseSceneInput(42)).toBeNull();
  });

  test("returns null for a boolean", () => {
    expect(parseSceneInput(true)).toBeNull();
  });

  test("strips C0 control characters from content", () => {
    // \x03 = Ctrl+C, \x1b = ESC — should be removed
    expect(parseSceneInput({ type: "text", content: "a\x03b\x1bc" })).toEqual({
      type: "text",
      content: "abc",
    });
  });

  test("preserves tab and newline in content", () => {
    expect(parseSceneInput({ type: "text", content: "a\tb\nc" })).toEqual({
      type: "text",
      content: "a\tb\nc",
    });
  });

  test("ignores extra properties", () => {
    const result = parseSceneInput({
      type: "text",
      content: "hello",
      extra: true,
    });
    expect(result).toEqual({ type: "text", content: "hello" });
  });

  test("accepts a valid SelectInput object", () => {
    expect(parseSceneInput({ type: "select", index: 0 })).toEqual({
      type: "select",
      index: 0,
    });
  });

  test("accepts a valid SelectInput as a JSON string", () => {
    const json = JSON.stringify({ type: "select", index: 2 });
    expect(parseSceneInput(json)).toEqual({ type: "select", index: 2 });
  });

  test("returns null for SelectInput with negative index", () => {
    expect(parseSceneInput({ type: "select", index: -1 })).toBeNull();
  });

  test("returns null for SelectInput with non-integer index", () => {
    expect(parseSceneInput({ type: "select", index: 1.5 })).toBeNull();
  });

  test("returns null for SelectInput with non-number index", () => {
    expect(parseSceneInput({ type: "select", index: "0" })).toBeNull();
  });
});
