import { describe, expect, it } from "vitest";
import {
  afterPartyPolicy,
  getFormationPolicyById,
  resolveFormationPolicy,
} from "./formationPolicy";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS, getPresetById } from "./presets";
import type { Agent, GroupCandidate } from "./types";

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

describe("formationPolicy: resolution", () => {
  it("resolves to afterParty when no options are given (backward compatibility default)", () => {
    expect(resolveFormationPolicy()).toBe(afterPartyPolicy);
  });

  it("resolves afterParty by explicit scenarioId", () => {
    expect(resolveFormationPolicy({ scenarioId: "afterParty" })).toBe(afterPartyPolicy);
    expect(getFormationPolicyById("afterParty")).toBe(afterPartyPolicy);
  });
});

describe("afterPartyPolicy.evaluateCandidateInitiation (責務1: 候補作成条件)", () => {
  it("never makes an observerJoiner eligible to initiate a candidate", () => {
    const agent = makeAgent({ isObserverJoiner: true, initiative: 1 });
    const decision = afterPartyPolicy.evaluateCandidateInitiation(agent, {
      agents: [agent],
      params: DEFAULT_PARAMS,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.probability).toBe(0);
  });

  it("is ineligible when initiative is low and no clique is ready nearby", () => {
    const agent = makeAgent({ initiative: 0.2, cliqueId: undefined });
    const decision = afterPartyPolicy.evaluateCandidateInitiation(agent, {
      agents: [agent],
      params: DEFAULT_PARAMS,
    });
    expect(decision.eligible).toBe(false);
  });

  it("is eligible via initiative and reports hasInitiative for the caller's log branching", () => {
    const agent = makeAgent({ initiative: 0.8, willingness: 0.9 });
    const params = { ...DEFAULT_PARAMS, numLeaders: 1 };
    const decision = afterPartyPolicy.evaluateCandidateInitiation(agent, { agents: [agent], params });
    expect(decision.eligible).toBe(true);
    expect(decision.hasInitiative).toBe(true);
    expect(decision.probability).toBeCloseTo(0.9 * 0.8 * 0.08 * (1 + 1 * 0.15), 10);
  });

  it("is eligible via a ready clique even without personal initiative", () => {
    const founder = makeAgent({ id: "founder", initiative: 0.1, cliqueId: 1, x: 100, y: 100 });
    const mate1 = makeAgent({ id: "mate1", cliqueId: 1, x: 105, y: 100 });
    const mate2 = makeAgent({ id: "mate2", cliqueId: 1, x: 95, y: 100 });
    const params = { ...DEFAULT_PARAMS, existingTieStrength: 0.9 };
    const decision = afterPartyPolicy.evaluateCandidateInitiation(founder, {
      agents: [founder, mate1, mate2],
      params,
    });
    expect(decision.eligible).toBe(true);
    expect(decision.hasInitiative).toBe(false);
    expect(decision.probability).toBeCloseTo(0.9 * 0.1, 10);
  });

  it("requires existingTieStrength above 0.5 for clique readiness", () => {
    const founder = makeAgent({ id: "founder", initiative: 0.1, cliqueId: 1, x: 100, y: 100 });
    const mate1 = makeAgent({ id: "mate1", cliqueId: 1, x: 105, y: 100 });
    const mate2 = makeAgent({ id: "mate2", cliqueId: 1, x: 95, y: 100 });
    const params = { ...DEFAULT_PARAMS, existingTieStrength: 0.4 };
    const decision = afterPartyPolicy.evaluateCandidateInitiation(founder, {
      agents: [founder, mate1, mate2],
      params,
    });
    expect(decision.eligible).toBe(false);
  });
});

describe("afterPartyPolicy.approachRateMultiplier (責務2: 接近確率の基礎倍率)", () => {
  it("is a fixed constant the caller multiplies the attractiveness score by", () => {
    expect(afterPartyPolicy.approachRateMultiplier).toBe(0.35);
  });
});

describe("afterPartyPolicy.shouldConfirmCandidate (責務3: 成立条件)", () => {
  it("confirms once nearbyCount reaches groupConfirmSize", () => {
    const params = { ...DEFAULT_PARAMS, groupConfirmSize: 3 };
    expect(afterPartyPolicy.shouldConfirmCandidate(2, params)).toBe(false);
    expect(afterPartyPolicy.shouldConfirmCandidate(3, params)).toBe(true);
    expect(afterPartyPolicy.shouldConfirmCandidate(4, params)).toBe(true);
  });
});

describe("afterPartyPolicy.evaluateUnconfirmedCandidateLifecycle (責務3: 解散/期限切れ条件)", () => {
  function makeCandidate(overrides: Partial<GroupCandidate>): GroupCandidate {
    return {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["founder"],
      status: "forming",
      age: 0,
      ...overrides,
    };
  }

  it("dissolves a weakly-responded candidate (founder only) past the weak-response age", () => {
    const candidate = makeCandidate({ memberIds: ["founder"], age: 15 });
    const outcome = afterPartyPolicy.evaluateUnconfirmedCandidateLifecycle(candidate, {
      weakResponseAge: 15,
      maxAge: 40,
    });
    expect(outcome).toBe("dissolve");
  });

  it("does not dissolve a public meeting point candidate for weak response", () => {
    const candidate = makeCandidate({ memberIds: [], age: 15, isPublicMeetingPoint: true });
    const outcome = afterPartyPolicy.evaluateUnconfirmedCandidateLifecycle(candidate, {
      weakResponseAge: 15,
      maxAge: 40,
    });
    expect(outcome).not.toBe("dissolve");
  });

  it("expires a candidate with enough members once it reaches max age", () => {
    const candidate = makeCandidate({ memberIds: ["founder", "member-2"], age: 40 });
    const outcome = afterPartyPolicy.evaluateUnconfirmedCandidateLifecycle(candidate, {
      weakResponseAge: 15,
      maxAge: 40,
    });
    expect(outcome).toBe("expire");
  });

  it("continues when neither threshold is reached", () => {
    const candidate = makeCandidate({ memberIds: ["founder", "member-2"], age: 5 });
    const outcome = afterPartyPolicy.evaluateUnconfirmedCandidateLifecycle(candidate, {
      weakResponseAge: 15,
      maxAge: 40,
    });
    expect(outcome).toBe("continue");
  });
});

describe("afterPartyPolicy stress accumulation and canLeave (責務4: 退出条件)", () => {
  it("gives observerJoiner extra stress only when there is no welcoming confirmed group", () => {
    const observer = makeAgent({ isObserverJoiner: true, willingness: 0.9, influenceAvoidance: 0.8 });
    const withoutWelcome = afterPartyPolicy.computeStressIncrement(observer, {
      hasWelcomingConfirmedGroup: false,
      ambiguityDuration: 1,
      noDestinationStressMultiplier: 1,
    });
    const withWelcome = afterPartyPolicy.computeStressIncrement(observer, {
      hasWelcomingConfirmedGroup: true,
      ambiguityDuration: 1,
      noDestinationStressMultiplier: 1,
    });
    expect(withoutWelcome).toBeGreaterThan(withWelcome);
  });

  it("does not give the extra stress to non-observerJoiner agents", () => {
    const agent = makeAgent({ isObserverJoiner: false, willingness: 0.9, influenceAvoidance: 0.8 });
    const withoutWelcome = afterPartyPolicy.computeStressIncrement(agent, {
      hasWelcomingConfirmedGroup: false,
      ambiguityDuration: 1,
      noDestinationStressMultiplier: 1,
    });
    const withWelcome = afterPartyPolicy.computeStressIncrement(agent, {
      hasWelcomingConfirmedGroup: true,
      ambiguityDuration: 1,
      noDestinationStressMultiplier: 1,
    });
    expect(withoutWelcome).toBeCloseTo(withWelcome, 10);
  });

  it("canLeave gates on stress exceeding the effective leave threshold", () => {
    const agent = makeAgent({ leaveThreshold: 0.5 });
    expect(afterPartyPolicy.canLeave(agent, 0.5, 0.5)).toBe(false);
    expect(afterPartyPolicy.canLeave(agent, 0.51, 0.5)).toBe(true);
  });
});

describe("afterPartyPolicy.isFinished (責務5: 終了条件)", () => {
  it("is finished once every agent has settled (joined or left)", () => {
    const agents = [makeAgent({ id: "a", state: "joined" }), makeAgent({ id: "b", state: "left" })];
    expect(afterPartyPolicy.isFinished(agents, 10)).toBe(true);
  });

  it("is not finished while any agent is still undecided/forming/approaching/leaving, before the tick cap", () => {
    const agents = [makeAgent({ id: "a", state: "undecided" })];
    expect(afterPartyPolicy.isFinished(agents, 10)).toBe(false);
  });

  it("force-finishes at the safety tick cap regardless of agent states", () => {
    const agents = [makeAgent({ id: "a", state: "undecided" })];
    expect(afterPartyPolicy.isFinished(agents, 400)).toBe(true);
  });
});

describe("engine wiring: formation policy persists through state across ticks", () => {
  it("createInitialState defaults formationScenarioId to afterParty for backward compatibility", () => {
    const state = createInitialState(1, DEFAULT_PARAMS);
    expect(state.formationScenarioId).toBe("afterParty");
  });

  it("stepSimulation keeps formationScenarioId set even when the caller omits the argument every tick", () => {
    const rng = new SeededRandom(42);
    let state = createInitialState(42, getPresetById("natural").params);
    for (let i = 0; i < 10; i++) {
      state = stepSimulation(state, getPresetById("natural").params, rng);
      expect(state.formationScenarioId).toBe("afterParty");
    }
  });
});
