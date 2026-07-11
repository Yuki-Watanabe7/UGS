import { describe, expect, it } from "vitest";
import { resolveSpeechEventText, resolveSpeechText } from "./speechTemplates";
import { createSpeechEvent } from "./speech";
import type { SpeechReason } from "./speech";

const ALL_REASONS: SpeechReason[] = ["initiativeFormedCore", "cliqueFormedCore", "lightObserverInvitation"];

describe("speechTemplates: coverage", () => {
  it("has a non-empty template for every SpeechReason", () => {
    for (const reason of ALL_REASONS) {
      expect(resolveSpeechText(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("resolveSpeechEventText", () => {
  it("resolves the same text as resolveSpeechText(event.reason)", () => {
    const event = createSpeechEvent({
      tick: 1,
      speakerId: "agent-1",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "agent-2",
    });

    expect(resolveSpeechEventText(event)).toBe(resolveSpeechText("lightObserverInvitation"));
  });
});
