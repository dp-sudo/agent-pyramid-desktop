import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  canonicalizeJsonRecord,
  stableJsonStringify,
} from "../../src/main/stable-json";

describe("stable JSON helpers", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(stableJsonStringify({
      z: 1,
      a: {
        b: 2,
        a: [{ z: true, a: false }],
      },
    })).toBe('{"a":{"a":[{"a":false,"z":true}],"b":2},"z":1}');
  });

  it("returns non-object schema inputs as an empty canonical record", () => {
    expect(canonicalizeJsonRecord(null)).toEqual({});
    expect(canonicalizeJsonRecord([])).toEqual({});
    expect(canonicalizeJsonRecord({
      z: { type: "string" },
      a: { type: "number" },
    })).toEqual({
      a: { type: "number" },
      z: { type: "string" },
    });
  });

  it("keeps primitive values stable", () => {
    expect(canonicalizeJson("value")).toBe("value");
    expect(stableJsonStringify(undefined)).toBe("undefined");
  });
});
