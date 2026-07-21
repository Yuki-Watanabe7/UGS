import type {
  Agent,
  GroupCandidate,
  MonteCarloRunResult,
  PairFormationAgentMetric,
  PairFormationMetricAverages,
  PairFormationMonteCarloSummary,
  PairFormationRunSummary,
  SimParams,
  SimulationState,
} from "./types";
import { computeStructuralUnassignedFloor, getFormationPolicyById, resolveNominalGroupCapacity } from "./formationPolicy";

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function rateOf(values: boolean[]): number {
  if (values.length === 0) return 0;
  return values.filter(Boolean).length / values.length;
}

/**
 * Issue #136: `agentId`が接近("approaching"への遷移)を開始した回数を、構造化イベントから数える。
 * 非observerJoinerは`agentApproached`、observerJoinerは`observerApproached`のいずれか一方のみが
 * 発生する(両方が同一agentに発生することはない)ため、単純に合算してよい。
 */
function approachCountFor(log: SimulationState["log"], agentId: string): number {
  return log.filter(
    (entry) =>
      (entry.eventType === "agentApproached" || entry.eventType === "observerApproached") &&
      entry.metadata?.agentId === agentId,
  ).length;
}

/** Issue #136: `agentId`の参加失敗(接近先の無効化 + 到着時の容量競合)の発生回数を構造化イベントから数える */
function joinFailureCountFor(log: SimulationState["log"], agentId: string): number {
  return log.filter(
    (entry) =>
      (entry.eventType === "approachTargetInvalidated" || entry.eventType === "joinFailedCapacity") &&
      entry.metadata?.agentId === agentId,
  ).length;
}

/** 成立済み(confirmed)候補が、全メンバー同一cliqueに属していたか("同一clique内ペア"とみなす) */
function isCliqueHomogeneous(candidate: GroupCandidate, agents: Agent[]): boolean {
  if (candidate.memberIds.length === 0) return false;
  const cliqueIds = candidate.memberIds.map((id) => agents.find((a) => a.id === id)?.cliqueId);
  const first = cliqueIds[0];
  return first !== undefined && cliqueIds.every((cliqueId) => cliqueId === first);
}

function buildAgentMetric(agent: Agent, log: SimulationState["log"]): PairFormationAgentMetric {
  return {
    agentId: agent.id,
    label: agent.label,
    isObserverJoiner: agent.isObserverJoiner,
    finalState: agent.state,
    approachCount: approachCountFor(log, agent.id),
    joinFailureCount: joinFailureCountFor(log, agent.id),
    searchRestartCount: agent.searchRestartCount ?? 0,
    capacityFailureCount: agent.capacityFailureCount ?? 0,
    maxStress: agent.maxStress ?? agent.stress,
    finalStress: agent.stress,
  };
}

function averagesFor(metrics: PairFormationAgentMetric[]): PairFormationMetricAverages {
  return {
    averageApproachCount: average(metrics.map((m) => m.approachCount)),
    averageJoinFailureCount: average(metrics.map((m) => m.joinFailureCount)),
    averageSearchRestartCount: average(metrics.map((m) => m.searchRestartCount)),
    averageCapacityFailureCount: average(metrics.map((m) => m.capacityFailureCount)),
    averageMaxStress: average(metrics.map((m) => m.maxStress)),
    averageFinalStress: average(metrics.map((m) => m.finalStress)),
  };
}

/**
 * SimulationStateから、ペア/グループ形成過程の負荷(未割当・参加失敗・再探索・stressのピーク・
 * clique内外の偏り)を集計した単発サマリーを導出する(Issue #136)。`state.log`の構造化イベント
 * (`eventType`/`metadata`)と`state.agents`のみを読み取り、表示用の`message`文言は一切参照しない。
 * SimulationStateはmutationしない。`finished: false`でも呼び出し可能(その時点までの暫定値)。
 */
