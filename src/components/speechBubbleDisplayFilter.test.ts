import { describe, expect, it } from "vitest";
import { DEFAULT_SPEECH_BUBBLE_DISPLAY_SETTINGS } from "./speechBubbleDisplayFilter";

describe("DEFAULT_SPEECH_BUBBLE_DISPLAY_SETTINGS", () => {
  it("defaults to enabled (speech bubbles shown by default, matching thought bubble's default)", () => {
    expect(DEFAULT_SPEECH_BUBBLE_DISPLAY_SETTINGS).toEqual({ enabled: true });
  });
});
