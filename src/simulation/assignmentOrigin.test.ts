import { describe, expect, it } from "vitest";
import { buildLowPressureInterventionFunnel, deriveAssignmentOrigins, summarizeAssignmentOrigins } from "./assignmentOrigin";
import type { Agent, LogEntry, SimulationState } from "./types";

/**
 * Issue #170: agentごとの所属起源(`AssignmentOrigin`)・低圧介入ファネルの導出テスト。
 * `pairFormation.test.ts`と同じ手法(手組みの`SimulationState`/`Agent`と構造化イベントのみから検証)。
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

function approachEntry(tick: number, agentId: string, groupId: string): LogEntry {
  return {
    tick,
    message: `${agentId} approached ${groupId}`,
    tags: [],
    eventType: "agentApproached",
    metadata: { agentId, groupId },
  };
}

describe("deriveAssignmentOrigins: 介入なし/自然形成", () => {
  it("joinedなagentは常にnaturalになる", () => {
    const agents = [makeAgent({ id: "a", state: "joined", joinedGroupId: "g1" })];
    const state = makeState({ agents, log: [approachEntry(3, "a", "g1")] });
    expect(deriveAssignmentOrigins(state)).toEqual({ a: "natural" });
  });

  it("joinedでないagentは結果に含まれない", () => {
    const agents = [makeAgent({ id: "a", state: "undecided" })];
    const state = makeState({ agents });
    expect(deriveAssignmentOrigins(state)).toEqual({});
  });
});

describe("deriveAssignmentOrigins: teacher-deadline-assignment", () => {
  it("teacherAssignedAgent/teacherRebalancedGroupイベントのagentIdはteacherAssignedになり、それ以外はnaturalのまま", () => {
    const agents = [
      makeAgent({ id: "natural-a", state: "joined", joinedGroupId: "g1" }),
      makeAgent({ id: "forced-a", state: "joined", joinedGroupId: "g2" }),
      makeAgent({ id: "rebalanced-a", state: "joined", joinedGroupId: "g3" }),
    ];
    const log: LogEntry[] = [
      { tick: 100, message: "", tags: [], eventType: "teacherAssignedAgent", metadata: { agentId: "forced-a", groupId: "g2" } },
      { tick: 100, message: "", tags: [], eventType: "teacherRebalancedGroup", metadata: { agentId: "rebalanced-a", groupId: "g3" } },
    ];
    const state = makeState({ agents, log, interventionId: "teacher-deadline-assignment" });
    expect(deriveAssignmentOrigins(state)).toEqual({
      "natural-a": "natural",
      "forced-a": "teacherAssigned",
      "rebalanced-a": "teacherAssigned",
    });
  });
});

describe("deriveAssignmentOrigins: random-assignment-baseline", () => {
  it("randomAssignmentStartedイベントがあれば、joinedは全員randomAssignedになる(interventionId未設定でも判定できる)", () => {
    const agents = [
      makeAgent({ id: "a", state: "joined", joinedGroupId: "random-assigned-1" }),
      makeAgent({ id: "b", state: "joined", joinedGroupId: "random-assigned-1" }),
    ];
    const log: LogEntry[] = [{ tick: 0, message: "", tags: [], eventType: "randomAssignmentStarted", metadata: {} }];
    const state = makeState({ agents, log });
    expect(deriveAssignmentOrigins(state)).toEqual({ a: "randomAssigned", b: "randomAssigned" });
  });
});

describe("deriveAssignmentOrigins: teacher-recommendation", () => {
  function recommendationFulfilledEntry(tick: number, agentId: string, groupId: string): LogEntry {
    return {
      tick,
      message: "",
      tags: [],
      eventType: "schoolInterventionTriggered",
      metadata: {
        schoolInterventionId: "teacher-recommendation",
        agentId,
        groupId,
        triggerReason: "recommendationFulfilled",
        outcome: "assigned",
      },
    };
  }

  it("recommendationFulfilledがあればrecommendationAssistedになる", () => {
    const agents = [makeAgent({ id: "a", state: "joined", joinedGroupId: "g1" })];
    const state = makeState({
      agents,
      log: [recommendationFulfilledEntry(30, "a", "g1")],
      interventionId: "teacher-recommendation",
    });
    expect(deriveAssignmentOrigins(state)).toEqual({ a: "recommendationAssisted" });
  });

  it("推薦を受諾しても実際に所属しなかった場合(recommendationFulfilledが記録されない)はnaturalのまま", () => {
    // teacherRecommendationAcceptedは発行されたが、その後別の経路で自然に参加した(fulfilledイベント無し)ケース
    const agents = [makeAgent({ id: "a", state: "joined", joinedGroupId: "g2" })];
    const log: LogEntry[] = [
      {
        tick: 20,
        message: "",
        tags: [],
        eventType: "teacherRecommendationAccepted",
        metadata: { schoolInterventionId: "teacher-recommendation", agentId: "a", groupId: "g1", outcome: "accepted" },
      },
    ];
    const state = makeState({ agents, log, interventionId: "teacher-recommendation" });
    expect(deriveAssignmentOrigins(state)).toEqual({ a: "natural" });
  });
});

describe("deriveAssignmentOrigins: nearby-peer-prompt(低圧介入)", () => {
  function presentedEntry(tick: number, agentId: string, secondAgentId: string, start: number, expires: number): LogEntry {
    return {
      tick,
      message: "",
      tags: [],
      eventType: "schoolInterventionTriggered",
      metadata: {
        schoolInterventionId: "nearby-peer-prompt",
        agentId,
        secondAgentId,
        outcome: "presented",
        effectStartedAtTick: start,
        effectExpiresAtTick: expires,
      },
    };
  }

  it("効果期間内に接近したagentはlowPressureAssistedになる", () => {
    const agents = [makeAgent({ id: "a", state: "joined", joinedGroupId: "g1" })];
    const log: LogEntry[] = [presentedEntry(10, "a", "b", 10, 30), approachEntry(15, "a", "g1")];
    const state = makeState({ agents, log, interventionId: "nearby-peer-prompt" });
    expect(deriveAssignmentOrigins(state)).toEqual({ a: "lowPressureAssisted" });
  });

  it("効果期間外の接近はnaturalのままlowPressureAssistedへ誤計上しない", () => {
    const agents = [makeAgent({ id: "a", state: "joined", joinedGroupId: "g1" })];
    const log: LogEntry[] = [presentedEntry(10, "a", "b", 10, 30), approachEntry(45, "a", "g1")];
    const state = makeState({ agents, log, interventionId: "nearby-peer-prompt" });
    expect(deriveAssignmentOrigins(state)).toEqual({ a: "natural" });
  });
});

describe("summarizeAssignmentOrigins", () => {
  it("合計が入力のagent数と一致する", () => {
    const origins = { a: "natural", b: "teacherAssigned", c: "natural" } as const;
    const counts = summarizeAssignmentOrigins(origins);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(3);
    expect(counts.natural).toBe(2);
    expect(counts.teacherAssigned).toBe(1);
  });

  it("空の入力なら全カテゴリ0", () => {
    const counts = summarizeAssignmentOrigins({});
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});

describe("buildLowPressureInterventionFunnel", () => {
  function presentedEntry(tick: number, agentId: string, secondAgentId: string, start: number, expires: number): LogEntry {
    return {
      tick,
      message: "",
      tags: [],
      eventType: "schoolInterventionTriggered",
      metadata: {
        schoolInterventionId: "nearby-peer-prompt",
        agentId,
        secondAgentId,
        outcome: "presented",
        effectStartedAtTick: start,
        effectExpiresAtTick: expires,
      },
    };
  }

  it("選択中の介入が一致しなければundefined(対象外)を返す", () => {
    const state = makeState({ interventionId: "teacher-deadline-assignment" });
    expect(buildLowPressureInterventionFunnel(state, "nearby-peer-prompt")).toBeUndefined();
  });

  it("発火・対象・接近・所属・失敗を正しく数える", () => {
    const agents = [
      // joined: 効果期間中に接近して所属した
      makeAgent({ id: "joined-a", state: "joined", joinedGroupId: "g1" }),
      // failed: 効果期間中に接近したが、その後満員で失敗し、最終的にunassigned
      makeAgent({ id: "failed-a", state: "unassigned" }),
      // no-action: 対象になったが一度も接近しなかった
      makeAgent({ id: "noaction-a", state: "undecided" }),
    ];
    const log: LogEntry[] = [
      presentedEntry(5, "joined-a", "peer-1", 5, 25),
      approachEntry(10, "joined-a", "g1"),
      presentedEntry(6, "failed-a", "peer-2", 6, 26),
      approachEntry(12, "failed-a", "g2"),
      {
        tick: 14,
        message: "",
        tags: [],
        eventType: "joinFailedCapacity",
        metadata: { agentId: "failed-a", groupId: "g2" },
      },
      presentedEntry(7, "noaction-a", "peer-3", 7, 27),
    ];
    const state = makeState({ agents, log, interventionId: "nearby-peer-prompt" });
    const funnel = buildLowPressureInterventionFunnel(state, "nearby-peer-prompt");

    expect(funnel).toBeDefined();
    expect(funnel!.triggeredCount).toBe(3);
    // targetedAgentIds: joined-a, peer-1, failed-a, peer-2, noaction-a, peer-3 = 6
    expect(funnel!.targetedAgentCount).toBe(6);
    expect(funnel!.assistedJoinCount).toBe(1);
    expect(funnel!.failedAfterApproachCount).toBe(1);
    // approached: joined-a, failed-a = 2 (peer-1/2/3 and noaction-a never approached)
    expect(funnel!.approachedDuringEffectCount).toBe(2);
    // noAction: peer-1, peer-2, peer-3, noaction-a = 4
    expect(funnel!.noActionCount).toBe(4);
  });

  it("接近後に満員化・消滅した場合、成功と失敗を二重計上しない", () => {
    const agents = [makeAgent({ id: "a", state: "joined", joinedGroupId: "g1" })];
    const log: LogEntry[] = [
      presentedEntry(5, "a", "b", 5, 25),
      approachEntry(10, "a", "g1"),
      // 同じagentが一度失敗した後、再接近して最終的に所属した(二重計上のリスクがあるケース)
      { tick: 11, message: "", tags: [], eventType: "joinFailedCapacity", metadata: { agentId: "a", groupId: "g1" } },
      approachEntry(12, "a", "g1"),
    ];
    const state = makeState({ agents, log, interventionId: "nearby-peer-prompt" });
    const funnel = buildLowPressureInterventionFunnel(state, "nearby-peer-prompt")!;
    expect(funnel.assistedJoinCount).toBe(1);
    expect(funnel.failedAfterApproachCount).toBe(0);
  });
});

describe("再現性: 同一入力なら同一結果", () => {
  it("deriveAssignmentOrigins/buildLowPressureInterventionFunnelは同じstateに対し常に同じ結果を返す", () => {
    const agents = [makeAgent({ id: "a", state: "joined", joinedGroupId: "g1" })];
    const log: LogEntry[] = [
      {
        tick: 5,
        message: "",
        tags: [],
        eventType: "schoolInterventionTriggered",
        metadata: {
          schoolInterventionId: "nearby-peer-prompt",
          agentId: "a",
          secondAgentId: "b",
          outcome: "presented",
          effectStartedAtTick: 5,
          effectExpiresAtTick: 25,
        },
      },
      approachEntry(10, "a", "g1"),
    ];
    const state = makeState({ agents, log, interventionId: "nearby-peer-prompt" });
    expect(deriveAssignmentOrigins(state)).toEqual(deriveAssignmentOrigins(state));
    expect(buildLowPressureInterventionFunnel(state, "nearby-peer-prompt")).toEqual(
      buildLowPressureInterventionFunnel(state, "nearby-peer-prompt"),
    );
  });
});
