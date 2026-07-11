import { describe, expect, it } from "vitest";
import { formatTick } from "./time";

describe("formatTick", () => {
  it("formats tick 0 as 00:00", () => {
    expect(formatTick(0)).toBe("00:00");
  });

  it("converts 1 tick to 3 seconds", () => {
    expect(formatTick(1)).toBe("00:03");
  });

  it("rolls seconds over into minutes", () => {
    expect(formatTick(20)).toBe("01:00");
  });

  it("pads minutes and seconds to two digits", () => {
    expect(formatTick(2)).toBe("00:06");
    expect(formatTick(200)).toBe("10:00");
  });
});
