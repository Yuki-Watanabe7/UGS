import type { Agent } from "../types";
import { stableSortById } from "../schoolInterventionRuntime";
import type {
  InterventionEvent,
  SchoolIntervention,
  SchoolInterventionContext,
  SchoolInterventionHookOutput,
} from "../schoolInterventionRuntime";

/**
 * Issue #158: 「匿名の支援要請通知」介入(`anonymous-help-signal`)。
 *
 * 長時間未決定の生徒本人が、公開の場で名指しされることなく教師へ支援を要請できるようにする。
 * 通知そのものはagentを移動・所属させない(このモジュールはeffectsを一切生成しない、
 * 「教師が認知した」という事実だけを構造化イベントとして記録する)。
 *
 * 情報境界: 公開ログ(`InterventionEvent.message`)は個人を特定しない一般的な文言に固定し、
 * 対象agentは`metadata.agentId`という構造化フィールドにのみ保持する。表示側(presentation)が
 * 一般公開ビューと教師向けInspector/介入詳細とでmetadataの参照可否を切り替えることを想定しており、
 * このモジュール自身はその切り替えを行わない(常にmetadataへ内部IDを保持するだけに留める)。
 */

/** 曖昧フェーズが始まってすぐの通知を避けるための下限tick数 */
export const ANONYMOUS_HELP_MIN_TICK = 10;
/** stressがleaveThresholdのこの割合以上なら通知条件を満たす */
export const ANONYMOUS_HELP_STRESS_RATIO = 0.5;
/** 参加失敗による再探索がこの回数以上なら通知条件を満たす */
export const ANONYMOUS_HELP_MIN_SEARCH_RESTARTS = 1;
/** そのうち満員(容量起因)が理由だった回数がこの回数以上なら通知条件を満たす */
export const ANONYMOUS_HELP_MIN_CAPACITY_FAILURES = 1;
/** 一度通知した後、同一agentを再度通知対象とするまでのクールダウンtick数 */
export const ANONYMOUS_HELP_COOLDOWN_TICKS = 30;

export type AnonymousHelpTriggerReason = "highStress" | "repeatedSearchRestarts" | "repeatedCapacityFailures";

function cooldownKey(agentId: string): string {
  return `anonymous-help-signal:${agentId}`;
}

/** 通知条件(いずれか1つで発火)。判定順は表示用triggerReasonの優先順位も兼ねる */
export function evaluateAnonymousHelpTriggerReason(agent: Agent): AnonymousHelpTriggerReason | undefined {
  if (agent.stress >= agent.leaveThreshold * ANONYMOUS_HELP_STRESS_RATIO) return "highStress";
  if ((agent.searchRestartCount ?? 0) >= ANONYMOUS_HELP_MIN_SEARCH_RESTARTS) return "repeatedSearchRestarts";
  if ((agent.capacityFailureCount ?? 0) >= ANONYMOUS_HELP_MIN_CAPACITY_FAILURES) return "repeatedCapacityFailures";
  return undefined;
}

function isEligible(agent: Agent, ctx: SchoolInterventionContext): boolean {
  // joined/left/unassigned確定後は発火しない(受入条件)
  if (agent.state !== "undecided") return false;
  if (ctx.tick < ANONYMOUS_HELP_MIN_TICK) return false;
  const lastTick = ctx.runtimeState.lastTriggeredAtTick[cooldownKey(agent.id)];
  // 既に通知済みでない(lastTickがundefined)、またはcooldownを超えている場合のみ対象にする
  if (lastTick !== undefined && ctx.tick - lastTick < ANONYMOUS_HELP_COOLDOWN_TICKS) return false;
  return true;
}

function onBeforeTick(ctx: SchoolInterventionContext): SchoolInterventionHookOutput {
  // この介入はclassroomPair系(学校シナリオ)専用。afterPartyへ誤って適用されても既存挙動を
  // 変えないよう明示的にno-opにする(受入条件: 介入なしと二次会シナリオの既存挙動が変化しない)。
  if (ctx.formationPolicy.id !== "classroomPair") return {};

  const events: InterventionEvent[] = [];
  const lastTriggeredAtTick = { ...ctx.runtimeState.lastTriggeredAtTick };
  const notified = new Set(ctx.runtimeState.anonymouslyNotifiedAgentIds);

  for (const agent of stableSortById(ctx.agents)) {
    if (!isEligible(agent, ctx)) continue;
    const triggerReason = evaluateAnonymousHelpTriggerReason(agent);
    if (!triggerReason) continue;

    events.push({
      // 公開ログ向け: 個人を特定しない一般的な文言に固定する(受入条件: 匿名通知では公開画面から
      // 個人が特定されない)。対象agentは下のmetadata.agentIdにのみ保持する。
      message: `支援を希望する生徒がいます(先生にのみ通知されました)`,
      tags: ["intervention"],
      eventType: "anonymousHelpRequested",
      metadata: {
        schoolInterventionId: "anonymous-help-signal",
        agentId: agent.id,
        isTeacherSource: false,
        triggerReason,
        stress: agent.stress,
        searchRestartCount: agent.searchRestartCount ?? 0,
        capacityFailureCount: agent.capacityFailureCount ?? 0,
        outcome: "presented",
      },
    });
    notified.add(agent.id);
    lastTriggeredAtTick[cooldownKey(agent.id)] = ctx.tick;
  }

  if (events.length === 0) return {};

  return {
    events,
    runtimeState: {
      ...ctx.runtimeState,
      anonymouslyNotifiedAgentIds: [...notified],
      lastTriggeredAtTick,
    },
  };
}

export const anonymousHelpSignalIntervention: SchoolIntervention = {
  id: "anonymous-help-signal",
  onBeforeTick,
};
