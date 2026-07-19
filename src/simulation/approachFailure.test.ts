import { describe, expect, it } from "vitest";
import { stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import { afterPartyPolicy } from "./formationPolicy";
import type { Agent, GroupCandidate, SimulationState } from "./types";

/**
 * Issue #133 (Phase 2): 接近先の満員化による参加失敗・再探索・ストレス更新。
 * `groupCapacity.test.ts`(Issue #131: 容量の境界値そのもの)とは別に、ここでは
 * 満員化に伴う状態遷移(approaching -> undecided/"searchingAgain"相当)・構造化イベント
 * (approachTargetInvalidated/joinFailedCapacity/searchRestarted)・stress更新・
 * 決定順の再現性・再探索クールダウンを検証する。
 */

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

function stepOnce(state: SimulationState, params = DEFAULT_PARAMS, seed = 1): SimulationState {
  const rng = new SeededRandom(seed);
  return stepSimulation(state, params, rng);
}

describe("stepSimulation: approaching target becomes full before arrival (Issue #133)", () => {
  it("接近を中断してundecidedへ戻り、approachTargetInvalidated + searchRestartedを記録する", () => {
    const candidate = makeCandidate({
      id: "group-1",
      x: 700,
      y: 260,
      memberIds: ["member-0"],
      maxGroupSize: 1,
    });
    const agents: Agent[] = [
      makeAgent({ id: "member-0", state: "joined", joinedGroupId: "group-1", x: 700, y: 260 }),
      // JOIN_DISTANCE(26)より十分遠い位置に置き、この1tickでは到着しないようにする
      makeAgent({ id: "latecomer", state: "approaching", joinedGroupId: "group-1", x: 400, y: 260 }),
    ];
    const state: SimulationState = {
      tick: 5,
      agents,
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = stepOnce(state);
    const latecomer = next.agents.find((a) => a.id === "latecomer")!;

    expect(latecomer.state).toBe("undecided");
    expect(latecomer.joinedGroupId).toBeUndefined();
    expect(latecomer.lastFailedCandidateId).toBe("group-1");
    expect(latecomer.searchRestartCount).toBe(1);
    expect(latecomer.capacityFailureCount).toBe(1);

    const invalidatedEvent = next.log.find((e) => e.eventType === "approachTargetInvalidated");
    expect(invalidatedEvent).toBeDefined();
    expect(invalidatedEvent!.metadata?.reason).toBe("capacityFull");
    expect(invalidatedEvent!.metadata?.agentId).toBe("latecomer");
    expect(invalidatedEvent!.metadata?.groupId).toBe("group-1");
    expect(invalidatedEvent!.metadata?.memberCount).toBe(1);

    expect(next.log.some((e) => e.eventType === "searchRestarted" && e.metadata?.agentId === "latecomer")).toBe(true);
  });

  it("解散/期限切れによる無効化では追加stressを発生させない(既存挙動を維持)", () => {
    const candidate = makeCandidate({ id: "group-1", status: "expired", x: 700, y: 260 });
    const agents: Agent[] = [
      makeAgent({ id: "latecomer", state: "approaching", joinedGroupId: "group-1", x: 400, y: 260, stress: 0.2 }),
    ];
    const state: SimulationState = {
      tick: 5,
      agents,
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    const next = stepOnce(state);
    const latecomer = next.agents.find((a) => a.id === "latecomer")!;

    expect(latecomer.state).toBe("undecided");
    expect(latecomer.capacityFailureCount ?? 0).toBe(0);
    expect(latecomer.searchRestartCount).toBe(1);

    // 容量起因の追加stressは発生しないが、同一tick内でundecidedへ戻った直後に
    // 通常の曖昧さstress(step 7)は引き続き加算されるため、その分だけ増える
    const ambiguityIncrement = afterPartyPolicy.computeStressIncrement(latecomer, {
      hasWelcomingConfirmedGroup: false,
      ambiguityDuration: DEFAULT_PARAMS.ambiguityDuration,
      noDestinationStressMultiplier: 1,
    });
    expect(latecomer.stress).toBeCloseTo(0.2 + ambiguityIncrement, 6);

    const invalidatedEvent = next.log.find((e) => e.eventType === "approachTargetInvalidated");
    expect(invalidatedEvent?.metadata?.reason).toBe("groupExpired");
  });
});

describe("stepSimulation: 同一tick内で最後の1枠を複数agentが競う (Issue #133 受入条件)", () => {
  it("先にagents配列順で処理された側だけが参加し、もう一方はjoinFailedCapacityで再探索する", () => {
    const candidate = makeCandidate({
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["member-0"],
      maxGroupSize: 2,
    });
    const agents: Agent[] = [
      makeAgent({ id: "member-0", state: "joined", joinedGroupId: "group-1", x: 400, y: 260 }),
      makeAgent({ id: "agent-a", state: "approaching", joinedGroupId: "group-1", x: 405, y: 260 }),
      makeAgent({ id: "agent-b", state: "approaching", joinedGroupId: "group-1", x: 395, y: 260 }),
    ];
    const state: SimulationState = {
      tick: 5,
      agents,
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };
    const params = { ...DEFAULT_PARAMS, groupConfirmSize: 999 };

    const next = stepOnce(state, params);

    const a = next.agents.find((x) => x.id === "agent-a")!;
    const b = next.agents.find((x) => x.id === "agent-b")!;

    // agents配列順(agent-aが先)で処理されるため、agent-aが最後の1枠を取る
    expect(a.state).toBe("joined");
    expect(b.state).toBe("undecided");
    expect(b.capacityFailureCount).toBe(1);
    expect(b.searchRestartCount).toBe(1);
    // 容量起因の参加失敗stress(recordApproachFailure)に加え、同一tick内でundecidedへ戻った
    // 直後の通常の曖昧さstress(step 7)も引き続き加算される
    const capacityIncrement = afterPartyPolicy.computeJoinFailureStressIncrement(b, "capacityFull");
    const ambiguityIncrement = afterPartyPolicy.computeStressIncrement(b, {
      hasWelcomingConfirmedGroup: false,
      ambiguityDuration: params.ambiguityDuration,
      noDestinationStressMultiplier: 1,
    });
    expect(b.stress).toBeCloseTo(capacityIncrement + ambiguityIncrement, 6);

    const joinFailedEvent = next.log.find((e) => e.eventType === "joinFailedCapacity");
    expect(joinFailedEvent?.metadata?.agentId).toBe("agent-b");
    expect(joinFailedEvent?.metadata?.reason).toBe("capacityFull");

    const nextCandidate = next.groupCandidates.find((c) => c.id === "group-1")!;
    expect(nextCandidate.memberIds).toContain("agent-a");
    expect(nextCandidate.memberIds).not.toContain("agent-b");
    expect(nextCandidate.memberIds).toHaveLength(2);
  });

  it("決定順は配列順で決定的:配列順を入れ替えると勝者も入れ替わる(seed再現性)", () => {
    const candidate = makeCandidate({
      id: "group-1",
      x: 400,
      y: 260,
      memberIds: ["member-0"],
      maxGroupSize: 2,
    });
    const buildState = (order: [string, string]): SimulationState => ({
      tick: 5,
      agents: [
        makeAgent({ id: "member-0", state: "joined", joinedGroupId: "group-1", x: 400, y: 260 }),
        makeAgent({ id: order[0], state: "approaching", joinedGroupId: "group-1", x: 405, y: 260 }),
        makeAgent({ id: order[1], state: "approaching", joinedGroupId: "group-1", x: 395, y: 260 }),
      ],
      groupCandidates: [{ ...candidate, memberIds: [...candidate.memberIds] }],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    });
    const params = { ...DEFAULT_PARAMS, groupConfirmSize: 999 };

    const firstOrderResult = stepOnce(buildState(["agent-a", "agent-b"]), params);
    expect(firstOrderResult.agents.find((a) => a.id === "agent-a")!.state).toBe("joined");
    expect(firstOrderResult.agents.find((a) => a.id === "agent-b")!.state).toBe("undecided");

    const swappedOrderResult = stepOnce(buildState(["agent-b", "agent-a"]), params);
    expect(swappedOrderResult.agents.find((a) => a.id === "agent-b")!.state).toBe("joined");
    expect(swappedOrderResult.agents.find((a) => a.id === "agent-a")!.state).toBe("undecided");

    // 同じ入力を再実行しても同じ勝者になる(決定的)
    const repeatResult = stepOnce(buildState(["agent-a", "agent-b"]), params);
    expect(repeatResult.agents.find((a) => a.id === "agent-a")!.state).toBe("joined");
  });
});

describe("stepSimulation: 再探索クールダウン (Issue #133)", () => {
  it("クールダウン中は直前の失敗候補を再選択しない", () => {
    const candidate = makeCandidate({ id: "group-1", x: 405, y: 260, memberIds: [], maxGroupSize: 5 });
    const agent = makeAgent({
      id: "seeker",
      state: "undecided",
      x: 400,
      y: 260,
      willingness: 1,
      conformity: 1,
      influenceAvoidance: 0,
      lastFailedCandidateId: "group-1",
      lastFailedCandidateAtTick: 4,
    });
    const state: SimulationState = {
      tick: 5,
      agents: [agent],
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    // rng.chance(approachProbability)がtrueを返しやすいseedであっても、
    // クールダウン中はそもそも候補が見つからず接近判定自体が行われない
    const next = stepOnce(state, DEFAULT_PARAMS, 7);
    const seeker = next.agents.find((a) => a.id === "seeker")!;
    expect(seeker.state).toBe("undecided");
  });

  it("クールダウンが明けると再び同じ候補へ接近できる", () => {
    const candidate = makeCandidate({ id: "group-1", x: 405, y: 260, memberIds: [], maxGroupSize: 5 });
    const agent = makeAgent({
      id: "seeker",
      state: "undecided",
      x: 400,
      y: 260,
      willingness: 1,
      conformity: 1,
      influenceAvoidance: 0,
      lastFailedCandidateId: "group-1",
      lastFailedCandidateAtTick: 5,
    });
    const state: SimulationState = {
      tick: 500,
      agents: [agent],
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };

    // 候補がごく近い(距離5 < JOIN_DISTANCE)ため、接近を選んだ場合はその場で"approaching"を
    // 経由せず同一tick内に"joined"まで進むことがある。ここではクールダウンが明けて
    // 「再びこの候補への接近/合流を選べるようになった」ことだけを確認する
    let found = false;
    for (let seed = 1; seed <= 50 && !found; seed++) {
      const next = stepOnce(state, DEFAULT_PARAMS, seed);
      const seeker = next.agents.find((a) => a.id === "seeker")!;
      if (seeker.state === "approaching" || seeker.state === "joined") {
        found = true;
      }
    }
    expect(found).toBe(true);
  });
});

describe("stepSimulation: classroomPairシナリオでの最後の1枠競合 (Issue #133 受入条件)", () => {
  it("2人定員の最後の1枠へ複数agentが向かった場合、1人だけが参加し他は再探索する", () => {
    const candidate = makeCandidate({
      id: "pair-1",
      x: 400,
      y: 260,
      memberIds: ["founder"],
      minGroupSize: 2,
      maxGroupSize: 2,
    });
    const agents: Agent[] = [
      makeAgent({ id: "founder", state: "forming", x: 400, y: 260 }),
      makeAgent({ id: "agent-a", state: "approaching", joinedGroupId: "pair-1", x: 405, y: 260 }),
      makeAgent({ id: "agent-b", state: "approaching", joinedGroupId: "pair-1", x: 395, y: 260 }),
    ];
    const state: SimulationState = {
      tick: 5,
      agents,
      groupCandidates: [candidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
      formationScenarioId: "classroomPair",
    };

    const next = stepOnce(state);

    const a = next.agents.find((x) => x.id === "agent-a")!;
    const b = next.agents.find((x) => x.id === "agent-b")!;
    const joinedCount = [a.state, b.state].filter((s) => s === "joined").length;
    const undecidedCount = [a.state, b.state].filter((s) => s === "undecided").length;

    expect(joinedCount).toBe(1);
    expect(undecidedCount).toBe(1);
    // classroomPairではcanLeaveが常にfalseなので、失敗した側もleaving/leftにはならない
    expect(a.state === "leaving" || a.state === "left").toBe(false);
    expect(b.state === "leaving" || b.state === "left").toBe(false);
    expect(next.log.find((entry) => entry.eventType === "joinFailedCapacity")?.message).toContain(
      "ペア候補 pair-1",
    );
    expect(next.log.find((entry) => entry.eventType === "groupConfirmed")?.message).toContain(
      "ペア候補 pair-1",
    );
  });
});
