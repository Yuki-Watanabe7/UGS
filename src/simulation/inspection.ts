import type {
  Agent,
  ObserverActiveEffectStatus,
  ObserverJoinerInspection,
  ObserverSpeechEffectDetail,
  ObserverSpeechHistoryEntry,
  SimParams,
  SimulationState,
} from "./types";
import type { SpeechEvent } from "./speech";
import type { AggregatedActiveEffect, SpeechActiveEffect, SpeechEffectDimension, SpeechEffectEvent } from "./speechEffects";
import { aggregateActiveEffects } from "./speechEffects";
import { distance } from "./model";
import { attractiveness, nearestCandidate } from "./engine";

/**
 * agentIdが関わる発言を、tick順のまま関わり方(speaker/target/audience)付きで抽出する。
 * "nearby" audienceの簡略化についてはtypes.tsの`ObserverSpeechHistoryEntry`参照。
 */
function buildSpeechHistory(agentId: string, speechLog: SpeechEvent[]): ObserverSpeechHistoryEntry[] {
  const history: ObserverSpeechHistoryEntry[] = [];
  for (const event of speechLog) {
    if (event.speakerId === agentId) {
      history.push({ event, relation: "speaker" });
    } else if (event.target === agentId) {
      history.push({ event, relation: "target" });
    } else if (event.audience === "nearby") {
      history.push({ event, relation: "audience" });
    }
  }
  return history;
}

/**
 * `effect`(`speechEffectLog`の1件)がまだ`activeSpeechEffects`に残っているかを`speechEffectEventId`で
 * 引き当て、残っていれば現在の適用状況を組み立てる。既に失効(`advanceActiveSpeechEffects`で破棄)、
 * または同一話者・同一intentの再発言により置換(`registerActiveSpeechEffects`)された場合は
 * `undefined`を返す(=「効果は生成されたが、現在は作用していない」を表す)。
 */
function buildActiveEffectStatus(
  effect: SpeechEffectEvent,
  activeEffects: SpeechActiveEffect[],
  tick: number,
): ObserverActiveEffectStatus | undefined {
  const active = activeEffects.find((candidate) => candidate.speechEffectEventId === effect.id);
  if (!active) return undefined;
  return {
    initialStrength: active.initialStrength,
    currentStrength: active.currentStrength,
    startedAtTick: active.startedAtTick,
    expiresAtTick: active.expiresAtTick,
    remainingTicks: Math.max(0, active.expiresAtTick - tick),
  };
}

/**
 * `speechHistory`と同じ発言集合について、`speechEventId`・`receiverId`(=agentId)で認知/解釈/効果の
 * 各ログを引き当て、因果チェーンを1件ずつ組み立てる(Issue #98)。各ログが未指定/空(Phase 3効果が
 * 無効、または既存stateとの後方互換で存在しない)の場合は、全件`undefined`のみを持つ詳細を返す。
 */
function buildSpeechEffectDetails(
  agentId: string,
  speechHistory: ObserverSpeechHistoryEntry[],
  state: SimulationState,
): ObserverSpeechEffectDetail[] {
  const receptionLog = state.speechReceptionLog ?? [];
  const interpretationLog = state.speechInterpretationLog ?? [];
  const effectLog = state.speechEffectLog ?? [];
  const activeEffects = state.activeSpeechEffects ?? [];

  return speechHistory.map(({ event }) => {
    const reception = receptionLog.find(
      (candidate) => candidate.speechEventId === event.id && candidate.receiverId === agentId,
    );
    const interpretation = interpretationLog.find(
      (candidate) => candidate.speechEventId === event.id && candidate.receiverId === agentId,
    );
    const effect = effectLog.find(
      (candidate) => candidate.speechEventId === event.id && candidate.receiverId === agentId,
    );
    return {
      speechEventId: event.id,
      reception,
      interpretation,
      effect,
      activeEffectStatus: effect ? buildActiveEffectStatus(effect, activeEffects, state.tick) : undefined,
    };
  });
}

