import { describe, expect, it } from "vitest";
import {
  createSpeechEvent,
  DEFAULT_SPEECH_RANGE,
  DEFAULT_SPEECH_STRENGTH,
  deriveSpeechEvents,
  LIGHT_OBSERVER_INVITATION_RANGE,
} from "./speech";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./model";
import type { Agent, SimulationState } from "./types";

describe("createSpeechEvent", () => {
  it("builds a SpeechEvent with a deterministic id and textKey derived from tick/speakerId/reason", () => {
    const event = createSpeechEvent({
      tick: 12,
      speakerId: "agent-3",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
      originX: 100,
      originY: 50,
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
      originX: 100,
      originY: 50,
      range: DEFAULT_SPEECH_RANGE,
      strength: DEFAULT_SPEECH_STRENGTH,
      audibility: DEFAULT_SPEECH_RANGE * DEFAULT_SPEECH_STRENGTH,
    });
  });

  it("defaults originX/originY to (0, 0) when omitted (backward compatible with callers that don't pass a position)", () => {
    const event = createSpeechEvent({
      tick: 1,
      speakerId: "agent-1",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
    });

    expect(event.originX).toBe(0);
    expect(event.originY).toBe(0);
  });

  it("uses an explicitly larger default range for lightObserverInvitation so it always reaches its target", () => {
    const event = createSpeechEvent({
      tick: 1,
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "observer",
      originX: 0,
      originY: 0,
    });

    expect(event.range).toBe(LIGHT_OBSERVER_INVITATION_RANGE);
    // The audibility threshold must exceed the world diagonal so the worst-case fallback
    // selection in selectInvitationAgent (interventions.ts) can never fail to reach its target.
    expect(event.audibility).toBeGreaterThan(Math.hypot(WORLD_WIDTH, WORLD_HEIGHT));
  });

  it("allows an explicit range/strength override", () => {
    const event = createSpeechEvent({
      tick: 1,
      speakerId: "agent-1",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
      originX: 0,
      originY: 0,
      range: 50,
      strength: 2,
    });

    expect(event.range).toBe(50);
    expect(event.strength).toBe(2);
    expect(event.audibility).toBe(100);
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
    const founder = makeAgent({ id: "founder", state: "forming", x: 120, y: 90 });
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
      originX: 120,
      originY: 90,
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
    const member = makeAgent({ id: "member", state: "joined", joinedGroupId: "group-1", x: 405, y: 258 });
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
      originX: 405,
      originY: 258,
    });
  });

  it("emits joinGreeting spoken by the agent that just arrived, from either approaching or forming", () => {
    const arriving = makeAgent({ id: "arriving", state: "approaching", joinedGroupId: "group-1", x: 390, y: 270 });
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
      originX: 390,
      originY: 270,
    });
  });

  it("emits leaveDeclaration spoken by the agent that gives up waiting", () => {
    const leaver = makeAgent({ id: "leaver", state: "undecided", x: 50, y: 480 });
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
      originX: 50,
      originY: 480,
    });
  });

  it("returns no events when no agent changed state", () => {
    const idle = makeAgent({ id: "idle", state: "undecided" });
    const previousState = makeState(4, [idle]);
    const nextState = makeState(5, [idle]);

    expect(deriveSpeechEvents(previousState, nextState)).toEqual([]);
  });
});
