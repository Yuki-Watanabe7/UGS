import { describe, expect, it } from "vitest";
import { createSpeechEvent } from "./speech";

describe("createSpeechEvent", () => {
  it("builds a SpeechEvent with a deterministic id and textKey derived from tick/speakerId/reason", () => {
    const event = createSpeechEvent({
      tick: 12,
      speakerId: "agent-3",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
    });

    expect(event).toEqual({
      id: "speech-12-agent-3-initiativeFormedCore",
      tick: 12,
      speakerId: "agent-3",
      intent: "invite",
      reason: "initiativeFormedCore",
      target: undefined,
      audience: "nearby",
      textKey: "speech.initiativeFormedCore",
    });
  });

  it("supports a targeted (1:1) speech event without an audience", () => {
    const event = createSpeechEvent({
      tick: 7,
      speakerId: "agent-1",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "agent-2",
    });

    expect(event.target).toBe("agent-2");
    expect(event.audience).toBeUndefined();
  });

  it("is a pure function: repeated calls with identical input return equal (deep-equal) events", () => {
    const input = {
      tick: 5,
      speakerId: "agent-9",
      intent: "invite" as const,
      reason: "cliqueFormedCore" as const,
      audience: "nearby" as const,
    };

    expect(createSpeechEvent(input)).toEqual(createSpeechEvent(input));
  });

  it("produces distinct ids for the same speaker/tick when the reason differs", () => {
    const a = createSpeechEvent({
      tick: 3,
      speakerId: "agent-1",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
    });
    const b = createSpeechEvent({
      tick: 3,
      speakerId: "agent-1",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "agent-2",
    });

    expect(a.id).not.toBe(b.id);
  });
});
