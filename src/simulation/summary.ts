import type {
  Agent,
  AgentState,
  LogEntry,
  ObserverJoinerRunSummary,
  Phase4RunSummary,
  SimulationEventType,
  SimulationState,
  SimulationSummary,
  SpeechEffectsRunSummary,
} from "./types";
import type { SpeechEffectDimension, SpeechEffectEvent } from "./speechEffects";

function ticksFor(log: LogEntry[], eventType: SimulationEventType, agentId?: string): number[] {
  return log
    .filter((entry) => entry.eventType === eventType && (agentId === undefined || entry.metadata?.agentId === agentId))
    .map((entry) => entry.tick);
}

function minTick(ticks: number[]): number | undefined {
  return ticks.length === 0 ? undefined : Math.min(...ticks);
}

function lastTick(ticks: number[]): number | undefined {
  return ticks.length === 0 ? undefined : ticks[ticks.length - 1];
}

function buildObserverJoinerRunSummary(
  agent: Agent,
  log: LogEntry[],
  firstGroupConfirmedTick: number | undefined,
): ObserverJoinerRunSummary {
  const approachedTick = lastTick(ticksFor(log, "observerApproached", agent.id));

  const joinedEntries = log.filter(
    (entry) =>
      (entry.eventType === "observerJoinedForming" || entry.eventType === "observerJoinedConfirmed") &&
      entry.metadata?.agentId === agent.id,
  );
  const joinedEntry = joinedEntries.at(-1);
  const joinedTick = joinedEntry?.tick;
  const joinedGroupStatus = joinedEntry?.metadata?.joinedGroupStatus;

  const leaveStartedTick = lastTick(ticksFor(log, "observerLeaveStarted", agent.id));
  const leftTick = lastTick(ticksFor(log, "observerLeft", agent.id));

  const lateJoinSucceeded =
    agent.state === "joined" &&
    (joinedGroupStatus === "confirmed" ||
      (firstGroupConfirmedTick !== undefined && joinedTick !== undefined && joinedTick > firstGroupConfirmedTick));

  return {
    agentId: agent.id,
    label: agent.label,
    finalState: agent.state,
    joinedGroupId: agent.joinedGroupId,
    approachedTick,
    joinedTick,
    joinedGroupStatus,
    leaveStartedTick,
    leftTick,
    lateJoinSucceeded,
  };
}

/**
 * SimulationStateから終了(または途中経過の暫定)サマリーを導出する。
 * `state.log`の構造化イベント(`eventType`/`metadata`)と`state.agents`のみを読み取り、
 * 表示用の`message`文言は一切参照しない。SimulationStateはmutationしない。
 */
export function buildSimulationSummary(state: SimulationState): SimulationSummary {
  const stateCounts: Record<AgentState, number> = {
    undecided: 0,
    forming: 0,
    approaching: 0,
    joined: 0,
    leaving: 0,
    left: 0,
    unassigned: 0,
  };
  for (const agent of state.agents) {
    stateCounts[agent.state] += 1;
  }

  const groupConfirmedTicks = ticksFor(state.log, "groupConfirmed");
  const firstGroupConfirmedTick = minTick(groupConfirmedTicks);

  const observerJoiners = state.agents
    .filter((agent) => agent.isObserverJoiner)
    .map((agent) => buildObserverJoinerRunSummary(agent, state.log, firstGroupConfirmedTick));

  const finishedEntry = state.log.find((entry) => entry.eventType === "simulationFinished");
  const finishedTick = state.finished ? (finishedEntry?.tick ?? state.tick) : undefined;
  const unassignedAgents = state.agents
    .filter((agent) => agent.state === "unassigned")
    .map((agent) => {
      const event = state.log.find(
        (entry) => entry.eventType === "agentUnassigned" && entry.metadata?.agentId === agent.id,
      );
      return {
        agentId: agent.id,
        label: agent.label,
        previousState: event?.metadata?.previousAgentState,
        targetGroupId: event?.metadata?.groupId,
        searchRestartCount: event?.metadata?.searchRestartCount ?? agent.searchRestartCount ?? 0,
        capacityFailureCount: event?.metadata?.capacityFailureCount ?? agent.capacityFailureCount ?? 0,
        lastFailedCandidateId: event?.metadata?.lastFailedCandidateId ?? agent.lastFailedCandidateId,
        stress: event?.metadata?.stress ?? agent.stress,
      };
    });

  return {
    finished: state.finished,
    finishedTick,
    finishReason: finishedEntry?.metadata?.finishReason,
    joinedCount: stateCounts.joined,
    leftCount: stateCounts.left,
    unassignedCount: stateCounts.unassigned,
    unassignedAgents,
    stateCounts,
    observerJoiners,
    firstNucleusTick: minTick(ticksFor(state.log, "nucleusCreated")),
    firstGroupConfirmedTick,
    confirmedGroupCount: groupConfirmedTicks.length,
    groupFailure: groupConfirmedTicks.length === 0,
  };
}