export function buildPairFormationRunSummary(state: SimulationState, params: SimParams): PairFormationRunSummary {
  const groupConfirmedEntries = state.log.filter((entry) => entry.eventType === "groupConfirmed");
  const confirmedTicks = groupConfirmedEntries.map((entry) => entry.tick);
  const firstPairConfirmedTick = confirmedTicks.length === 0 ? undefined : Math.min(...confirmedTicks);
  const lastPairConfirmedTick = confirmedTicks.length === 0 ? undefined : Math.max(...confirmedTicks);

  const lastConfirmedEntry = groupConfirmedEntries.at(-1);
  const lastConfirmedGroupId = lastConfirmedEntry?.metadata?.groupId;
  const lastConfirmedGroup =
    lastConfirmedGroupId !== undefined
      ? state.groupCandidates.find((candidate) => candidate.id === lastConfirmedGroupId)
      : undefined;
  // GroupCandidate.memberIdsは常に追加(push)順のため、末尾が「その候補へ最後に加わったagent」になる
  const lastAssignedAgentId = lastConfirmedGroup?.memberIds.at(-1);
  const lastAssignedAgent =
    lastConfirmedEntry !== undefined && lastAssignedAgentId !== undefined && lastConfirmedGroupId !== undefined
      ? {
          agentId: lastAssignedAgentId,
          label: state.agents.find((agent) => agent.id === lastAssignedAgentId)?.label ?? lastAssignedAgentId,
          tick: lastConfirmedEntry.tick,
          groupId: lastConfirmedGroupId,
        }
      : undefined;

  const agentMetrics = state.agents.map((agent) => buildAgentMetric(agent, state.log));
  const observerJoinerMetrics = agentMetrics.filter((metric) => metric.isObserverJoiner);

  const confirmedGroups = state.groupCandidates.filter((candidate) => candidate.status === "confirmed");
  const homogeneousCount = confirmedGroups.filter((candidate) => isCliqueHomogeneous(candidate, state.agents)).length;
  const sameCliquePairRate = confirmedGroups.length === 0 ? undefined : homogeneousCount / confirmedGroups.length;
  const crossCliquePairRate = sameCliquePairRate === undefined ? undefined : 1 - sameCliquePairRate;

  const formationPolicy = getFormationPolicyById(
    state.formationScenarioId ?? "afterParty",
    state.formationDeadlineTick,
    state.formationClassroomGroupSize,
  );
  const capacity = resolveNominalGroupCapacity(formationPolicy, params);
  // Issue #154: 固定定員(min===max)・可変定員のどちらでも同じAPIで正しい構造的未割当人数を返す
  // (`computeStructuralUnassignedFloor`。固定定員では従来の`populationSize % minGroupSize`と同値)
  const structuralUnassignedFloor = Number.isFinite(capacity.maxGroupSize)
    ? computeStructuralUnassignedFloor(state.agents.length, capacity)
    : undefined;

  const unassignedCount = state.agents.filter((agent) => agent.state === "unassigned").length;
  const excessUnassignedCount =
    structuralUnassignedFloor === undefined ? undefined : Math.max(0, unassignedCount - structuralUnassignedFloor);

  return {
    confirmedPairCount: groupConfirmedEntries.length,
    firstPairConfirmedTick,
    lastPairConfirmedTick,
    assignedCount: state.agents.filter((agent) => agent.state === "joined").length,
    unassignedCount,
    lastAssignedAgent,
    agentMetrics,
    populationAverages: averagesFor(agentMetrics),
    observerJoinerAverages: averagesFor(observerJoinerMetrics),
    sameCliquePairRate,
    crossCliquePairRate,
    structuralUnassignedFloor,
    excessUnassignedCount,
  };
}

/**
 * `runs`(既存の主要指標が乗った`MonteCarloRunResult`)と`pairFormationRuns`
 * (`buildPairFormationRunSummary`の結果、`runs`と同じ順序・同じ長さ)から、
 * ペア/グループ形成過程のMonte Carlo集計値を導出する(Issue #136)。
 */
export function summarizePairFormationRuns(
  runs: MonteCarloRunResult[],
  pairFormationRuns: PairFormationRunSummary[],
): PairFormationMonteCarloSummary {
  const allAssignedRate = rateOf(pairFormationRuns.map((run) => run.unassignedCount === 0));

  const runsWithFloor = pairFormationRuns.filter((run) => run.structuralUnassignedFloor !== undefined);
  const allAssignableRate =
    runsWithFloor.length === 0 ? undefined : rateOf(runsWithFloor.map((run) => (run.excessUnassignedCount ?? 0) === 0));
  const averageExcessUnassignedCount =
    runsWithFloor.length === 0 ? undefined : average(runsWithFloor.map((run) => run.excessUnassignedCount ?? 0));

  const allAgentMetrics = pairFormationRuns.flatMap((run) => run.agentMetrics);
  const observerJoinerUnassignedFlags = allAgentMetrics
    .filter((metric) => metric.isObserverJoiner)
    .map((metric) => metric.finalState === "unassigned");
  const populationUnassignedFlags = allAgentMetrics.map((metric) => metric.finalState === "unassigned");

  const runsWithCliqueRate = pairFormationRuns.filter((run) => run.sameCliquePairRate !== undefined);
  const averageSameCliquePairRate =
    runsWithCliqueRate.length === 0 ? undefined : average(runsWithCliqueRate.map((run) => run.sameCliquePairRate!));
  const averageCrossCliquePairRate =
    runsWithCliqueRate.length === 0 ? undefined : average(runsWithCliqueRate.map((run) => run.crossCliquePairRate!));

  return {
    runs: pairFormationRuns.length,
    allAssignedRate,
    allAssignableRate,
    averageUnassignedCount: average(pairFormationRuns.map((run) => run.unassignedCount)),
    averageExcessUnassignedCount,
    unassignedRateByAttribute: {
      observerJoiner: rateOf(observerJoinerUnassignedFlags),
      population: rateOf(populationUnassignedFlags),
    },
    averageApproachCount: average(allAgentMetrics.map((metric) => metric.approachCount)),
    averageJoinFailureCount: average(allAgentMetrics.map((metric) => metric.joinFailureCount)),
    averageSearchRestartCount: average(allAgentMetrics.map((metric) => metric.searchRestartCount)),
    finishedTickDistribution: runs.map((run) => run.finishedTick),
    averageSameCliquePairRate,
    averageCrossCliquePairRate,
  };
}
