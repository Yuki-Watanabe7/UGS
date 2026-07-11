import { describe, expect, it } from "vitest";
import { formatSpeechBubbleText } from "./speechBubbleFormat";
import { createSpeechEvent } from "../simulation/speech";
import { buildAgentLabelMap } from "./speechDisplay";
import type { Agent } from "../simulation/types";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-a",
    label: "A",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    willingness: 0.5,
    initiative: 0.3,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.3,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "undecided",
    stress: 0,
    ...overrides,
  };
}

describe("formatSpeechBubbleText", () => {
  const labelById = buildAgentLabelMap([makeAgent({ id: "agent-a", label: "A" }), makeAgent({ id: "agent-b", label: "B" })]);

  it("prefixes the resolved speech text with a speech icon, distinct from the bracket-wrapped thought format", () => {
    const event = createSpeechEvent({
      tick: 1,
      speakerId: "agent-a",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
    });
    const text = formatSpeechBubbleText(event, labelById);
    expect(text.startsWith("💬")).toBe(true);
    expect(text).not.toContain("（");
    expect(text).toContain("もう一軒行く?");
  });

  it("appends a destination hint for a target-directed speech event", () => {
    const event = createSpeechEvent({
      tick: 2,
      speakerId: "agent-a",
      intent: "welcome",
      reason: "approachWelcome",
      target: "agent-b",
    });
    const text = formatSpeechBubbleText(event, labelById);
    expect(text).toContain("→");
    expect(text).toContain("Bさんへ");
  });

  it("appends a destination hint for an audience-directed speech event", () => {
    const event = createSpeechEvent({
      tick: 3,
      speakerId: "agent-a",
      intent: "greet",
      reason: "joinGreeting",
      audience: "nearby",
    });
    const text = formatSpeechBubbleText(event, labelById);
    expect(text).toContain("→周囲へ");
  });
});
