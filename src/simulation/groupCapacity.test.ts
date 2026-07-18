import { describe, expect, it } from "vitest";
import { isCandidateFull, isJoinable, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { DEFAULT_PARAMS } from "./presets";
import type { Agent, GroupCandidate, SimulationState } from "./types";

/**
 * Issue #131: GroupCandidateの最小人数・最大人数・満員判定の境界値テスト。
 * `formationPolicy.test.ts`の`resolveGroupCapacity`単体テストとは別に、実際に
 * `stepSimulation`を通した合流/核形成マージが容量を超えないことを確認する。
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

describe("isCandidateFull / isJoinable: 容量込みの満員判定 (Issue #131)", () => {
  it("memberIds.length >= maxGroupSizeで満員とみなす", () => {
    const candidate = makeCandidate({ memberIds: ["a", "b"] });
    expect(isCandidateFull(candidate, { minGroupSize: 1, maxGroupSize: 2 })).toBe(true);
    expect(isCandidateFull(candidate, { minGroupSize: 1, maxGroupSize: 3 })).toBe(false);
  });

  it("isJoinableはcapacityを渡すと満員の候補をjoinable扱いしない", () => {
    const candidate = makeCandidate({ status: "forming", memberIds: ["a", "b"] });
    expect(isJoinable(candidate, { minGroupSize: 1, maxGroupSize: 2 })).toBe(false);
    expect(isJoinable(candidate, { minGroupSize: 1, maxGroupSize: 3 })).toBe(true);
  });

  it("capacityを省略した場合は従来どおり状態のみで判定する(既存呼び出し元との後方互換)", () => {
    const fullCandidate = makeCandidate({ status: "forming", memberIds: ["a", "b"] });
    expect(isJoinable(fullCandidate)).toBe(true);
    const dissolvedCandidate = makeCandidate({ status: "dissolved" });
    expect(isJoinable(dissolvedCandidate)).toBe(false);
  });
});

describe("stepSimulation: 満員のグループ候補には新規参加できない (Issue #131 受入条件)", () => {
  it("2人定員の候補へ3人目を追加できない", () => {
    const candidate = makeCandidate({
      id: "group-1",
      memberIds: ["member-0", "member-1"],
      maxGroupSize: 2,
    });
    const agents: Agent[] = [
      makeAgent({ id: "member-0", state: "joined", joinedGroupId: "group-1" }),
      makeAgent({ id: "member-1", state: "joined", joinedGroupId: "group-1", x: 405 }),
      makeAgent({ id: "newcomer", state: "approaching", joinedGroupId: "group-1" }),
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

    const nextCandidate = next.groupCandidates.find((c) => c.id === "group-1")!;
    expect(nextCandidate.memberIds).not.toContain("newcomer");
    expect(nextCandidate.memberIds).toHaveLength(2);
    const newcomer = next.agents.find((a) => a.id === "newcomer")!;
    expect(newcomer.state).not.toBe("joined");
  });

  it("4人定員の候補は1〜3人時点では参加可能、4人時点で参加不可となる", () => {
    for (const existingCount of [1, 2, 3, 4]) {
      const existingMembers = Array.from({ length: existingCount }, (_, i) => `member-${i}`);
      const candidate = makeCandidate({
        id: "group-1",
        memberIds: existingMembers,
        maxGroupSize: 4,
      });
      const agents: Agent[] = [
        ...existingMembers.map((id) => makeAgent({ id, state: "joined", joinedGroupId: "group-1" })),
        makeAgent({ id: "newcomer", state: "approaching", joinedGroupId: "group-1" }),
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
      const newcomer = next.agents.find((a) => a.id === "newcomer")!;
      const nextCandidate = next.groupCandidates.find((c) => c.id === "group-1")!;

      if (existingCount < 4) {
        expect(newcomer.state, `existingCount=${existingCount}`).toBe("joined");
        expect(nextCandidate.memberIds, `existingCount=${existingCount}`).toContain("newcomer");
      } else {
        expect(newcomer.state, `existingCount=${existingCount}`).not.toBe("joined");
        expect(nextCandidate.memberIds, `existingCount=${existingCount}`).not.toContain("newcomer");
      }
    }
  });

  it("既存二次会ポリシー(maxGroupSize未指定)では実質無制限に参加できる(既存挙動を維持)", () => {
    const existingMembers = Array.from({ length: 5 }, (_, i) => `member-${i}`);
    const candidate = makeCandidate({ id: "group-1", memberIds: existingMembers });
    const agents: Agent[] = [
      ...existingMembers.map((id) => makeAgent({ id, state: "joined", joinedGroupId: "group-1" })),
      makeAgent({ id: "newcomer", state: "approaching", joinedGroupId: "group-1" }),
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

    expect(next.agents.find((a) => a.id === "newcomer")!.state).toBe("joined");
    expect(next.groupCandidates.find((c) => c.id === "group-1")!.memberIds).toContain("newcomer");
  });
});

describe("stepSimulation: 候補マージでも最大人数を超えない (Issue #131 受入条件)", () => {
  it("核形成時、併合先の既存forming候補が満員なら合流せず新しい候補を作る", () => {
    const fullCandidate = makeCandidate({
      id: "existing-group",
      memberIds: ["founder", "member-1"],
      maxGroupSize: 2,
    });
    const founder = makeAgent({ id: "founder", state: "forming", initiative: 1, willingness: 1 });
    const member1 = makeAgent({ id: "member-1", state: "forming", x: 405 });
    // 併合半径(candidateMergeRadius=40)内かつ、numLeadersを大きくして核形成確率を1超に
    // 押し上げることで、rng.chance(...)の結果に依存せず決定的に核形成を発生させる。
    const newLeader = makeAgent({ id: "new-leader", state: "undecided", initiative: 1, willingness: 1, x: 410 });
    const agents: Agent[] = [founder, member1, newLeader];
    const state: SimulationState = {
      tick: 5,
      agents,
      groupCandidates: [fullCandidate],
      log: [],
      width: 800,
      height: 520,
      finished: false,
    };
    const params = { ...DEFAULT_PARAMS, numLeaders: 100, groupConfirmSize: 999 };

    const next = stepOnce(state, params);

    const existingAfter = next.groupCandidates.find((c) => c.id === "existing-group")!;
    expect(existingAfter.memberIds).toEqual(["founder", "member-1"]);

    const newLeaderAgent = next.agents.find((a) => a.id === "new-leader")!;
    expect(newLeaderAgent.state).toBe("forming");
    const newCandidate = next.groupCandidates.find((c) => c.id !== "existing-group");
    expect(newCandidate?.memberIds).toContain("new-leader");
  });
});
