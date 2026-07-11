import { describe, expect, it } from "vitest";
import { buildObserverJoinerInspection } from "./inspection";
import { attractiveness } from "./engine";
import { createSpeechEvent } from "./speech";
import { DEFAULT_PARAMS } from "./presets";
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
