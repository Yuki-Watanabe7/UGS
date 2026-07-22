import type { Agent } from "../types";
import { resolveNominalGroupCapacity } from "../formationPolicy";
import { partitionIntoGroups } from "../groupPartition";
import { createInterventionRandom } from "../schoolInterventionRuntime";
import type { SeededRandom } from "../random";
import type {
  InterventionAction,
  InterventionEvent,
  SchoolIntervention,
  SchoolInterventionContext,
  SchoolInterventionHookOutput,
} from "../schoolInterventionRuntime";

/**
 * Issue #159: 「seed付きランダム割当」比較基準(`random-assignment-baseline`)。
 *
 * 教師の救済介入ではなく、自由形成そのものを行わない比較基準(#159本文)。tick 0
 * (`onInitialState`)で全agentのIDを決定的にシャッフルし、容量ルール(`formationPolicy`由来の
 * `resolveNominalGroupCapacity`)に従って班へ分割する。本体`SeededRandom`(`ctx`からは渡されない、
 * engine.ts側の行動決定専用rng)とは独立した`createInterventionRandom`由来のrngのみを使う
 * (受入条件: random baselineが本体PRNGを消費しない)。
 *
 * 班にできなかった残りは、通常の"undecided"のまま次tickへ進ませず`markUnassigned`で即座に終端状態へ
 * 確定する。これにより以後の通常tickループ(核形成・接近・失敗・再探索・stress蓄積)が一切
 * この人たちには作用しない(受入条件: 自由形成の接近・失敗・再探索・stress蓄積が発生しない)。
 * 班に入れた人は最初から`joined`(confirmed)のため、同じ理由でそもそも通常の形成ロジックの対象外になる。
 */

function centroid(agents: readonly Agent[]): { x: number; y: number } {
  return {
    x: agents.reduce((sum, a) => sum + a.x, 0) / agents.length,
    y: agents.reduce((sum, a) => sum + a.y, 0) / agents.length,
  };
}

/** Fisher-Yatesで`agents`のid列を決定的にシャッフルする(介入専用rngのみ使用、本体rngは一切読まない) */
function shuffledAgentIds(agents: readonly Agent[], rng: SeededRandom): string[] {
  const ids = agents.map((a) => a.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

function onInitialState(ctx: SchoolInterventionContext): SchoolInterventionHookOutput {
  // この介入はclassroomPair系(学校シナリオ)専用。afterPartyへ誤って適用されても既存挙動を
  // 変えないよう明示的にno-opにする(受入条件: 介入なしと二次会シナリオの既存挙動が変化しない)。
  if (ctx.formationPolicy.id !== "classroomPair") return {};

  const capacity = resolveNominalGroupCapacity(ctx.formationPolicy, ctx.params);
  const rng = createInterventionRandom(ctx.runSeed, "random-assignment-baseline", ctx.tick, "shuffle");
  const orderedIds = shuffledAgentIds(ctx.agents, rng);
  const { groups, unassignedIds } = partitionIntoGroups(orderedIds, capacity);

  const actions: InterventionAction[] = [];
  const events: InterventionEvent[] = [];

  events.push({
    message: `seed付きランダム割当(比較基準)を開始した`,
    tags: ["intervention"],
    eventType: "randomAssignmentStarted",
    metadata: {
      schoolInterventionId: "random-assignment-baseline",
      isTeacherSource: false,
      assignmentStrategy: "randomBaseline",
      assignmentPoolSize: ctx.agents.length,
      outcome: "presented",
    },
  });

  let assignedCount = 0;
  let groupSeq = 0;
  for (const memberIds of groups) {
    groupSeq++;
    const groupId = `random-assigned-${groupSeq}`;
    const members = memberIds
      .map((id) => ctx.agents.find((a) => a.id === id))
      .filter((a): a is Agent => a !== undefined);
    const { x, y } = centroid(members);
    actions.push({
      kind: "createGroup",
      groupId,
      memberIds,
      x,
      y,
      minGroupSize: capacity.minGroupSize,
      maxGroupSize: capacity.maxGroupSize,
    });
    events.push({
      message: `ランダム割当により班(${memberIds.length}人)が作られた`,
      tags: ["intervention"],
      eventType: "randomGroupCreated",
      metadata: {
        schoolInterventionId: "random-assignment-baseline",
        isTeacherSource: false,
        assignmentStrategy: "randomBaseline",
        groupId,
        memberCount: memberIds.length,
        minGroupSize: capacity.minGroupSize,
        maxGroupSize: Number.isFinite(capacity.maxGroupSize) ? capacity.maxGroupSize : undefined,
        outcome: "assigned",
      },
    });
    assignedCount += memberIds.length;
  }

  for (const id of unassignedIds) {
    actions.push({ kind: "markUnassigned", agentId: id });
  }

  events.push({
    message: `ランダム割当(比較基準)が完了した: 割当${assignedCount}人 / 構造的未割当${unassignedIds.length}人`,
    tags: ["intervention"],
    eventType: "randomAssignmentCompleted",
    metadata: {
      schoolInterventionId: "random-assignment-baseline",
      isTeacherSource: false,
      assignmentStrategy: "randomBaseline",
      assignedByStrategyCount: assignedCount,
      structuralUnassignedCount: unassignedIds.length,
      outcome: unassignedIds.length > 0 ? "unassignable" : "assigned",
    },
  });

  return { actions, events };
}

export const randomAssignmentBaselineIntervention: SchoolIntervention = {
  id: "random-assignment-baseline",
  onInitialState,
};
