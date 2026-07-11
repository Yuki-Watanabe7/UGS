import { describe, expect, it } from "vitest";
import { buildObserverJoinerInspection } from "./inspection";
import { attractiveness } from "./engine";
import { createSpeechEvent } from "./speech";
import { DEFAULT_PARAMS } from "./presets";
import { aggregateActiveEffects } from "./speechEffects";
import type {
  SpeechActiveEffect,
  SpeechEffectEvent,
  SpeechInterpretationEvent,
  SpeechReceptionEvent,
} from "./speechEffects";
import type { Agent, GroupCandidate, SimulationState } from "./types";

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

function makeState(overrides: Partial<SimulationState>): SimulationState {
  return {
    tick: 0,
    agents: [],
    groupCandidates: [],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    ...overrides,
  };
}

describe("buildObserverJoinerInspection", () => {
  it("returns an empty array when there is no observerJoiner", () => {
    const state = makeState({ agents: [makeAgent({ id: "plain" })] });

    expect(buildObserverJoinerInspection(state, DEFAULT_PARAMS)).toEqual([]);
  });

  it("extracts the raw observerJoiner attributes", () => {
    const observer = makeAgent({
      id: "observer",
      label: "Observer",
      isObserverJoiner: true,
      state: "undecided",
      stress: 0.2,
      willingness: 0.8,
      ambiguityTolerance: 0.25,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.4,
    });
    const state = makeState({ agents: [observer] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection).toMatchObject({
      agentId: "observer",
      label: "Observer",
      state: "undecided",
      stress: 0.2,
      willingness: 0.8,
      ambiguityTolerance: 0.25,
      influenceAvoidance: 0.9,
      leaveThreshold: 0.4,
    });
  });

  it("leaves nearest-group fields undefined when no joinable candidate exists", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const dissolvingCandidate: GroupCandidate = {
      id: "group-1",
      x: 405,
      y: 262,
      memberIds: ["leader"],
      status: "dissolving",
      age: 1,
    };
    const state = makeState({ agents: [observer], groupCandidates: [dissolvingCandidate] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.nearestGroupId).toBeUndefined();
    expect(inspection.nearestGroupStatus).toBeUndefined();
    expect(inspection.nearestGroupMemberCount).toBeUndefined();
    expect(inspection.nearestGroupDistance).toBeUndefined();
    expect(inspection.attractivenessScore).toBeUndefined();
  });

  it("picks the nearest joinable candidate among several forming/confirmed groups", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true, x: 400, y: 260 });
    const far: GroupCandidate = {
      id: "far-group",
      x: 700,
      y: 260,
      memberIds: ["leader-far"],
      status: "forming",
      age: 1,
    };
    const near: GroupCandidate = {
      id: "near-group",
      x: 420,
      y: 260,
      memberIds: ["leader-near", "member-2"],
      status: "confirmed",
      age: 5,
    };
    const state = makeState({ agents: [observer], groupCandidates: [far, near] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.nearestGroupId).toBe("near-group");
    expect(inspection.nearestGroupStatus).toBe("confirmed");
    expect(inspection.nearestGroupMemberCount).toBe(2);
    expect(inspection.nearestGroupDistance).toBeCloseTo(20, 5);
  });

  it("computes leaveMargin as leaveThreshold - stress", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true, stress: 0.35, leaveThreshold: 0.5 });
    const state = makeState({ agents: [observer] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.leaveMargin).toBeCloseTo(0.15, 10);
  });

  it("computes attractivenessScore using the same formula as the join-decision logic", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true, x: 400, y: 260 });
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 430,
      y: 260,
      memberIds: ["leader"],
      status: "forming",
      age: 1,
    };
    const state = makeState({ agents: [observer], groupCandidates: [candidate] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);
    const expectedScore = attractiveness(observer, candidate, state.agents, DEFAULT_PARAMS);

    expect(inspection.attractivenessScore).toBe(expectedScore);
  });

  it("does not mutate the SimulationState passed in", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true, x: 400, y: 260 });
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 430,
      y: 260,
      memberIds: ["leader"],
      status: "forming",
      age: 1,
    };
    const state = makeState({ agents: [observer], groupCandidates: [candidate] });
    const snapshot = JSON.parse(JSON.stringify(state));

    buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(state).toEqual(snapshot);
  });

  it("returns one inspection entry per observerJoiner when there are multiple", () => {
    const observerA = makeAgent({ id: "observer-a", isObserverJoiner: true });
    const observerB = makeAgent({ id: "observer-b", isObserverJoiner: true });
    const plain = makeAgent({ id: "plain", isObserverJoiner: false });
    const state = makeState({ agents: [observerA, observerB, plain] });

    const inspections = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspections.map((i) => i.agentId)).toEqual(["observer-a", "observer-b"]);
  });

  it("returns an empty speechHistory when speechLog is absent or empty", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const state = makeState({ agents: [observer] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.speechHistory).toEqual([]);
  });

  it("classifies a speech event where the observerJoiner is the speaker", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const event = createSpeechEvent({
      tick: 3,
      speakerId: "observer",
      intent: "greet",
      reason: "joinGreeting",
      audience: "nearby",
    });
    const state = makeState({ agents: [observer], speechLog: [event] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.speechHistory).toEqual([{ event, relation: "speaker" }]);
  });

  it("classifies a speech event where the observerJoiner is the explicit target", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const event = createSpeechEvent({
      tick: 5,
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "observer",
    });
    const state = makeState({ agents: [observer], speechLog: [event] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.speechHistory).toEqual([{ event, relation: "target" }]);
  });

  it("classifies a nearby-audience speech event from an unrelated agent as 'audience'", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const event = createSpeechEvent({
      tick: 7,
      speakerId: "founder",
      intent: "invite",
      reason: "formingGroupRecruitment",
      audience: "nearby",
    });
    const state = makeState({ agents: [observer], speechLog: [event] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.speechHistory).toEqual([{ event, relation: "audience" }]);
  });

  it("excludes speech events that neither name nor broadcast to the observerJoiner", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const event = createSpeechEvent({
      tick: 9,
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "someone-else",
    });
    const state = makeState({ agents: [observer], speechLog: [event] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.speechHistory).toEqual([]);
  });

  it("preserves speechLog tick order in speechHistory", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const first = createSpeechEvent({
      tick: 2,
      speakerId: "observer",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
    });
    const second = createSpeechEvent({
      tick: 6,
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "observer",
    });
    const state = makeState({ agents: [observer], speechLog: [first, second] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.speechHistory.map((h) => h.event.id)).toEqual([first.id, second.id]);
  });
});