/**
 * `SpeechEffectDimension`ごとに、その効果が寄与したとみなせる構造化ログイベント種別(Issue #99)。
 * `transitionInfluenced`の判定にのみ使う。`stress`は蓄積率の緩和が「離脱しなかった」という
 * 非イベントにしか現れず対応する離散イベントを持たないため、意図的に空配列にしている
 * (`buildSpeechEffectsRunSummary`のコメント、および`docs/speech-effects-paired-monte-carlo.md`参照)。
 */
const DIMENSION_TRANSITION_EVENTS: Record<SpeechEffectDimension, SimulationEventType[]> = {
  approachProbability: ["observerApproached"],
  attractiveness: ["observerJoinedForming", "observerJoinedConfirmed"],
  leaveThreshold: ["observerLeaveStarted"],
  stress: [],
};

/**
 * `effect`の有効期間(`appliedTick`〜`appliedTick + durationTicks`)内に、同一受け手
 * (`LogEntry.metadata.agentId === effect.receiverId`)についてdimensionに対応する構造化ログイベントが
 * 存在するかを調べる。純粋関数(`log`を読み取るのみ)。
 */
function hasMatchingTransitionEvent(log: LogEntry[], effect: SpeechEffectEvent): boolean {
  const eventTypes = DIMENSION_TRANSITION_EVENTS[effect.dimension];
  if (eventTypes.length === 0) return false;
  const windowEnd = effect.appliedTick + effect.durationTicks;
  return log.some(
    (entry) =>
      entry.metadata?.agentId === effect.receiverId &&
      entry.eventType !== undefined &&
      (eventTypes as SimulationEventType[]).includes(entry.eventType) &&
      entry.tick >= effect.appliedTick &&
      entry.tick <= windowEnd,
  );
}

/**
 * SimulationStateから、Phase 3(発言効果)固有の観察指標(`SpeechEffectsRunSummary`)を導出する
 * (Issue #99)。`state.speechReceptionLog`/`speechInterpretationLog`/`speechEffectLog`/`log`/`agents`
 * のみを読み取り、SimulationStateはmutationしない。`speechEffectsEnabled`がfalse(または未指定)の
 * 場合、これらのログは常に空配列のため、全フィールドが「発生なし」を表す値になる。
 */
export function buildSpeechEffectsRunSummary(state: SimulationState): SpeechEffectsRunSummary {
  const observerJoinerIds = new Set(state.agents.filter((agent) => agent.isObserverJoiner).map((agent) => agent.id));
  const receptions = state.speechReceptionLog ?? [];
  const interpretations = state.speechInterpretationLog ?? [];
  const effects = state.speechEffectLog ?? [];

  const observerJoinerHeardSpeech = receptions.some(
    (reception) => reception.heard && observerJoinerIds.has(reception.receiverId),
  );
  const hadInterpretationOrEffect =
    interpretations.some((interpretation) => interpretation.valence !== "neutral") || effects.length > 0;

  const dimensionTotals: Record<SpeechEffectDimension, number> = {
    stress: 0,
    attractiveness: 0,
    approachProbability: 0,
    leaveThreshold: 0,
  };
  for (const effect of effects) {
    dimensionTotals[effect.dimension] += Math.abs(effect.outputValue);
  }

  const transitionInfluenced = effects.some((effect) => hasMatchingTransitionEvent(state.log, effect));

  return {
    observerJoinerHeardSpeech,
    hadInterpretationOrEffect,
    dimensionTotals,
    transitionInfluenced,
  };
}

/**
 * SimulationStateから、Phase 4(本心/建前の乖離・trust・関係性補正)固有の観察指標
 * (`Phase4RunSummary`)を導出する(Issue #120)。`state.speechLog`(`SpeechEvent.expression`)・
 * `speechTrustUpdateLog`・`relationshipTieUpdateLog`のみを読み取り、SimulationStateはmutationしない。
 * socialExpression/speechTrust/relationshipTieがいずれもfalse(または未指定)の場合、
 * これらのログは常に空のため、全フィールドが0(=乖離・trust変化・tie変化なし)になる。
 */
export function buildPhase4RunSummary(state: SimulationState): Phase4RunSummary {
  const expressedSpeech = (state.speechLog ?? []).filter((event) => event.expression !== undefined);
  const divergenceCount = expressedSpeech.filter((event) => event.expression!.divergent).length;

  const trustChangeAmount = (state.speechTrustUpdateLog ?? []).reduce(
    (sum, update) => sum + Math.abs(update.delta),
    0,
  );
  const tieChangeAmount = (state.relationshipTieUpdateLog ?? []).reduce(
    (sum, update) => sum + Math.abs(update.delta),
    0,
  );

  return {
    divergenceCount,
    expressedSpeechCount: expressedSpeech.length,
    trustChangeAmount,
    tieChangeAmount,
  };
}
