import type { Agent, GroupCandidate } from "../types";
import { distance } from "../model";
import { resolveNominalGroupCapacity } from "../formationPolicy";
import { partitionIntoGroups } from "../groupPartition";
import { stableSortById } from "../schoolInterventionRuntime";
import type {
  InterventionAction,
  InterventionEvent,
  SchoolIntervention,
  SchoolInterventionContext,
  SchoolInterventionHookOutput,
} from "../schoolInterventionRuntime";

/**
 * Issue #159: 「締切時の教師強制割当」介入(`teacher-deadline-assignment`)。
 *
 * `classroomPair`系のdeadline到達時(`onAtDeadline`)に1回だけ実行し、未割当のまま残る生徒を
 * 容量制約(`formationPolicy.resolveGroupCapacity`/`resolveNominalGroupCapacity`)内で可能な限り
 * 割り当てる。優先順位(issue #159本文の番号と対応):
 *   1. 最大定員を超えない        -> 各stepとも`min <= memberIds.length <= max`を満たす構成のみ作る
 *   2. 既に成立した班を維持する  -> `status === "confirmed"`の班のみ「既存班」として扱い解体しない
 *      (`status === "forming"`は「成立した」わけではないため対象外。#159本文の文言どおり)
 *   3. 空きのある班へ追加        -> Step 1(可変定員のconfirmed班の空き枠)
 *   4. 新規班を構成する          -> Step 2(`groupPartition.ts`の決定的な分割)
 *   5. 既存班を再配分する        -> Step 3(minを満たせない残りへ、余剰枠のある班から1人ずつ移す)
 *   6. 割当不能を記録する        -> Step 3が失敗した場合のみ(`teacherAssignmentUnable`)
 *
 * 候補選択は距離・既存stress/失敗回数・安定ID順のみで決定的に行う(rngは一切使わない、受入条件:
 * 同一seed・同一状態で同じ結果になる)。`classroomPair`ではstressが未定状態の経過tickに比例して
 * 単調増加する(`formationPolicy.ts`の`computeStressIncrement`)ため、"待機時間"の代理指標として
 * stressをそのまま使う(専用のタイムスタンプフィールドをAgentへ追加しない)。
 */

/** Step 1/2で「誰を先に確定させるか」を決める優先度。値が大きいほど優先(降順ソート) */
function priorityScore(agent: Agent): number {
  const stressRatio = agent.leaveThreshold > 0 ? agent.stress / agent.leaveThreshold : agent.stress;
  return stressRatio * 100 + (agent.searchRestartCount ?? 0) * 10 + (agent.capacityFailureCount ?? 0) * 5;
}

