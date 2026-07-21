import type {
  Agent,
  AgentAssignmentStatus,
  ObserverActiveEffectStatus,
  ObserverJoinerInspection,
  ObserverSocialExpressionSnapshot,
  ObserverSpeechEffectDetail,
  ObserverSpeechHistoryEntry,
  ObserverTieSummary,
  ObserverTrustSummary,
  SimParams,
  SimulationState,
} from "./types";
import type { SpeechEvent } from "./speech";
import type { AggregatedActiveEffect, SpeechActiveEffect, SpeechEffectDimension, SpeechEffectEvent } from "./speechEffects";
import { aggregateActiveEffects } from "./speechEffects";
import type { PublicExpression } from "./socialExpression";
import { derivePrivateEvaluations, derivePublicExpressions } from "./socialExpression";
import { correctionFromHistory } from "./relationshipTie";
import { distance } from "./model";
import { attractiveness, nearestCandidate } from "./engine";

/**
 * Issue #119: 全observerJoinerで共有するPhase 4(本心/対外表現)の導出結果。
 * `derivePrivateEvaluations`/`derivePublicExpressions`は全agentを一度に評価するため、
 * observerJoiner 1人ごとに呼び直さず`buildObserverJoinerInspection`で一度だけ導出して使い回す。
 */
type Phase4Context = {
  publicExpressionByAgent: Map<string, PublicExpression>;
  privateJoinDesireByAgent: Map<string, number>;
  privateLeaveInclinationByAgent: Map<string, number>;
};

/**
 * `state`が示すtick時点の本心/対外表現を(socialExpression有効時のみ)全agdについて導出し、
 * agentIdで引ける形にまとめる。無効時は空のmapのみを持つcontextを返す(スナップショットはundefinedになる)。
 */
function buildPhase4Context(state: SimulationState, params: SimParams): Phase4Context {
  const config = { enabled: state.socialExpressionEnabled ?? false };
  const privates = derivePrivateEvaluations(state, params, config);
  const publics = derivePublicExpressions(privates, state, params, config);
  return {
    publicExpressionByAgent: new Map(publics.map((expression) => [expression.agentId, expression])),
    privateJoinDesireByAgent: new Map(privates.map((evaluation) => [evaluation.agentId, evaluation.joinDesire])),
    privateLeaveInclinationByAgent: new Map(
      privates.map((evaluation) => [evaluation.agentId, evaluation.leaveInclination]),
    ),
  };
}

/** `agentId`の本心/対外表現/乖離スナップショットを組み立てる(導出不能ならundefined) */
function buildSocialExpressionSnapshot(
  agentId: string,
  context: Phase4Context,
): ObserverSocialExpressionSnapshot | undefined {
  const expression = context.publicExpressionByAgent.get(agentId);
  const privateJoinDesire = context.privateJoinDesireByAgent.get(agentId);
  const privateLeaveInclination = context.privateLeaveInclinationByAgent.get(agentId);
  if (!expression || privateJoinDesire === undefined || privateLeaveInclination === undefined) return undefined;
  return {
    privateJoinDesire,
    expressedJoinDesire: expression.expressedJoinDesire,
    privateStance: expression.privateStance,
    expressedStance: expression.expressedStance,
    privateLeaveInclination,
    expressedLeaveInclination: expression.expressedLeaveInclination,
    divergent: expression.divergent,
    divergences: expression.divergences,
  };
}

