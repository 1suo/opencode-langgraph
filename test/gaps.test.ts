import { describe, expect, it } from "vitest";
import { verifyAndMergeGaps } from "../src/gaps.js";

const pristine = "const value = /*<NEOLIT:GAP:value>*/0/*</NEOLIT:GAP:value>*/;\n";

describe("gap enforcement", () => {
  it("accepts content changed only inside a gap and removes markers", () => {
    const edited = pristine.replace(">*/0/*</", ">*/42/*</");
    expect(verifyAndMergeGaps(pristine, edited)).toBe("const value = 42;\n");
  });

  it("rejects any byte changed outside a gap", () => {
    expect(() => verifyAndMergeGaps(pristine, pristine.replace("const", "let"))).toThrow(/outside gap/);
  });

  it("rejects removed markers", () => {
    expect(() => verifyAndMergeGaps(pristine, "const value = 42;\n")).toThrow(/Gap count/);
  });

  it("allows a gapless skeleton file only when it is unchanged", () => {
    expect(verifyAndMergeGaps("test();\n", "test();\n")).toBe("test();\n");
    expect(() => verifyAndMergeGaps("test();\n", "skip();\n")).toThrow(/without declared gaps/);
  });
});
