/**
 * Issue #190: standingPartyの比較プリセット(標準/ネットワーキング型/懇親型、#189)を、同一seed列・
 * 同一populationで定性的に比較するための集計層。`pairFormation.ts`(Issue #136)と同じ設計 ――
 * `state.log`の構造化イベント(`eventType`/`metadata`)と`state.agents`のみから導出する純粋関数群で、
 * 表示用の`message`文言は一切参照しない。SimulationStateはmutationしない。
 *
 * afterParty/classroomPairのrunに対して呼び出しても、対象イベント(`clusterDepartureCompleted`等)が
 * 一切発生しないため全フィールドが0/空になるだけで、既存挙動には影響しない
 * (`standingPartyDynamicCycle.test.ts`が立証済みの「他シナリオへclusterDeparture系イベントが
 * 混入しない」という前提の上に乗る)。
 */
import type {
  ClusterDeparturePrimaryReason,
  LogEntry,
  SimulationEventType,
  SimulationState,
  StandingPartyAgentMetric,
  StandingPartyDepartureReasonCounts,
  StandingPartyEpisodeDwellSample,
  StandingPartyMonteCarloSummary,
  StandingPartyRunSummary,
} from "./types";
import { quantile } from "./quantiles";

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** 平均のうち「対象runが1件もなければundefined」を表現する版(定義済みのrunだけを対象に平均する) */
function averageDefined(values: (number | undefined)[]): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length === 0 ? undefined : average(defined);
}

function entriesOfTypeForAgent(log: LogEntry[], eventType: SimulationEventType, agentId: string): LogEntry[] {
  return log.filter((entry) => entry.eventType === eventType && entry.metadata?.agentId === agentId);
}

/**
 * このagentが核形成/合流/再参加のいずれかで所属した、重複を除くcluster数。
 * `standingPartyDynamicCycle.test.ts`と同じ「参加を表すeventType一式」を使う。
 */
const JOIN_EVENT_TYPES: SimulationEventType[] = [
  "nucleusCreated",
  "agentJoined",
  "observerJoinedForming",
  "observerJoinedConfirmed",
  "clusterRejoined",
];

function distinctClusterCountFor(log: LogEntry[], agentId: string): number {
  const clusterIds = new Set<string>();
  for (const eventType of JOIN_EVENT_TYPES) {
    for (const entry of entriesOfTypeForAgent(log, eventType, agentId)) {
      if (entry.metadata?.groupId !== undefined) clusterIds.add(entry.metadata.groupId);
    }
  }
  return clusterIds.size;
}

const EMPTY_DEPARTURE_REASON_COUNTS: StandingPartyDepartureReasonCounts = {
  lowConversationSatisfaction: 0,
  socialCirculation: 0,
  mixedConversationAndSocialCirculation: 0,
};

function isPrimaryReason(value: unknown): value is ClusterDeparturePrimaryReason {
  return (
    value === "lowConversationSatisfaction" ||
    value === "socialCirculation" ||
    value === "mixedConversationAndSocialCirculation"
  );
}

/**
 * SimulationStateから、standingPartyの比較指標(単発run分)を導出する。`state.finished`を問わず
 * 呼び出し可能(その時点までの暫定値)。issue #190 5節の最低限の集計項目をカバーする。
 */