/** `aggregateActiveEffects`を呼び出す対象となる(dimension, targetGroupId)の組を安定した順序で列挙する */
const ACTIVE_EFFECT_DIMENSIONS: SpeechEffectDimension[] = [
  "stress",
  "attractiveness",
  "approachProbability",
  "leaveThreshold",
];

/**
 * 現在このagentに作用している`activeSpeechEffects`を、dimension(・attractivenessならtargetGroupId)
 * ごとに`aggregateActiveEffects`(Issue #97)へ通し、集約結果の一覧を組み立てる(Issue #98)。
 * どのdimension/targetGroupIdの組が存在するかはagent自身のactiveEffectsから決定的に導出するため、
 * 該当する効果が1件も無いdimensionは結果に含まれない。
 */
function buildActiveEffectSummaries(agentId: string, state: SimulationState): AggregatedActiveEffect[] {
  const activeEffects = state.activeSpeechEffects ?? [];
  const mine = activeEffects.filter((effect) => effect.receiverId === agentId);
  if (mine.length === 0) return [];

  const targetGroupIdsByDimension = new Map<SpeechEffectDimension, Set<string | undefined>>();
  for (const effect of mine) {
    const set = targetGroupIdsByDimension.get(effect.dimension) ?? new Set<string | undefined>();
    set.add(effect.targetGroupId);
    targetGroupIdsByDimension.set(effect.dimension, set);
  }

  const summaries: AggregatedActiveEffect[] = [];
  for (const dimension of ACTIVE_EFFECT_DIMENSIONS) {
    const targetGroupIds = targetGroupIdsByDimension.get(dimension);
    if (!targetGroupIds) continue;
    const ordered = [...targetGroupIds].sort((a, b) => (a ?? "").localeCompare(b ?? ""));
    for (const targetGroupId of ordered) {
      summaries.push(aggregateActiveEffects(activeEffects, agentId, dimension, state.tick, targetGroupId));
    }
  }
  return summaries;
}

function buildInspection(
  agent: Agent,
  state: SimulationState,
  params: SimParams,
): ObserverJoinerInspection {
  const candidate = nearestCandidate(agent, state.groupCandidates);
  const speechHistory = buildSpeechHistory(agent.id, state.speechLog ?? []);

  return {
    agentId: agent.id,
    label: agent.label,
    state: agent.state,
    stress: agent.stress,
    willingness: agent.willingness,
    ambiguityTolerance: agent.ambiguityTolerance,
    influenceAvoidance: agent.influenceAvoidance,
    leaveThreshold: agent.leaveThreshold,
    leaveMargin: agent.leaveThreshold - agent.stress,
    nearestGroupId: candidate?.id,
    nearestGroupStatus: candidate?.status,
    nearestGroupMemberCount: candidate?.memberIds.length,
    nearestGroupDistance: candidate ? distance(agent.x, agent.y, candidate.x, candidate.y) : undefined,
    attractivenessScore: candidate
      ? attractiveness(
          agent,
          candidate,
          state.agents,
          params,
          state.interventionId,
          state.tick,
          state.activeSpeechEffects ?? [],
        )
      : undefined,
    // Phase 3効果を除いた基準値(Issue #98)。activeEffectsを渡さないため、attractiveness()内部の
    // sumActiveEffectValueは常に0を加算する(=speechEffectsが無効の場合と同じ計算になる)。
    attractivenessScoreBeforeEffects: candidate
      ? attractiveness(agent, candidate, state.agents, params, state.interventionId, state.tick)
      : undefined,
    speechHistory,
    speechEffectDetails: buildSpeechEffectDetails(agent.id, speechHistory, state),
    activeEffectSummaries: buildActiveEffectSummaries(agent.id, state),
  };
}

/**
 * observerJoinerの内部状態と意思決定要因(最寄りの輪・attractiveness・離脱余力)を
 * 読み取り専用データとして組み立てる。SimulationStateは変更しない。
 * observerJoinerが一人もいない場合は空配列を返す。
 */
export function buildObserverJoinerInspection(
  state: SimulationState,
  params: SimParams,
): ObserverJoinerInspection[] {
  return state.agents.filter((agent) => agent.isObserverJoiner).map((agent) => buildInspection(agent, state, params));
}