function byPriorityThenId(a: Agent, b: Agent): number {
  const diff = priorityScore(b) - priorityScore(a);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function agentById(agents: readonly Agent[], id: string): Agent {
  const agent = agents.find((a) => a.id === id);
  if (!agent) throw new Error(`teacher-deadline-assignment: unknown agent id ${id}`);
  return agent;
}

function centroid(agents: readonly Agent[]): { x: number; y: number } {
  return {
    x: agents.reduce((sum, a) => sum + a.x, 0) / agents.length,
    y: agents.reduce((sum, a) => sum + a.y, 0) / agents.length,
  };
}

type WorkingGroup = {
  candidateId: string;
  x: number;
  y: number;
  memberIds: string[];
  minGroupSize: number;
  maxGroupSize: number;
};

function assignedAgentEvent(
  agent: Agent,
  groupId: string,
  assignmentKind: "existingVacancy" | "newGroup",
  minGroupSize: number,
  maxGroupSize: number,
  memberCount: number,
): InterventionEvent {
  return {
    message:
      assignmentKind === "existingVacancy"
        ? `教師が${agent.label}さんを空きのある班へ割り当てた`
        : `教師が${agent.label}さんを新しい班へ割り当てた`,
    tags: ["intervention"],
    eventType: "teacherAssignedAgent",
    metadata: {
      schoolInterventionId: "teacher-deadline-assignment",
      isTeacherSource: true,
      assignmentStrategy: "teacherForced",
      agentId: agent.id,
      groupId,
      assignmentKind,
      memberCount,
      minGroupSize,
      maxGroupSize: Number.isFinite(maxGroupSize) ? maxGroupSize : undefined,
      outcome: "assigned",
    },
  };
}

function onAtDeadline(ctx: SchoolInterventionContext): SchoolInterventionHookOutput {
  // この介入はclassroomPair系(学校シナリオ)専用。afterPartyへ誤って適用されても既存挙動を
  // 変えないよう明示的にno-opにする(受入条件: 介入なしと二次会シナリオの既存挙動が変化しない)。
  if (ctx.formationPolicy.id !== "classroomPair") return {};
  // run中に1回だけ実行する(受入条件)。deadline判定自体はengine.ts側で"allAssigned"より後回しに
  // ならないため、この介入は常に"deadlineReached"時のみ発火する(`atDeadline`フックの定義どおり)。
  if (ctx.runtimeState.forcedAssignmentApplied) return {};

  const capacityOf = (candidate: GroupCandidate) => ctx.formationPolicy.resolveGroupCapacity(candidate, ctx.params);
  const nominalCapacity = resolveNominalGroupCapacity(ctx.formationPolicy, ctx.params);

  const confirmedCandidates = ctx.groupCandidates.filter((c) => c.status === "confirmed");
  const formingCandidates = ctx.groupCandidates.filter((c) => c.status === "forming");

  const confirmedMemberIds = new Set(confirmedCandidates.flatMap((c) => c.memberIds));
  const pool = stableSortById(ctx.agents.filter((a) => !confirmedMemberIds.has(a.id)));

  const actions: InterventionAction[] = [];
  const events: InterventionEvent[] = [];

  events.push({
    message: `教師が締切時点の未割当者${pool.length}人へ強制割当を開始した`,
    tags: ["intervention"],
    eventType: "teacherAssignmentStarted",
    metadata: {
      schoolInterventionId: "teacher-deadline-assignment",
      isTeacherSource: true,
      assignmentStrategy: "teacherForced",
      assignmentPoolSize: pool.length,
      outcome: "presented",
    },
  });

  // forming(未成立)の候補は「成立した班」ではないため維持対象にせず解体する。メンバーは
  // 既にpoolへ含まれている(confirmedMemberIdsに入っていないため)ので、候補側のmemberIdsだけ空にする
  // (受入条件: agentの所属は最大1班、memberIds重複なし)
  for (const g of formingCandidates) {
    for (const id of g.memberIds) actions.push({ kind: "removeFromGroup", agentId: id, groupId: g.id });
  }

  const completedEvent = (assignedByStrategyCount: number, rebalancedGroupCount: number, rebalancedStudentCount: number, structuralUnassignedCount: number): InterventionEvent => ({
    message:
      `教師強制割当が完了した: 割当${assignedByStrategyCount}人 / ` +
      `再配分${rebalancedStudentCount}人(${rebalancedGroupCount}班) / 割当不能${structuralUnassignedCount}人`,
    tags: ["intervention"],
    eventType: "teacherAssignmentCompleted",
    metadata: {
      schoolInterventionId: "teacher-deadline-assignment",
      isTeacherSource: true,
      assignmentStrategy: "teacherForced",
      assignedByStrategyCount,
      rebalancedGroupCount,
      rebalancedStudentCount,
      structuralUnassignedCount,
      outcome: structuralUnassignedCount > 0 ? "unassignable" : "assigned",
    },
  });

  if (pool.length === 0) {
    events.push(completedEvent(0, 0, 0, 0));
    return { actions, events, runtimeState: { ...ctx.runtimeState, forcedAssignmentApplied: true } };
  }

  // 既存(confirmed)班の作業用コピー。実際の反映はactions経由でengineが行うため、
  // ここでのmemberIds更新は「次のstepが正しい空き容量/余剰枠を見るための」ローカルな追跡専用
  const workingGroups = new Map<string, WorkingGroup>(
    confirmedCandidates.map((c) => {
      const capacity = capacityOf(c);
      return [
        c.id,
        { candidateId: c.id, x: c.x, y: c.y, memberIds: [...c.memberIds], minGroupSize: capacity.minGroupSize, maxGroupSize: capacity.maxGroupSize },
      ];
    }),
  );

  let remainingPool = [...pool];
  let assignedCount = 0;

  function popClosestTo(x: number, y: number): Agent | undefined {
    if (remainingPool.length === 0) return undefined;
    const [picked] = [...remainingPool].sort((a, b) => {
      const da = distance(x, y, a.x, a.y);
      const db = distance(x, y, b.x, b.y);
      if (da !== db) return da - db;
      return byPriorityThenId(a, b);
    });
    remainingPool = remainingPool.filter((a) => a.id !== picked.id);
    return picked;
  }

  // Step 1: 空きのある成立済み班(可変定員)へ追加。完成まで残り枠が少ない班から優先して埋める
  const vacantGroups = [...workingGroups.values()]
    .filter((g) => Number.isFinite(g.maxGroupSize) && g.memberIds.length < g.maxGroupSize)
    .sort((a, b) => {
      const remainA = a.maxGroupSize - a.memberIds.length;
      const remainB = b.maxGroupSize - b.memberIds.length;
      if (remainA !== remainB) return remainA - remainB;
      return a.candidateId < b.candidateId ? -1 : 1;
    });

  for (const group of vacantGroups) {
    while (group.memberIds.length < group.maxGroupSize && remainingPool.length > 0) {
      const picked = popClosestTo(group.x, group.y);
      if (!picked) break;
      group.memberIds.push(picked.id);
      actions.push({ kind: "assignToGroup", agentId: picked.id, groupId: group.candidateId });
      events.push(assignedAgentEvent(picked, group.candidateId, "existingVacancy", group.minGroupSize, group.maxGroupSize, group.memberIds.length));
      assignedCount++;
    }
  }

  // Step 2: 残ったプールを新規班へ分割する(優先度順: stress比率・再探索/失敗回数が高い人を先に確定させる)
  const orderedRemaining = [...remainingPool].sort(byPriorityThenId);
  const { groups: newGroupChunks, unassignedIds: initialRemainderIds } = partitionIntoGroups(
    orderedRemaining.map((a) => a.id),
    nominalCapacity,
  );

  let groupSeq = 0;
  for (const memberIds of newGroupChunks) {
    groupSeq++;
    const groupId = `teacher-assigned-${ctx.tick}-${groupSeq}`;
    const members = memberIds.map((id) => agentById(ctx.agents, id));
    const { x, y } = centroid(members);
    actions.push({
      kind: "createGroup",
      groupId,
      memberIds,
      x,
      y,
      minGroupSize: nominalCapacity.minGroupSize,
      maxGroupSize: nominalCapacity.maxGroupSize,
    });
    workingGroups.set(groupId, {
      candidateId: groupId,
      x,
      y,
      memberIds: [...memberIds],
      minGroupSize: nominalCapacity.minGroupSize,
      maxGroupSize: nominalCapacity.maxGroupSize,
    });
    for (const member of members) {
      events.push(assignedAgentEvent(member, groupId, "newGroup", nominalCapacity.minGroupSize, nominalCapacity.maxGroupSize, memberIds.length));
      assignedCount++;
    }
  }

  // Step 3: 新規班にもできなかった構造的な残り(`groupPartition.ts`の設計上、常にminGroupSize未満)を、
  // 既存班(新規含む)の余剰枠(minGroupSizeを超える人数を持つ班)から1人ずつ移して埋められないか試みる。
  // 十分な余剰枠がない場合は既存班には一切触れず、残りをそのまま割当不能として記録する
  // (受入条件: 割当不能を隠さず、構造的理由を記録・表示する。かつ、寄せ集めに失敗して
  // 既に割り当て済みの生徒を宙に浮かせない)。
  let remainder = initialRemainderIds.map((id) => agentById(ctx.agents, id));
  const rebalancedGroupIds = new Set<string>();
  let rebalancedStudentCount = 0;
  let structuralUnassignedCount = 0;

  if (remainder.length > 0) {
    const needed = nominalCapacity.minGroupSize - remainder.length;
    const donors = [...workingGroups.values()].filter((g) => g.memberIds.length > g.minGroupSize);
    const totalSlack = donors.reduce((sum, g) => sum + (g.memberIds.length - g.minGroupSize), 0);

    if (totalSlack >= needed) {
      const remainderGroupId = `teacher-rebalanced-${ctx.tick}`;
      const sortedDonors = donors.sort((a, b) => {
        const slackA = a.memberIds.length - a.minGroupSize;
        const slackB = b.memberIds.length - b.minGroupSize;
        if (slackA !== slackB) return slackB - slackA;
        return a.candidateId < b.candidateId ? -1 : 1;
      });

      let stillNeeded = needed;
      for (const donor of sortedDonors) {
        while (stillNeeded > 0 && donor.memberIds.length > donor.minGroupSize) {
          const donatedId = [...donor.memberIds].sort().at(-1)!;
          const donatedAgent = agentById(ctx.agents, donatedId);
          actions.push({ kind: "removeFromGroup", agentId: donatedId, groupId: donor.candidateId });
          donor.memberIds = donor.memberIds.filter((id) => id !== donatedId);
          remainder.push(donatedAgent);
          rebalancedGroupIds.add(donor.candidateId);
          rebalancedStudentCount++;
          stillNeeded--;

          events.push({
            message: `教師が${donatedAgent.label}さんを再配分により別の班へ移動させた`,
            tags: ["intervention"],
            eventType: "teacherRebalancedGroup",
            metadata: {
              schoolInterventionId: "teacher-deadline-assignment",
              isTeacherSource: true,
              assignmentStrategy: "teacherForced",
              agentId: donatedId,
              groupId: remainderGroupId,
              previousGroupId: donor.candidateId,
              memberCount: donor.memberIds.length,
              minGroupSize: donor.minGroupSize,
              maxGroupSize: Number.isFinite(donor.maxGroupSize) ? donor.maxGroupSize : undefined,
              outcome: "assigned",
            },
          });
        }
        if (stillNeeded <= 0) break;
      }

      const { x, y } = centroid(remainder);
      actions.push({
        kind: "createGroup",
        groupId: remainderGroupId,
        memberIds: remainder.map((a) => a.id),
        x,
        y,
        minGroupSize: nominalCapacity.minGroupSize,
        maxGroupSize: nominalCapacity.maxGroupSize,
      });
      for (const id of initialRemainderIds) {
        const member = agentById(ctx.agents, id);
        events.push(
          assignedAgentEvent(member, remainderGroupId, "newGroup", nominalCapacity.minGroupSize, nominalCapacity.maxGroupSize, remainder.length),
        );
        assignedCount++;
      }
    } else {
      structuralUnassignedCount = remainder.length;
      for (const member of remainder) {
        events.push({
          message: `${member.label}さんは容量上どうしても班を作れず、割当不能となった`,
          tags: ["intervention", "unassigned"],
          eventType: "teacherAssignmentUnable",
          metadata: {
            schoolInterventionId: "teacher-deadline-assignment",
            isTeacherSource: true,
            assignmentStrategy: "teacherForced",
            agentId: member.id,
            minGroupSize: nominalCapacity.minGroupSize,
            maxGroupSize: Number.isFinite(nominalCapacity.maxGroupSize) ? nominalCapacity.maxGroupSize : undefined,
            structuralUnassignedCount: remainder.length,
            outcome: "unassignable",
          },
        });
      }
    }
  }

  events.push(completedEvent(assignedCount, rebalancedGroupIds.size, rebalancedStudentCount, structuralUnassignedCount));

  return { actions, events, runtimeState: { ...ctx.runtimeState, forcedAssignmentApplied: true } };
}

export const teacherDeadlineAssignmentIntervention: SchoolIntervention = {
  id: "teacher-deadline-assignment",
  onAtDeadline,
};
