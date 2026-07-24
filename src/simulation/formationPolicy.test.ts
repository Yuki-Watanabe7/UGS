import { describe, expect, it } from "vitest";
import {
  afterPartyPolicy,
  DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK,
  getFormationPolicyById,
  resolveFormationPolicy,
  standingPartyPolicy,
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
    expect(afterPartyPolicy.finishReason(agents, 10)).toBe("allSettled");
  });

  it("is not finished while any agent is still undecided/forming/approaching/leaving, before the tick cap", () => {
    const agents = [makeAgent({ id: "a", state: "undecided" })];
    expect(afterPartyPolicy.isFinished(agents, 10)).toBe(false);
    expect(afterPartyPolicy.finishReason(agents, 10)).toBeUndefined();
  });

  it("force-finishes at the safety tick cap regardless of agent states", () => {
    const agents = [makeAgent({ id: "a", state: "undecided" })];
    expect(afterPartyPolicy.isFinished(agents, 400)).toBe(true);
    expect(afterPartyPolicy.finishReason(agents, 400)).toBe("maxTicksReached");
  });
});

describe("afterPartyPolicy.resolveGroupCapacity (責務6: 容量制約, Issue #131)", () => {
  function makeCandidate(overrides: Partial<GroupCandidate>): GroupCandidate {
    return {
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: [],
      status: "forming",
      age: 0,
      ...overrides,
    };
  }

  it("既定では成立最小人数=groupConfirmSize・収容最大人数=実質無制限を返す(既存二次会ポリシーとの後方互換)", () => {
    const candidate = makeCandidate({});
    const params = { ...DEFAULT_PARAMS, groupConfirmSize: 3 };
    const capacity = afterPartyPolicy.resolveGroupCapacity(candidate, params);
    expect(capacity.minGroupSize).toBe(3);
    expect(capacity.maxGroupSize).toBe(Number.POSITIVE_INFINITY);
  });

  it("候補固有のminGroupSize/maxGroupSizeオーバーライドを優先し、異なる値を表現できる", () => {
    const candidate = makeCandidate({ minGroupSize: 2, maxGroupSize: 6 });
    const capacity = afterPartyPolicy.resolveGroupCapacity(candidate, { ...DEFAULT_PARAMS, groupConfirmSize: 3 });
    expect(capacity.minGroupSize).toBe(2);
    expect(capacity.maxGroupSize).toBe(6);
    expect(capacity.minGroupSize).not.toBe(capacity.maxGroupSize);
  });
});

describe("afterPartyPolicy.evaluateClusterDeparture (責務9: クラスタ離脱判定, Issue #176)", () => {
  it("always returns ineligible with probability 0, regardless of ticksInCluster (受入条件: 既存挙動に回帰がない)", () => {
    const agent = makeAgent({ state: "joined" });
    const candidate: GroupCandidate = { id: "group-1", x: 0, y: 0, memberIds: [agent.id], status: "confirmed", age: 0 };
    for (const ticksInCluster of [0, 1, 14, 15, 16, 1000]) {
      const decision = afterPartyPolicy.evaluateClusterDeparture(agent, candidate, {
        ticksInCluster,
        memberCount: candidate.memberIds.length,
        tick: 100,
      });
      expect(decision).toEqual({ eligible: false, probability: 0 });
    }
  });
});

