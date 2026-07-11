import { describe, expect, it } from "vitest";
import { createSpeechEvent, deriveSpeechEvents } from "./speech";
import type { Agent, SimulationState } from "./types";

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

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    label: "X",
    x: 400,
    y: 260,
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

function makeState(tick: number, agents: Agent[], groupCandidates: SimulationState["groupCandidates"] = []): SimulationState {
  return {
    tick,
    agents,
    groupCandidates,
    log: [],
    width: 800,
    height: 520,
    finished: false,
    speechLog: [],
  };
}

describe("deriveSpeechEvents", () => {
  it("emits formingGroupRecruitment when a non-founder joins an already-forming candidate", () => {
    const founder = makeAgent({ id: "founder", state: "forming" });
    const joiner = makeAgent({ id: "joiner", state: "undecided" });
    const previousState = makeState(4, [founder, joiner]);
    const nextState = makeState(5, [founder, { ...joiner, state: "forming" }], [
      { id: "group-1", x: 400, y: 260, memberIds: ["founder", "joiner"], status: "forming", age: 1 },
    ]);

    const events = deriveSpeechEvents(previousState, nextState);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      speakerId: "founder",
      intent: "invite",
      reason: "formingGroupRecruitment",
      audience: "nearby",
      target: undefined,
      tick: 5,
    });
  });

  it("does not emit formingGroupRecruitment for the founder's own undecided -> forming transition", () => {
    const founder = makeAgent({ id: "founder", state: "undecided" });
    const previousState = makeState(4, [founder]);
    const nextState = makeState(5, [{ ...founder, state: "forming" }], [
      { id: "group-1", x: 400, y: 260, memberIds: ["founder"], status: "forming", age: 0 },
    ]);

    expect(deriveSpeechEvents(previousState, nextState)).toEqual([]);
  });

  it("emits approachWelcome, spoken by the candidate's first member, when someone starts approaching", () => {
    const member = makeAgent({ id: "member", state: "joined", joinedGroupId: "group-1" });
    const approacher = makeAgent({ id: "approacher", state: "undecided" });
    const previousState = makeState(4, [member, approacher]);
    const nextState = makeState(
      5,
      [member, { ...approacher, state: "approaching", joinedGroupId: "group-1" }],
      [{ id: "group-1", x: 400, y: 260, memberIds: ["member"], status: "confirmed", age: 3 }],
    );

    const events = deriveSpeechEvents(previousState, nextState);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      speakerId: "member",
      intent: "welcome",
      reason: "approachWelcome",
      target: "approacher",
      audience: undefined,
      tick: 5,
    });
  });

  it("emits joinGreeting spoken by the agent that just arrived, from either approaching or forming", () => {
    const arriving = makeAgent({ id: "arriving", state: "approaching", joinedGroupId: "group-1" });
    const previousState = makeState(4, [arriving]);
    const nextState = makeState(5, [{ ...arriving, state: "joined" }], [
      { id: "group-1", x: 400, y: 260, memberIds: ["arriving"], status: "confirmed", age: 3 },
    ]);

    const events = deriveSpeechEvents(previousState, nextState);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      speakerId: "arriving",
      intent: "greet",
      reason: "joinGreeting",
      audience: "nearby",
      target: undefined,
      tick: 5,
    });
  });

  it("emits leaveDeclaration spoken by the agent that gives up waiting", () => {
    const leaver = makeAgent({ id: "leaver", state: "undecided" });
    const previousState = makeState(4, [leaver]);
    const nextState = makeState(5, [{ ...leaver, state: "leaving" }]);

    const events = deriveSpeechEvents(previousState, nextState);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      speakerId: "leaver",
      intent: "decline",
      reason: "leaveDeclaration",
      audience: "nearby",
      target: undefined,
      tick: 5,
    });
  });

  it("returns no events when no agent changed state", () => {
    const idle = makeAgent({ id: "idle", state: "undecided" });
    const previousState = makeState(4, [idle]);
    const nextState = makeState(5, [idle]);

    expect(deriveSpeechEvents(previousState, nextState)).toEqual([]);
  });
});