/** `key`(= `${observerId}->${speakerId}`)から話者IDを取り出す。合致しなければundefined */
function speakerIdFromPairKey(key: string, observerId: string): string | undefined {
  const prefix = `${observerId}->`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

/**
 * このobserverJoiner(受け手)から見た、話者ごとの動的trust現在値と更新履歴を組み立てる(Issue #119)。
 * `state.speechTrust`に現在値を持つ話者、または`state.speechTrustUpdateLog`に更新履歴を持つ話者を
 * speakerId昇順で列挙する(どちらも無ければ空)。
 */
function buildTrustSummaries(observerId: string, state: SimulationState): ObserverTrustSummary[] {
  const trust = state.speechTrust ?? {};
  const updateLog = state.speechTrustUpdateLog ?? [];

  const updatesBySpeaker = new Map<string, ObserverTrustSummary["updates"]>();
  for (const update of updateLog) {
    if (update.observerId !== observerId) continue;
    const list = updatesBySpeaker.get(update.speakerId) ?? [];
    list.push(update);
    updatesBySpeaker.set(update.speakerId, list);
  }

  const dynamicValueBySpeaker = new Map<string, number>();
  for (const [key, value] of Object.entries(trust)) {
    const speakerId = speakerIdFromPairKey(key, observerId);
    if (speakerId !== undefined) dynamicValueBySpeaker.set(speakerId, value);
  }

  const speakerIds = new Set<string>([...dynamicValueBySpeaker.keys(), ...updatesBySpeaker.keys()]);
  return [...speakerIds]
    .sort()
    .map((speakerId) => {
      const updates = updatesBySpeaker.get(speakerId) ?? [];
      const dynamicValue = dynamicValueBySpeaker.get(speakerId);
      // 動的値があればそれ、無ければ(理論上稀)最新の更新後値へフォールバック
      const trustValue = dynamicValue ?? updates[updates.length - 1]?.newTrust ?? 0;
      return { speakerId, trust: trustValue, isDynamic: dynamicValue !== undefined, updates };
    });
}

/**
 * このobserverJoiner(受け手)から見た、話者ごとの関係性補正の現在値・寄与した整合性観測・更新履歴を
 * 組み立てる(Issue #119)。`state.tieHistory`に整合性履歴を持つ話者、または`relationshipTieUpdateLog`に
 * 更新履歴を持つ話者をspeakerId昇順で列挙する。
 */
function buildTieSummaries(observerId: string, state: SimulationState): ObserverTieSummary[] {
  const history = state.tieHistory ?? {};
  const updateLog = state.relationshipTieUpdateLog ?? [];

  const updatesBySpeaker = new Map<string, ObserverTieSummary["updates"]>();
  for (const update of updateLog) {
    if (update.observerId !== observerId) continue;
    const list = updatesBySpeaker.get(update.speakerId) ?? [];
    list.push(update);
    updatesBySpeaker.set(update.speakerId, list);
  }

  const observationsBySpeaker = new Map<string, ObserverTieSummary["observations"]>();
  for (const [key, observations] of Object.entries(history)) {
    const speakerId = speakerIdFromPairKey(key, observerId);
    if (speakerId !== undefined && observations.length > 0) observationsBySpeaker.set(speakerId, observations);
  }

  const speakerIds = new Set<string>([...observationsBySpeaker.keys(), ...updatesBySpeaker.keys()]);
  return [...speakerIds].sort().map((speakerId) => {
    const observations = observationsBySpeaker.get(speakerId) ?? [];
    return {
      speakerId,
      correction: correctionFromHistory(observations),
      observations,
      updates: updatesBySpeaker.get(speakerId) ?? [],
    };
  });
}

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

/** Issue #135: AgentStateと再探索回数から、学校ペア形成向けの表示状態を決定的に導出する */
function assignmentStatusFor(agent: Agent): AgentAssignmentStatus {
  if (agent.state === "joined") return "assigned";
  if (agent.state === "forming") return "waitingForPartner";
  if (agent.state === "approaching") return "approaching";
  if (agent.state === "unassigned") return "unassigned";
  if (agent.state === "leaving") return "leaving";
  if (agent.state === "left") return "left";
  return (agent.searchRestartCount ?? 0) > 0 ? "searchingAgain" : "searching";
}

function currentGroupIdFor(agent: Agent, state: SimulationState): string | undefined {
  if (agent.joinedGroupId !== undefined) return agent.joinedGroupId;
  if (agent.state !== "forming") return undefined;
  return state.groupCandidates.find((candidate) => candidate.memberIds.includes(agent.id))?.id;
}

function buildInspection(
  agent: Agent,
  state: SimulationState,
  params: SimParams,
  phase4: Phase4Context,
): ObserverJoinerInspection {
  const candidate = nearestCandidate(agent, state.groupCandidates);
  const speechHistory = buildSpeechHistory(agent.id, state.speechLog ?? []);
  const failureEntries = state.log.filter(
    (entry) =>
      (entry.eventType === "approachTargetInvalidated" || entry.eventType === "joinFailedCapacity") &&
      entry.metadata?.agentId === agent.id,
  );
  const lastFailure = failureEntries.at(-1);
  const currentGroupId = currentGroupIdFor(agent, state);

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
          0,
          state.activeInterventionEffects ?? [],
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
    socialExpression: buildSocialExpressionSnapshot(agent.id, phase4),
    trustSummaries: buildTrustSummaries(agent.id, state),
    tieSummaries: buildTieSummaries(agent.id, state),
    searchRestartCount: agent.searchRestartCount ?? 0,
    capacityFailureCount: agent.capacityFailureCount ?? 0,
    assignmentStatus: assignmentStatusFor(agent),
    approachTargetGroupId: agent.state === "approaching" ? agent.joinedGroupId : undefined,
    currentGroupId,
    joinFailureCount: failureEntries.length,
    lastFailureReason: lastFailure?.metadata?.reason,
    lastFailureTick: lastFailure?.tick,
  };
}

/**
 * Issue #135: 全agentの観察データをagent配列順で組み立てる。学校シナリオのagent Inspector向け。
 * 既存のobserverJoiner専用APIは下で従来どおりobserverのみを返し、後方互換を維持する。
 */
export function buildAgentInspection(state: SimulationState, params: SimParams): ObserverJoinerInspection[] {
  const phase4 = buildPhase4Context(state, params);
  return state.agents.map((agent) => buildInspection(agent, state, params, phase4));
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
  const phase4 = buildPhase4Context(state, params);
  return state.agents
    .filter((agent) => agent.isObserverJoiner)
    .map((agent) => buildInspection(agent, state, params, phase4));
}
