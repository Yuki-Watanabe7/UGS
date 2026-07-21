import type { GroupCandidate } from "../types";
import type {
  InterventionEffect,
  InterventionEvent,
  SchoolIntervention,
  SchoolInterventionContext,
  SchoolInterventionHookOutput,
} from "../schoolInterventionRuntime";

/**
 * Issue #157: 「空きのある班の参加可能表示」介入(`open-group-signal`)。
 *
 * forming(空きあり)、または可変定員でconfirmedだがまだ`memberIds.length < maxGroupSize`の候補を
 * 「空きあり」として毎tick洗い出し、そこへ向けた未決定者のattractivenessを一時的に底上げする。
 * dissolving/dissolved/expired、および空き枠のない候補は対象にしない。表示そのものは
 * `SimulationCanvas`の候補ステータス欄(現在人数/最小/最大/空き)が既に全候補について常時表示している
 * ため、この介入固有のCanvas表示は追加せず、「表示を出す/下げる」という発生・終了イベントと
 * attractivenessへの一時補正だけをここで扱う(受入条件: 表示はシミュレーション状態から導出し、
 * 描画処理が本体状態・PRNGを変更しない)。
 */

/** 「空きあり」表示中の候補へ向けたattractivenessに加える一時的な加算値 */
export const OPEN_GROUP_SIGNAL_ATTRACTIVENESS_BOOST = 0.15;
/**
 * 生成する`InterventionEffect`の有効期間(tick)。#156の集計パターン(`speechEffects.ts`と同じ、
 * 生成した次tickから利用可能になる)のもとで、この介入は候補が空きあり状態である限り毎tick
 * 効果を再発行し続けるため、1tick分の有効期間で継続的な表示を近似する(見えなくなればその後
 * 再発行されず自然に失効する)。
 */
const EFFECT_DURATION_TICKS = 2;

/**
 * Issue #158: `teacher-recommendation`が推薦候補の絞り込み(容量違反回避)にも再利用する
 * (export済み。判定ロジック自体はopen-group-signal導入時のものと同一)。
 */
export function candidateHasVacancy(candidate: GroupCandidate, ctx: SchoolInterventionContext): boolean {
  if (candidate.status !== "forming" && candidate.status !== "confirmed") return false;
  const capacity = ctx.formationPolicy.resolveGroupCapacity(candidate, ctx.params);
  if (!Number.isFinite(capacity.maxGroupSize)) return true;
  return candidate.memberIds.length < capacity.maxGroupSize;
}

function capacityFields(
  candidate: GroupCandidate,
  ctx: SchoolInterventionContext,
): { maxGroupSize?: number; remainingCapacity?: number } {
  const capacity = ctx.formationPolicy.resolveGroupCapacity(candidate, ctx.params);
  if (!Number.isFinite(capacity.maxGroupSize)) return {};
  return { maxGroupSize: capacity.maxGroupSize, remainingCapacity: capacity.maxGroupSize - candidate.memberIds.length };
}

function onAfterStateTransition(ctx: SchoolInterventionContext): SchoolInterventionHookOutput {
  // この介入はclassroomPair系(学校シナリオ)専用。afterPartyへ誤って適用されても既存挙動を
  // 変えないよう明示的にno-opにする(受入条件: 介入なしと二次会シナリオの既存挙動が変化しない)。
  if (ctx.formationPolicy.id !== "classroomPair") return {};

  const openCandidates = ctx.groupCandidates.filter((candidate) => candidateHasVacancy(candidate, ctx));
  const openIds = new Set(openCandidates.map((candidate) => candidate.id));
  const previouslySignaled = new Set(ctx.runtimeState.intervenedGroupIds);
  const events: InterventionEvent[] = [];

  for (const candidate of openCandidates) {
    if (previouslySignaled.has(candidate.id)) continue;
    events.push({
      message: `${candidate.id} に「まだ空きがあります」の表示が出た(${candidate.memberIds.length}人)`,
      tags: ["intervention"],
      eventType: "schoolInterventionTriggered",
      metadata: {
        schoolInterventionId: "open-group-signal",
        groupId: candidate.id,
        groupStatus: candidate.status,
        memberCount: candidate.memberIds.length,
        ...capacityFields(candidate, ctx),
        isTeacherSource: true,
        triggerReason: "groupHasVacancy",
        effectStartedAtTick: ctx.tick,
        outcome: "presented",
      },
    });
  }

  for (const groupId of previouslySignaled) {
    if (openIds.has(groupId)) continue;
    const candidate = ctx.groupCandidates.find((c) => c.id === groupId);
    const capacity = candidate ? ctx.formationPolicy.resolveGroupCapacity(candidate, ctx.params) : undefined;
    const filled =
      candidate !== undefined && capacity !== undefined && candidate.memberIds.length >= capacity.maxGroupSize;
    events.push({
      message: filled
        ? `${groupId} は空きがなくなり、「空きあり」表示が終了した`
        : `${groupId} の「空きあり」表示が終了した`,
      tags: ["intervention"],
      eventType: "schoolInterventionTriggered",
      metadata: {
        schoolInterventionId: "open-group-signal",
        groupId,
        groupStatus: candidate?.status,
        memberCount: candidate?.memberIds.length,
        isTeacherSource: true,
        triggerReason: filled ? "groupBecameFull" : "groupNoLongerJoinable",
        effectExpiresAtTick: ctx.tick,
        ...(filled ? { outcome: "assigned" as const } : {}),
      },
    });
  }

  const undecidedAgentIds = ctx.agents.filter((agent) => agent.state === "undecided").map((agent) => agent.id);
  const effects: InterventionEffect[] = [];
  for (const candidate of openCandidates) {
    for (const agentId of undecidedAgentIds) {
      effects.push({
        dimension: "attractiveness",
        agentId,
        targetGroupId: candidate.id,
        value: OPEN_GROUP_SIGNAL_ATTRACTIVENESS_BOOST,
        startedAtTick: ctx.tick,
        expiresAtTick: ctx.tick + EFFECT_DURATION_TICKS,
      });
    }
  }

  return {
    effects,
    events,
    runtimeState: {
      ...ctx.runtimeState,
      intervenedGroupIds: [...openIds],
    },
  };
}

export const openGroupSignalIntervention: SchoolIntervention = {
  id: "open-group-signal",
  onAfterStateTransition,
};