describe("buildObserverJoinerInspection: Phase 3 speechEffectDetails/activeEffectSummaries (Issue #98)", () => {
  it("returns speechEffectDetails with all-undefined fields when no Phase 3 logs are present", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const event = createSpeechEvent({
      tick: 3,
      speakerId: "observer",
      intent: "greet",
      reason: "joinGreeting",
      audience: "nearby",
    });
    const state = makeState({ agents: [observer], speechLog: [event] });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.speechEffectDetails).toEqual([
      { speechEventId: event.id, reception: undefined, interpretation: undefined, effect: undefined, activeEffectStatus: undefined },
    ]);
    expect(inspection.activeEffectSummaries).toEqual([]);
  });

  it("links reception/interpretation/effect/activeEffectStatus to the matching speechHistory entry by speechEventId+receiverId", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const helper = makeAgent({ id: "helper", label: "Helper" });
    const event = createSpeechEvent({
      tick: 5,
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "observer",
    });

    const reception: SpeechReceptionEvent = {
      id: "reception-1",
      speechEventId: event.id,
      tick: 5,
      receiverId: "observer",
      relation: "target",
      distance: 10,
      threshold: 200,
      heard: true,
      reason: "withinRange",
    };
    const interpretation: SpeechInterpretationEvent = {
      id: "interpretation-1",
      speechEventId: event.id,
      receptionEventId: reception.id,
      tick: 5,
      receiverId: "observer",
      intent: "invite",
      relation: "target",
      valence: "positive",
      intensity: 0.5,
      factors: [{ key: "intentBase", rawValue: 1, normalizedValue: 0.6, contribution: 0.6 }],
    };
    const effect: SpeechEffectEvent = {
      id: "effect-1",
      speechEventId: event.id,
      interpretationEventId: interpretation.id,
      receiverId: "observer",
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      occurredTick: 5,
      appliedTick: 5,
      dimension: "approachProbability",
      outputValue: 0.2,
      durationTicks: 5,
    };
    const activeEffect: SpeechActiveEffect = {
      id: "active-effect-1",
      speechEffectEventId: effect.id,
      speechEventId: event.id,
      speakerId: "helper",
      intent: "invite",
      receiverId: "observer",
      dimension: "approachProbability",
      startedAtTick: 5,
      expiresAtTick: 10,
      initialStrength: 0.2,
      currentStrength: 0.15,
      decay: "linear",
    };

    const state = makeState({
      agents: [observer, helper],
      speechLog: [event],
      speechReceptionLog: [reception],
      speechInterpretationLog: [interpretation],
      speechEffectLog: [effect],
      activeSpeechEffects: [activeEffect],
      tick: 7,
    });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.speechEffectDetails).toEqual([
      {
        speechEventId: event.id,
        reception,
        interpretation,
        effect,
        activeEffectStatus: {
          initialStrength: 0.2,
          currentStrength: 0.15,
          startedAtTick: 5,
          expiresAtTick: 10,
          remainingTicks: 3,
        },
      },
    ]);
  });

  it("leaves activeEffectStatus undefined once the active effect has expired/been replaced, while the effect record itself remains", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const event = createSpeechEvent({
      tick: 5,
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "observer",
    });
    const effect: SpeechEffectEvent = {
      id: "effect-1",
      speechEventId: event.id,
      interpretationEventId: "interpretation-1",
      receiverId: "observer",
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      occurredTick: 5,
      appliedTick: 5,
      dimension: "approachProbability",
      outputValue: 0.2,
      durationTicks: 5,
    };
    const state = makeState({
      agents: [observer],
      speechLog: [event],
      speechEffectLog: [effect],
      activeSpeechEffects: [],
      tick: 20,
    });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    expect(inspection.speechEffectDetails[0].effect).toEqual(effect);
    expect(inspection.speechEffectDetails[0].activeEffectStatus).toBeUndefined();
  });

  it("aggregates activeEffectSummaries by dimension via aggregateActiveEffects, keeping individual speechEventId contributions", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true });
    const activeEffect: SpeechActiveEffect = {
      id: "active-effect-1",
      speechEffectEventId: "effect-1",
      speechEventId: "speech-1",
      speakerId: "helper",
      intent: "invite",
      receiverId: "observer",
      dimension: "approachProbability",
      startedAtTick: 2,
      expiresAtTick: 10,
      initialStrength: 0.25,
      currentStrength: 0.2,
      decay: "linear",
    };
    const state = makeState({ agents: [observer], activeSpeechEffects: [activeEffect], tick: 4 });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    const expected = aggregateActiveEffects([activeEffect], "observer", "approachProbability", 4, undefined);
    expect(inspection.activeEffectSummaries).toEqual([expected]);
  });

  it("computes attractivenessScoreBeforeEffects as the score without Phase 3 speech effects", () => {
    const observer = makeAgent({ id: "observer", isObserverJoiner: true, x: 400, y: 260 });
    const candidate: GroupCandidate = {
      id: "group-1",
      x: 430,
      y: 260,
      memberIds: ["leader"],
      status: "forming",
      age: 1,
    };
    const activeEffect: SpeechActiveEffect = {
      id: "active-effect-1",
      speechEffectEventId: "effect-1",
      speechEventId: "speech-1",
      speakerId: "leader",
      intent: "welcome",
      receiverId: "observer",
      dimension: "attractiveness",
      targetGroupId: "group-1",
      startedAtTick: 0,
      expiresAtTick: 8,
      initialStrength: 0.3,
      currentStrength: 0.3,
      decay: "linear",
    };
    const state = makeState({
      agents: [observer],
      groupCandidates: [candidate],
      activeSpeechEffects: [activeEffect],
      tick: 0,
    });

    const [inspection] = buildObserverJoinerInspection(state, DEFAULT_PARAMS);

    const baseline = attractiveness(observer, candidate, state.agents, DEFAULT_PARAMS, undefined, 0);
    const withEffects = attractiveness(observer, candidate, state.agents, DEFAULT_PARAMS, undefined, 0, [activeEffect]);
    expect(inspection.attractivenessScoreBeforeEffects).toBe(baseline);
    expect(inspection.attractivenessScore).toBe(withEffects);
    expect(inspection.attractivenessScore).not.toBe(inspection.attractivenessScoreBeforeEffects);
  });
});