export function buildStandingPartyRunSummary(state: SimulationState): StandingPartyRunSummary {
  const log = state.log;

  const agentMetrics: StandingPartyAgentMetric[] = state.agents.map((agent) => ({
    agentId: agent.id,
    label: agent.label,
    finalState: agent.state,
    voluntaryDepartureCount: entriesOfTypeForAgent(log, "clusterDepartureCompleted", agent.id).length,
    forcedReleaseCount: entriesOfTypeForAgent(log, "clusterMemberReleased", agent.id).length,
    rejoinCount: entriesOfTypeForAgent(log, "clusterRejoined", agent.id).length,
    distinctClusterCount: distinctClusterCountFor(log, agent.id),
  }));

  const episodeDwellSamples: StandingPartyEpisodeDwellSample[] = [];
  const departureReasonCounts: StandingPartyDepartureReasonCounts = { ...EMPTY_DEPARTURE_REASON_COUNTS };

  for (const entry of log) {
    if (entry.eventType === "clusterDepartureCompleted") {
      const agentId = entry.metadata?.agentId;
      const clusterId = entry.metadata?.groupId;
      const ticksInCluster = entry.metadata?.ticksInCluster;
      const primaryReason = isPrimaryReason(entry.metadata?.departureReason) ? entry.metadata.departureReason : undefined;
      if (primaryReason !== undefined) {
        departureReasonCounts[primaryReason] += 1;
      }
      if (agentId !== undefined && clusterId !== undefined && ticksInCluster !== undefined) {
        episodeDwellSamples.push({ agentId, clusterId, ticksInCluster, endReason: "voluntaryDeparture", primaryReason });
      }
    } else if (entry.eventType === "clusterMemberReleased") {
      const agentId = entry.metadata?.agentId;
      const clusterId = entry.metadata?.groupId;
      const ticksInCluster = entry.metadata?.ticksInCluster;
      if (agentId !== undefined && clusterId !== undefined && ticksInCluster !== undefined) {
        episodeDwellSamples.push({ agentId, clusterId, ticksInCluster, endReason: "memberReleased" });
      }
    }
  }

  const dwellValues = episodeDwellSamples.map((sample) => sample.ticksInCluster);
  const meanCompletedEpisodeDwellTicks = dwellValues.length === 0 ? undefined : average(dwellValues);
  const medianCompletedEpisodeDwellTicks = dwellValues.length === 0 ? undefined : quantile(dwellValues, 50);

  const clusterDissolutionCount = new Set(
    log
      .filter((entry) => entry.eventType === "activeClusterDissolved")
      .map((entry) => entry.metadata?.groupId)
      .filter((groupId): groupId is string => groupId !== undefined),
  ).size;

  const venueExitCount = state.agents.filter((agent) => agent.state === "left").length;

  return {
    agentMetrics,
    totalVoluntaryDepartureCount: agentMetrics.reduce((sum, m) => sum + m.voluntaryDepartureCount, 0),
    totalForcedReleaseCount: agentMetrics.reduce((sum, m) => sum + m.forcedReleaseCount, 0),
    totalRejoinCount: agentMetrics.reduce((sum, m) => sum + m.rejoinCount, 0),
    averageDistinctClusterCountPerAgent: average(agentMetrics.map((m) => m.distinctClusterCount)),
    episodeDwellSamples,
    meanCompletedEpisodeDwellTicks,
    medianCompletedEpisodeDwellTicks,
    clusterDissolutionCount,
    venueExitCount,
    departureReasonCounts,
  };
}

/**
 * `runs`(`buildStandingPartyRunSummary`の結果一式、通常は固定seed列に対応する)から、
 * issue #190 5節のpaired比較(プリセット間の定性的比較)に使う集計値を導出する。
 */
export function summarizeStandingPartyRuns(runs: StandingPartyRunSummary[]): StandingPartyMonteCarloSummary {
  const allAgentMetrics = runs.flatMap((run) => run.agentMetrics);

  const departureReasonRateAverages: StandingPartyDepartureReasonCounts = { ...EMPTY_DEPARTURE_REASON_COUNTS };
  for (const reason of Object.keys(EMPTY_DEPARTURE_REASON_COUNTS) as ClusterDeparturePrimaryReason[]) {
    departureReasonRateAverages[reason] = average(runs.map((run) => run.departureReasonCounts[reason]));
  }

  return {
    runs: runs.length,
    averageVoluntaryDepartureCountPerAgent: average(allAgentMetrics.map((m) => m.voluntaryDepartureCount)),
    averageForcedReleaseCountPerAgent: average(allAgentMetrics.map((m) => m.forcedReleaseCount)),
    averageRejoinCountPerAgent: average(allAgentMetrics.map((m) => m.rejoinCount)),
    averageDistinctClusterCountPerAgent: average(allAgentMetrics.map((m) => m.distinctClusterCount)),
    averageMeanCompletedEpisodeDwellTicks: averageDefined(runs.map((run) => run.meanCompletedEpisodeDwellTicks)),
    averageMedianCompletedEpisodeDwellTicks: averageDefined(runs.map((run) => run.medianCompletedEpisodeDwellTicks)),
    averageClusterDissolutionCount: average(runs.map((run) => run.clusterDissolutionCount)),
    averageVenueExitCount: average(runs.map((run) => run.venueExitCount)),
    departureReasonRateAverages,
  };
}