describe("afterPartyPolicy.computeJoinFailureStressIncrement (責務8: 参加失敗stress, Issue #133)", () => {
  it("満員(capacityFull)が理由の場合のみ正のstress増分を返す", () => {
    const agent = makeAgent({ willingness: 0.8 });
    expect(afterPartyPolicy.computeJoinFailureStressIncrement(agent, "capacityFull")).toBeGreaterThan(0);
  });

  it("消滅/期限切れ/消失が理由の場合は追加stressを発生させない(既存挙動を維持)", () => {
    const agent = makeAgent({ willingness: 0.8 });
    expect(afterPartyPolicy.computeJoinFailureStressIncrement(agent, "groupDissolved")).toBe(0);
    expect(afterPartyPolicy.computeJoinFailureStressIncrement(agent, "groupExpired")).toBe(0);
    expect(afterPartyPolicy.computeJoinFailureStressIncrement(agent, "groupMissing")).toBe(0);
  });

  it("willingnessが高いほど増分が大きい", () => {
    const low = makeAgent({ willingness: 0.2 });
    const high = makeAgent({ willingness: 0.9 });
    expect(afterPartyPolicy.computeJoinFailureStressIncrement(high, "capacityFull")).toBeGreaterThan(
      afterPartyPolicy.computeJoinFailureStressIncrement(low, "capacityFull"),
    );
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

describe("standingPartyPolicy (Issue #174, Phase 1)", () => {
  it("resolves via resolveFormationPolicy/getFormationPolicyById with id 'standingParty', distinct from afterPartyPolicy", () => {
    expect(resolveFormationPolicy({ scenarioId: "standingParty" })).toBe(standingPartyPolicy);
    expect(getFormationPolicyById("standingParty")).toBe(standingPartyPolicy);
    expect(standingPartyPolicy.id).toBe("standingParty");
    // 受入条件: 未実装の後続機能をafterPartyの挙動へ黙ってaliasしない
    // (=同一オブジェクト参照ではなく、idの異なる独立したFormationPolicy実装であること)
    expect(standingPartyPolicy).not.toBe(afterPartyPolicy);
  });

  it("createInitialState/stepSimulation keep formationScenarioId as standingParty across ticks (never falls back to afterParty/classroomPair)", () => {
    const preset = getPresetById("standing-party");
    expect(preset.formationScenarioId).toBe("standingParty");

    const formation = { scenarioId: "standingParty" as const };
    const rng = new SeededRandom(7);
    let state = createInitialState(7, preset.params, { interventionId: "none" }, undefined, undefined, undefined, undefined, formation);
    expect(state.formationScenarioId).toBe("standingParty");

    for (let i = 0; i < 20; i++) {
      // 呼び出し側が毎tick formation を渡し忘れても直前の設定を引き継ぐ(既存のfall backパターン)
      state = stepSimulation(state, preset.params, rng);
      expect(state.formationScenarioId).toBe("standingParty");
    }
  });

  it("shares afterParty's core formation mechanics in Phase 1 (candidate initiation, confirmation, lifecycle, stress, capacity)", () => {
    const agent = makeAgent({ initiative: 0.8, willingness: 0.9 });
    const params = { ...DEFAULT_PARAMS, numLeaders: 1 };
    expect(standingPartyPolicy.evaluateCandidateInitiation(agent, { agents: [agent], params })).toEqual(
      afterPartyPolicy.evaluateCandidateInitiation(agent, { agents: [agent], params }),
    );
    expect(standingPartyPolicy.shouldConfirmCandidate(3, DEFAULT_PARAMS)).toBe(
      afterPartyPolicy.shouldConfirmCandidate(3, DEFAULT_PARAMS),
    );
    const candidate: GroupCandidate = { id: "group-1", x: 0, y: 0, memberIds: ["a"], status: "forming", age: 0 };
    expect(standingPartyPolicy.resolveGroupCapacity(candidate, DEFAULT_PARAMS)).toEqual(
      afterPartyPolicy.resolveGroupCapacity(candidate, DEFAULT_PARAMS),
    );
  });

  it("isFinished/finishReason (Issue #175: 責務5) never naturally finishes, regardless of agent states or tick", () => {
    // 受入条件: 全員がいずれかの会話クラスタに所属しても終了しない
    const settled = [makeAgent({ id: "a", state: "joined" }), makeAgent({ id: "b", state: "left" })];
    expect(standingPartyPolicy.isFinished(settled, 3)).toBe(false);
    expect(standingPartyPolicy.finishReason(settled, 3)).toBeUndefined();

    // 受入条件: afterPartyのMAX_SIMULATION_TICKS(400)相当のtickに達しても、それ自体では終了しない
    const undecided = [makeAgent({ id: "a", state: "undecided" })];
    expect(standingPartyPolicy.isFinished(undecided, 399)).toBe(false);
    expect(standingPartyPolicy.isFinished(undecided, 400)).toBe(false);
    expect(standingPartyPolicy.finishReason(undecided, 400)).toBeUndefined();
    expect(standingPartyPolicy.isFinished(undecided, 100_000)).toBe(false);
    expect(standingPartyPolicy.finishReason(undecided, 100_000)).toBeUndefined();

    // 受入条件: エージェントが0人(cluster/参加者が誰もいない)でも終了しない
    expect(standingPartyPolicy.isFinished([], 3)).toBe(false);
    expect(standingPartyPolicy.finishReason([], 3)).toBeUndefined();
  });

  describe("evaluateClusterDeparture (責務9: クラスタ離脱判定, Issue #176)", () => {
    const agent = makeAgent({ state: "joined" });
    const candidate: GroupCandidate = { id: "group-1", x: 0, y: 0, memberIds: [agent.id], status: "confirmed", age: 0 };

    it("is ineligible below the provisional minimum stay duration (暫定ルール: 最低滞在tick未満)", () => {
      for (const ticksInCluster of [0, 1, 5, 14]) {
        const decision = standingPartyPolicy.evaluateClusterDeparture(agent, candidate, {
          ticksInCluster,
          memberCount: 1,
          tick: 100,
        });
        expect(decision).toEqual({ eligible: false, probability: 0 });
      }
    });

    it("becomes eligible with a fixed provisional probability at/after the minimum stay duration", () => {
      for (const ticksInCluster of [15, 16, 100, 10_000]) {
        const decision = standingPartyPolicy.evaluateClusterDeparture(agent, candidate, {
          ticksInCluster,
          memberCount: 1,
          tick: 100,
        });
        expect(decision.eligible).toBe(true);
        expect(decision.probability).toBeGreaterThan(0);
        expect(decision.probability).toBeLessThan(1);
      }
    });

    it("does not depend on agent personality traits (暫定ルール: agent特性の現実的解釈を先取りしない)", () => {
      const observerJoiner = makeAgent({ id: "b", state: "joined", isObserverJoiner: true, willingness: 0.01, conformity: 0.01 });
      const eager = makeAgent({ id: "c", state: "joined", isObserverJoiner: false, willingness: 0.99, conformity: 0.99 });
      const ctx = { ticksInCluster: 50, memberCount: 1, tick: 100 };
      expect(standingPartyPolicy.evaluateClusterDeparture(observerJoiner, candidate, ctx)).toEqual(
        standingPartyPolicy.evaluateClusterDeparture(eager, candidate, ctx),
      );
    });
  });
});

describe("classroomPairPolicy (Issue #132, Phase 2)", () => {
  const classroomPolicy = getFormationPolicyById("classroomPair");

  it("resolves via resolveFormationPolicy/getFormationPolicyById with id 'classroomPair'", () => {
    expect(classroomPolicy.id).toBe("classroomPair");
    expect(resolveFormationPolicy({ scenarioId: "classroomPair" }).id).toBe("classroomPair");
  });

  describe("evaluateCandidateInitiation (責務1)", () => {
    it("never makes an observerJoiner eligible to initiate a pair search", () => {
      const agent = makeAgent({ isObserverJoiner: true, initiative: 1, willingness: 1 });
      const decision = classroomPolicy.evaluateCandidateInitiation(agent, { agents: [agent], params: DEFAULT_PARAMS });
      expect(decision.eligible).toBe(false);
      expect(decision.probability).toBe(0);
    });

    it("makes a non-observerJoiner eligible even with low initiative (teacher-instructed, not leader-gated)", () => {
      const agent = makeAgent({ isObserverJoiner: false, initiative: 0.1, willingness: 0.5 });
      const decision = classroomPolicy.evaluateCandidateInitiation(agent, { agents: [agent], params: DEFAULT_PARAMS });
      expect(decision.eligible).toBe(true);
      expect(decision.probability).toBeGreaterThan(0);
      expect(decision.hasInitiative).toBe(false);
    });
  });

  describe("shouldConfirmCandidate / computeConfirmationCount (責務3/7)", () => {
    it("confirms once exactly 2 have gathered, fixed regardless of params.groupConfirmSize", () => {
      const params = { ...DEFAULT_PARAMS, groupConfirmSize: 5 };
      expect(classroomPolicy.shouldConfirmCandidate(1, params)).toBe(false);
      expect(classroomPolicy.shouldConfirmCandidate(2, params)).toBe(true);
    });

    it("counts strictly by candidate.memberIds.length, ignoring nearby non-members", () => {
      const candidate: GroupCandidate = {
        id: "pair-1",
        x: 400,
        y: 260,
        memberIds: ["founder"],
        status: "forming",
        age: 0,
      };
      // 近くをたまたま通りかかっただけの無関係なエージェントは数に入らない
      const bystander = makeAgent({ id: "bystander", state: "approaching", x: 405, y: 260 });
      expect(classroomPolicy.computeConfirmationCount(candidate, [bystander])).toBe(1);
    });
  });

  describe("resolveGroupCapacity (責務6)", () => {
    it("defaults to a fixed pair (min=max=2)", () => {
      const candidate: GroupCandidate = { id: "pair-1", x: 0, y: 0, memberIds: [], status: "forming", age: 0 };
      const capacity = classroomPolicy.resolveGroupCapacity(candidate, DEFAULT_PARAMS);
      expect(capacity).toEqual({ minGroupSize: 2, maxGroupSize: 2 });
    });
  });

  describe("canLeave (責務4, 受入条件: leave/leftへ遷移しない)", () => {
    it("is always false regardless of stress or threshold", () => {
      const agent = makeAgent({ leaveThreshold: 0.1 });
      expect(classroomPolicy.canLeave(agent, 1, 0)).toBe(false);
      expect(classroomPolicy.canLeave(agent, 0, 1)).toBe(false);
    });
  });

  describe("evaluateClusterDeparture (責務9, Issue #176 受入条件: 学校シナリオでは引き続き離脱が発生しない)", () => {
    it("is always ineligible regardless of ticksInCluster", () => {
      const agent = makeAgent({ state: "joined" });
      const candidate: GroupCandidate = { id: "pair-1", x: 0, y: 0, memberIds: [agent.id], status: "confirmed", age: 0 };
      for (const ticksInCluster of [0, 15, 1000]) {
        expect(
          classroomPolicy.evaluateClusterDeparture(agent, candidate, { ticksInCluster, memberCount: 1, tick: 100 }),
        ).toEqual({ eligible: false, probability: 0 });
      }
    });
  });

  describe("isFinished (責務5)", () => {
    it("finishes once every agent is joined, even before the deadline tick", () => {
      const agents = [makeAgent({ id: "a", state: "joined" }), makeAgent({ id: "b", state: "joined" })];
      expect(classroomPolicy.isFinished(agents, 3)).toBe(true);
      expect(classroomPolicy.finishReason(agents, 3)).toBe("allAssigned");
    });

    it("is not finished while any agent is unmatched, before the deadline tick", () => {
      const agents = [makeAgent({ id: "a", state: "joined" }), makeAgent({ id: "b", state: "undecided" })];
      expect(classroomPolicy.isFinished(agents, 3)).toBe(false);
      expect(classroomPolicy.finishReason(agents, 3)).toBeUndefined();
    });

    it("force-finishes at the configured deadline tick with deadlineReached", () => {
      const agents = [makeAgent({ id: "a", state: "joined" }), makeAgent({ id: "b", state: "undecided" })];
      expect(classroomPolicy.isFinished(agents, DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK)).toBe(true);
      expect(classroomPolicy.finishReason(agents, DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK)).toBe("deadlineReached");
    });

    it("uses a caller-supplied formationDeadlineTick instead of the default", () => {
      const shortDeadlinePolicy = getFormationPolicyById("classroomPair", 5);
      const agents = [makeAgent({ id: "a", state: "undecided" })];
      expect(shortDeadlinePolicy.isFinished(agents, 4)).toBe(false);
      expect(shortDeadlinePolicy.isFinished(agents, 5)).toBe(true);
      expect(shortDeadlinePolicy.finishReason(agents, 5)).toBe("deadlineReached");
    });
  });

  describe("computeJoinFailureStressIncrement (責務8, Issue #133)", () => {
    it("最後の1枠を逃した(capacityFull)場合のみ追加stressを発生させる", () => {
      const agent = makeAgent({ willingness: 0.7 });
      expect(classroomPolicy.computeJoinFailureStressIncrement(agent, "capacityFull")).toBeGreaterThan(0);
      expect(classroomPolicy.computeJoinFailureStressIncrement(agent, "groupDissolved")).toBe(0);
      expect(classroomPolicy.computeJoinFailureStressIncrement(agent, "groupExpired")).toBe(0);
      expect(classroomPolicy.computeJoinFailureStressIncrement(agent, "groupMissing")).toBe(0);
    });
  });
});
