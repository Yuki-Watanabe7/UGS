/**
 * Issue #214 (standing-party Phase 4 分析): episode / contact / cluster / transition から
 * agent・cluster・run 粒度の記述統計と UI 向け時系列を決定的に導出する。
 * `docs/standing-party-analysis-phase4-model.md` §4 / §5 準拠。
 *
 * - 完了サンプルと active / censored を常に分離する
 * - 平均値だけでなく件数・中央値・分位点を返す(emptyは0で捏造しない)
 * - RNG非消費・入力非mutation・入力順序非依存
 * - `StandingPartyRunSummary`(#190)は維持し、本モジュールは横に載せる薄い層
 *
 * 会話履歴の構築は`standingPartyAnalysis.ts`側。本モジュールは履歴(+network)→統計のみを担い、
 * 相互importによる循環依存を避ける。便利関数`buildStandingPartyRunStatistics`は
 * `standingPartyAnalysis.ts`から公開する。
 */
import { buildContactNetworkFromHistory } from "./contactNetwork";
import { quantile } from "./quantiles";
import type {
  AgentState,
  ClusterLifetimeRecord,
  ClusterMembershipInterval,
  ClusterTransitionInvalidationReason,
  ClusterTransitionRecord,
  ClusterTransitionResult,
  ContactIntervalRecord,
  ConversationEpisodeEndReasonV2,
  ConversationEpisodeRecord,
  DistributionSummary,
  LogEntry,
  RateWithDenominator,
  SimulationEventType,
  SimulationState,
  StandingPartyAgentStatistics,
  StandingPartyClusterStatistics,
  StandingPartyContactNetwork,
  StandingPartyConversationHistory,
  StandingPartyObserverJoinerComparison,
  StandingPartyRunLevelStatistics,
  StandingPartyRunStatistics,
  StandingPartyStatisticsFilter,
  StandingPartyTimeSeries,
  StandingPartyTimeSeriesPoint,
} from "./types";
import { STANDING_PARTY_ANALYSIS_SCHEMA_VERSION } from "./types";

/** `buildStandingPartyStatisticsFromHistory`向け。filterフィールドをflatに受け取る */
export type BuildStandingPartyStatisticsOptions = StandingPartyStatisticsFilter & {
  asOfTick?: number;
  network?: StandingPartyContactNetwork;
  /** 時系列サンプル間隔。default 1。最終tickは必ず含める */
  seriesSampleIntervalTicks?: number;
};

const EMPTY_DISTRIBUTION: DistributionSummary = { count: 0 };

/**
 * 半開区間`[start, end)`を`[from, to)`でclipする。長さ0なら`undefined`。
 */
export function clipHalfOpenInterval(
  startTick: number,
  endTick: number,
  fromTick: number,
  toTick: number,
): { startTick: number; endTick: number; durationTicks: number } | undefined {
  const clippedStart = Math.max(startTick, fromTick);
  const clippedEnd = Math.min(endTick, toTick);
  if (clippedEnd <= clippedStart) return undefined;
  return {
    startTick: clippedStart,
    endTick: clippedEnd,
    durationTicks: clippedEnd - clippedStart,
  };
}

/**
 * 数値列の記述統計。NaN / Infinity / 負値を拒否。
 * 入力順序に依存しない。emptyは`{ count: 0 }`のみ(mean等を0で捏造しない)。
 */
export function summarizeDistribution(values: readonly number[]): DistributionSummary {
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`summarizeDistribution: non-finite value ${value}`);
    }
    if (value < 0) {
      throw new Error(`summarizeDistribution: negative value ${value}`);
    }
  }
  if (values.length === 0) return { ...EMPTY_DISTRIBUTION };

  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count,
    min: sorted[0],
    max: sorted[count - 1],
    mean: sum / count,
    median: quantile(sorted, 50),
    p10: quantile(sorted, 10),
    p25: quantile(sorted, 25),
    p75: quantile(sorted, 75),
    p90: quantile(sorted, 90),
    sum,
  };
}

/** 分母0のとき`rate`を`undefined`にする比率 */
export function rateWithDenominator(numerator: number, denominator: number): RateWithDenominator {
  if (denominator === 0) return { numerator, denominator };
  return { numerator, denominator, rate: numerator / denominator };
}

function normalizeIdSet(ids: readonly string[] | undefined): Set<string> | undefined {
  if (ids === undefined) return undefined;
  return new Set(ids);
}

function agentPassesObserverMode(
  isObserverJoiner: boolean,
  mode: StandingPartyStatisticsFilter["observerJoinerMode"],
): boolean {
  if (mode === "only") return isObserverJoiner;
  if (mode === "exclude") return !isObserverJoiner;
  return true;
}

function exclusiveEnd(endedAtTick: number | undefined, asOfTick: number): number {
  return endedAtTick ?? asOfTick;
}

function isTargetedTransition(transition: ClusterTransitionRecord): boolean {
  return transition.result !== "explore";
}

function isTargetedFailure(result: ClusterTransitionResult | undefined): boolean {
  return result === "invalidated" || result === "abandoned";
}

type AgentMeta = {
  agentId: string;
  label: string;
  isObserverJoiner: boolean;
  finalState: AgentState;
};

function buildAgentMetaMap(state: SimulationState): Map<string, AgentMeta> {
  const map = new Map<string, AgentMeta>();
  for (const agent of state.agents) {
    map.set(agent.id, {
      agentId: agent.id,
      label: agent.label,
      isObserverJoiner: agent.isObserverJoiner,
      finalState: agent.state,
    });
  }
  return map;
}

function toAppliedFilter(options: BuildStandingPartyStatisticsOptions): StandingPartyStatisticsFilter {
  return {
    fromTick: options.fromTick,
    toTick: options.toTick,
    agentIds: options.agentIds,
    clusterIds: options.clusterIds,
    observerJoinerMode: options.observerJoinerMode,
    endReasons: options.endReasons,
    transitionResults: options.transitionResults,
    includeActive: options.includeActive,
  };
}

function filterEpisodes(
  episodes: readonly ConversationEpisodeRecord[],
  filter: StandingPartyStatisticsFilter,
  fromTick: number,
  toTick: number,
  asOfTick: number,
  agentMeta: Map<string, AgentMeta>,
  agentFilter: Set<string> | undefined,
  clusterFilter: Set<string> | undefined,
): ConversationEpisodeRecord[] {
  const includeActive = filter.includeActive !== false;
  const endReasonFilter =
    filter.endReasons !== undefined ? new Set<ConversationEpisodeEndReasonV2>(filter.endReasons) : undefined;
  const mode = filter.observerJoinerMode ?? "all";
  const out: ConversationEpisodeRecord[] = [];

  for (const episode of episodes) {
    if (agentFilter && !agentFilter.has(episode.agentId)) continue;
    if (clusterFilter && !clusterFilter.has(episode.clusterId)) continue;
    const meta = agentMeta.get(episode.agentId);
    if (meta && !agentPassesObserverMode(meta.isObserverJoiner, mode)) continue;

    const end = exclusiveEnd(episode.endedAtTick, asOfTick);
    const clipped = clipHalfOpenInterval(episode.startedAtTick, end, fromTick, toTick);
    if (!clipped) continue;

    if (episode.status === "completed") {
      if (endReasonFilter && (episode.endReason === undefined || !endReasonFilter.has(episode.endReason))) {
        continue;
      }
    } else if (!includeActive) {
      continue;
    } else if (endReasonFilter) {
      continue;
    }

    out.push({
      ...episode,
      startedAtTick: clipped.startTick,
      endedAtTick:
        episode.endedAtTick !== undefined ? Math.min(episode.endedAtTick, toTick) : undefined,
      dwellTicks: clipped.durationTicks,
    });
  }
  return out;
}

function filterMemberships(
  intervals: readonly ClusterMembershipInterval[],
  fromTick: number,
  toTick: number,
  asOfTick: number,
  agentFilter: Set<string> | undefined,
  clusterFilter: Set<string> | undefined,
  includeActive: boolean,
  allowedEpisodeIds: Set<string> | undefined,
): ClusterMembershipInterval[] {
  const out: ClusterMembershipInterval[] = [];
  for (const interval of intervals) {
    if (agentFilter && !agentFilter.has(interval.agentId)) continue;
    if (clusterFilter && !clusterFilter.has(interval.clusterId)) continue;
    if (allowedEpisodeIds && !allowedEpisodeIds.has(interval.episodeId)) continue;
    if (interval.status !== "completed" && !includeActive) continue;
    const end = exclusiveEnd(interval.endedAtTick, asOfTick);
    const clipped = clipHalfOpenInterval(interval.startedAtTick, end, fromTick, toTick);
    if (!clipped) continue;
    out.push({
      ...interval,
      startedAtTick: clipped.startTick,
      endedAtTick:
        interval.endedAtTick !== undefined ? Math.min(interval.endedAtTick, toTick) : undefined,
    });
  }
  return out;
}

function filterLifetimes(
  lifetimes: readonly ClusterLifetimeRecord[],
  fromTick: number,
  toTick: number,
  asOfTick: number,
  clusterFilter: Set<string> | undefined,
  includeActive: boolean,
): ClusterLifetimeRecord[] {
  const out: ClusterLifetimeRecord[] = [];
  for (const lifetime of lifetimes) {
    if (clusterFilter && !clusterFilter.has(lifetime.clusterId)) continue;
    if (lifetime.status !== "completed" && !includeActive) continue;
    const end = exclusiveEnd(lifetime.endedAtTick, asOfTick);
    if (!clipHalfOpenInterval(lifetime.createdAtTick, end, fromTick, toTick)) continue;
    out.push(lifetime);
  }
  return out;
}

function filterTransitions(
  transitions: readonly ClusterTransitionRecord[],
  filter: StandingPartyStatisticsFilter,
  fromTick: number,
  toTick: number,
  agentFilter: Set<string> | undefined,
  clusterFilter: Set<string> | undefined,
  agentMeta: Map<string, AgentMeta>,
): ClusterTransitionRecord[] {
  const resultFilter =
    filter.transitionResults !== undefined
      ? new Set<ClusterTransitionResult>(filter.transitionResults)
      : undefined;
  const mode = filter.observerJoinerMode ?? "all";
  const out: ClusterTransitionRecord[] = [];
  for (const transition of transitions) {
    if (agentFilter && !agentFilter.has(transition.agentId)) continue;
    const meta = agentMeta.get(transition.agentId);
    if (meta && !agentPassesObserverMode(meta.isObserverJoiner, mode)) continue;
    if (
      clusterFilter &&
      !clusterFilter.has(transition.sourceClusterId) &&
      (transition.targetClusterId === undefined || !clusterFilter.has(transition.targetClusterId))
    ) {
      continue;
    }
    if (transition.startedAtTick < fromTick || transition.startedAtTick >= toTick) continue;
    if (resultFilter) {
      if (transition.result === undefined || !resultFilter.has(transition.result)) continue;
    }
    out.push(transition);
  }
  return out;
}

function filterContactIntervals(
  intervals: readonly ContactIntervalRecord[],
  fromTick: number,
  toTick: number,
  asOfTick: number,
  agentFilter: Set<string> | undefined,
  clusterFilter: Set<string> | undefined,
  includeActive: boolean,
): ContactIntervalRecord[] {
  const out: ContactIntervalRecord[] = [];
  for (const interval of intervals) {
    if (agentFilter && (!agentFilter.has(interval.agentIdA) || !agentFilter.has(interval.agentIdB))) {
      continue;
    }
    if (clusterFilter && !clusterFilter.has(interval.clusterId)) continue;
    if (interval.status !== "completed" && !includeActive) continue;
    const end = exclusiveEnd(interval.endedAtTick, asOfTick);
    const clipped = clipHalfOpenInterval(interval.startedAtTick, end, fromTick, toTick);
    if (!clipped) continue;
    out.push({
      ...interval,
      startedAtTick: clipped.startTick,
      endedAtTick:
        interval.endedAtTick !== undefined ? Math.min(interval.endedAtTick, toTick) : undefined,
      dwellTicks: clipped.durationTicks,
    });
  }
  return out;
}

function countStayEvents(
  log: readonly LogEntry[],
  agentId: string,
  fromTick: number,
  toTick: number,
): { attachment: number; concern: number; mixed: number } {
  let attachment = 0;
  let concern = 0;
  let mixed = 0;
  for (const entry of log) {
    if (entry.eventType !== "clusterTransitionInhibited") continue;
    if (entry.metadata?.agentId !== agentId) continue;
    if (entry.tick < fromTick || entry.tick >= toTick) continue;
    const reason = entry.metadata?.departureReason;
    if (reason === "stayedByAttachment") attachment += 1;
    else if (reason === "stayedByDepartureConcern") concern += 1;
    else if (reason === "stayedByMixedInhibition") mixed += 1;
  }
  return { attachment, concern, mixed };
}

function findVenueExitTick(log: readonly LogEntry[], agentId: string): number | undefined {
  for (const entry of log) {
    if (entry.eventType === "observerLeft" && entry.metadata?.agentId === agentId) {
      return entry.tick;
    }
  }
  return undefined;
}

function buildAgentStatistics(args: {
  state: SimulationState;
  episodes: readonly ConversationEpisodeRecord[];
  transitions: readonly ClusterTransitionRecord[];
  contactIntervals: readonly ContactIntervalRecord[];
  fromTick: number;
  toTick: number;
  agentMeta: Map<string, AgentMeta>;
  agentFilter: Set<string> | undefined;
  observerJoinerMode: StandingPartyStatisticsFilter["observerJoinerMode"];
}): StandingPartyAgentStatistics[] {
  const {
    state,
    episodes,
    transitions,
    contactIntervals,
    fromTick,
    toTick,
    agentMeta,
    agentFilter,
    observerJoinerMode,
  } = args;
  const mode = observerJoinerMode ?? "all";

  const agents = [...state.agents]
    .filter((agent) => {
      if (agentFilter && !agentFilter.has(agent.id)) return false;
      return agentPassesObserverMode(agent.isObserverJoiner, mode);
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const episodesByAgent = new Map<string, ConversationEpisodeRecord[]>();
  for (const episode of episodes) {
    const list = episodesByAgent.get(episode.agentId) ?? [];
    list.push(episode);
    episodesByAgent.set(episode.agentId, list);
  }

  const transitionsByAgent = new Map<string, ClusterTransitionRecord[]>();
  for (const transition of transitions) {
    const list = transitionsByAgent.get(transition.agentId) ?? [];
    list.push(transition);
    transitionsByAgent.set(transition.agentId, list);
  }

  const contactsByAgent = new Map<string, ContactIntervalRecord[]>();
  for (const interval of contactIntervals) {
    for (const agentId of [interval.agentIdA, interval.agentIdB]) {
      const list = contactsByAgent.get(agentId) ?? [];
      list.push(interval);
      contactsByAgent.set(agentId, list);
    }
  }

  return agents.map((agent) => {
    const agentEpisodes = episodesByAgent.get(agent.id) ?? [];
    const completed = agentEpisodes.filter((e) => e.status === "completed");
    const active = agentEpisodes.filter((e) => e.status !== "completed");
    const currentEpisodeDwellTicks =
      active.length === 0 ? undefined : active.reduce((sum, e) => sum + e.dwellTicks, 0);

    const clusters = new Set(agentEpisodes.map((e) => e.clusterId));
    const voluntaryDepartureCount = completed.filter((e) => e.endReason === "voluntaryDeparture").length;
    const forcedReleaseCount = completed.filter((e) => e.endReason === "memberReleased").length;

    const agentTransitions = transitionsByAgent.get(agent.id) ?? [];
    const explore = agentTransitions.filter((t) => t.result === "explore");
    const targeted = agentTransitions.filter(isTargetedTransition);
    const success = targeted.filter((t) => t.result === "completed").length;
    const failure = targeted.filter((t) => isTargetedFailure(t.result)).length;
    const fallback = targeted.filter((t) => t.result === "abandoned").length;

    const contacts = contactsByAgent.get(agent.id) ?? [];
    const partners = new Set<string>();
    let totalContactTicks = 0;
    for (const interval of contacts) {
      partners.add(interval.agentIdA === agent.id ? interval.agentIdB : interval.agentIdA);
      totalContactTicks += interval.dwellTicks;
    }

    const stays = countStayEvents(state.log, agent.id, fromTick, toTick);
    const venueExitTick = findVenueExitTick(state.log, agent.id);
    const meta = agentMeta.get(agent.id)!;

    return {
      agentId: agent.id,
      label: meta.label,
      isObserverJoiner: meta.isObserverJoiner,
      finalState: meta.finalState,
      startedEpisodeCount: agentEpisodes.length,
      completedEpisodeCount: completed.length,
      activeEpisodeCount: active.length,
      completedDwellTicks: summarizeDistribution(completed.map((e) => e.dwellTicks)),
      currentEpisodeDwellTicks,
      distinctContactCount: partners.size,
      contactIntervalCount: contacts.length,
      totalContactTicks,
      joinedClusterCount: agentEpisodes.length,
      distinctClusterCount: clusters.size,
      voluntaryDepartureCount,
      forcedReleaseCount,
      departAndExploreCount: explore.length,
      targetedTransitionStartedCount: targeted.length,
      targetedTransitionSuccessCount: success,
      targetedTransitionFailureCount: failure,
      targetedTransitionFallbackCount: fallback,
      targetedTransitionSuccessRate: rateWithDenominator(success, success + failure),
      stayedByAttachmentCount: stays.attachment,
      stayedByDepartureConcernCount: stays.concern,
      stayedByMixedInhibitionCount: stays.mixed,
      venueExitTick,
      hasExitedVenue: meta.finalState === "left",
    };
  });
}

function computeMeanMemberCount(
  lifetime: ClusterLifetimeRecord,
  memberships: readonly ClusterMembershipInterval[],
  asOfTick: number,
  fromTick: number,
  toTick: number,
): { lifetimeTicks: number; meanMemberCount?: number; finalMemberCount: number; uniqueMemberCount: number } {
  const lifeStart = Math.max(lifetime.createdAtTick, fromTick);
  const lifeEnd = Math.min(exclusiveEnd(lifetime.endedAtTick, asOfTick), toTick);
  const lifetimeTicks = Math.max(0, lifeEnd - lifeStart);

  const clusterMemberships = memberships.filter((m) => m.clusterId === lifetime.clusterId);
  const unique = new Set(clusterMemberships.map((m) => m.agentId));

  let memberTickSum = 0;
  for (const membership of clusterMemberships) {
    const mEnd = exclusiveEnd(membership.endedAtTick, asOfTick);
    const clipped = clipHalfOpenInterval(membership.startedAtTick, mEnd, lifeStart, lifeEnd);
    if (clipped) memberTickSum += clipped.durationTicks;
  }

  let finalMemberCount = 0;
  if (lifetimeTicks > 0) {
    const probeTick = Math.max(lifeStart, lifeEnd - 1);
    for (const membership of clusterMemberships) {
      const mEnd = exclusiveEnd(membership.endedAtTick, asOfTick);
      if (membership.startedAtTick <= probeTick && probeTick < mEnd) finalMemberCount += 1;
    }
  }

  return {
    lifetimeTicks,
    meanMemberCount: lifetimeTicks === 0 ? undefined : memberTickSum / lifetimeTicks,
    finalMemberCount,
    uniqueMemberCount: unique.size,
  };
}

function buildClusterStatistics(args: {
  lifetimes: readonly ClusterLifetimeRecord[];
  memberships: readonly ClusterMembershipInterval[];
  transitions: readonly ClusterTransitionRecord[];
  asOfTick: number;
  fromTick: number;
  toTick: number;
}): StandingPartyClusterStatistics[] {
  const { lifetimes, memberships, transitions, asOfTick, fromTick, toTick } = args;
  const sorted = [...lifetimes].sort((a, b) => a.clusterId.localeCompare(b.clusterId));

  return sorted.map((lifetime) => {
    const { lifetimeTicks, meanMemberCount, finalMemberCount, uniqueMemberCount } = computeMeanMemberCount(
      lifetime,
      memberships,
      asOfTick,
      fromTick,
      toTick,
    );

    let activeDurationTicks: number | undefined;
    if (lifetime.confirmedAtTick !== undefined) {
      const clipped = clipHalfOpenInterval(
        lifetime.confirmedAtTick,
        exclusiveEnd(lifetime.endedAtTick, asOfTick),
        fromTick,
        toTick,
      );
      activeDurationTicks = clipped?.durationTicks ?? 0;
    }

    const joinCount = lifetime.joinCount;
    const voluntaryLeaveCount = lifetime.voluntaryLeaveCount;
    const forcedReleaseCount = lifetime.forcedReleaseCount;
    const turnoverRate = (voluntaryLeaveCount + forcedReleaseCount) / Math.max(joinCount, 1);

    let inflow = 0;
    let outflow = 0;
    for (const transition of transitions) {
      if (!isTargetedTransition(transition) || transition.result !== "completed") continue;
      if (transition.targetClusterId === lifetime.clusterId) inflow += 1;
      if (transition.sourceClusterId === lifetime.clusterId) outflow += 1;
    }

    return {
      clusterId: lifetime.clusterId,
      founderAgentId: lifetime.founderAgentId,
      createdAtTick: lifetime.createdAtTick,
      confirmedAtTick: lifetime.confirmedAtTick,
      endedAtTick: lifetime.endedAtTick,
      status: lifetime.status,
      endReason: lifetime.endReason,
      lifetimeTicks,
      activeDurationTicks,
      peakMemberCount: lifetime.peakMemberCount,
      meanMemberCount,
      finalMemberCount,
      uniqueMemberCount,
      joinCount,
      voluntaryLeaveCount,
      forcedReleaseCount,
      turnoverRate,
      targetedTransitionInflowCount: inflow,
      targetedTransitionOutflowCount: outflow,
    };
  });
}

function buildRunLevelStatistics(args: {
  state: SimulationState;
  agentStats: readonly StandingPartyAgentStatistics[];
  clusterStats: readonly StandingPartyClusterStatistics[];
  episodes: readonly ConversationEpisodeRecord[];
  transitions: readonly ClusterTransitionRecord[];
  contactIntervals: readonly ContactIntervalRecord[];
  network: StandingPartyContactNetwork;
  fromTick: number;
  toTick: number;
  asOfTick: number;
}): StandingPartyRunLevelStatistics {
  const {
    state,
    agentStats,
    clusterStats,
    episodes,
    transitions,
    contactIntervals,
    network,
    fromTick,
    toTick,
    asOfTick,
  } = args;

  const completedEpisodes = episodes.filter((e) => e.status === "completed");
  const activeEpisodes = episodes.filter((e) => e.status !== "completed");
  const completedLifetimes = clusterStats.filter((c) => c.status === "completed");

  const populationSize = state.agents.length;
  const edgeCount = network.edges.length;
  // ADR §4.3 推奨: density分母はrun開始時population。n<2は ContactNetworkMetrics と同様 rate=0。
  const networkDensityVsPopulation: RateWithDenominator =
    populationSize < 2
      ? { numerator: 0, denominator: 0, rate: 0 }
      : rateWithDenominator(2 * edgeCount, populationSize * (populationSize - 1));

  const voluntaryDepartureCount = agentStats.reduce((s, a) => s + a.voluntaryDepartureCount, 0);
  const forcedReleaseCount = agentStats.reduce((s, a) => s + a.forcedReleaseCount, 0);

  const targeted = transitions.filter(isTargetedTransition);
  const success = targeted.filter((t) => t.result === "completed").length;
  const failure = targeted.filter((t) => isTargetedFailure(t.result)).length;
  const failureByReason: Partial<Record<ClusterTransitionInvalidationReason, number>> = {};
  for (const transition of targeted) {
    if (transition.result !== "invalidated" || transition.invalidationReason === undefined) continue;
    failureByReason[transition.invalidationReason] =
      (failureByReason[transition.invalidationReason] ?? 0) + 1;
  }

  const activeContactIntervalCountAtAsOf = contactIntervals.filter((interval) => {
    const end = exclusiveEnd(interval.endedAtTick, asOfTick);
    return interval.startedAtTick <= asOfTick && asOfTick < end && interval.status !== "completed";
  }).length;

  return {
    populationSize,
    observationFromTick: fromTick,
    observationToTick: toTick,
    asOfTick,
    completedEpisodeDwellTicks: summarizeDistribution(completedEpisodes.map((e) => e.dwellTicks)),
    activeEpisodeCount: activeEpisodes.length,
    completedEpisodeCount: completedEpisodes.length,
    agentDistinctContactCounts: summarizeDistribution(agentStats.map((a) => a.distinctContactCount)),
    pairContactDurationTicks: summarizeDistribution(contactIntervals.map((c) => c.dwellTicks)),
    completedClusterLifetimeTicks: summarizeDistribution(completedLifetimes.map((c) => c.lifetimeTicks)),
    completedClusterPeakSizes: summarizeDistribution(completedLifetimes.map((c) => c.peakMemberCount)),
    clusterCreatedCount: clusterStats.length,
    clusterEndedCount: completedLifetimes.length,
    activeClusterCountAtAsOf: clusterStats.filter((c) => c.status !== "completed").length,
    network: network.metrics,
    networkDensityVsPopulation,
    voluntaryDepartureCount,
    forcedReleaseCount,
    voluntaryDepartureShare: rateWithDenominator(
      voluntaryDepartureCount,
      voluntaryDepartureCount + forcedReleaseCount,
    ),
    targetedTransitionSuccessCount: success,
    targetedTransitionFailureCount: failure,
    targetedTransitionFailureByReason: failureByReason,
    targetedTransitionSuccessRate: rateWithDenominator(success, success + failure),
    venueExitCount: agentStats.filter((a) => a.hasExitedVenue).length,
    activeEpisodeCountAtAsOf: activeEpisodes.filter((e) => {
      const end = exclusiveEnd(e.endedAtTick, asOfTick);
      return e.startedAtTick <= asOfTick && asOfTick < end;
    }).length,
    activeContactIntervalCountAtAsOf,
  };
}

function buildObserverJoinerComparison(
  agentStats: readonly StandingPartyAgentStatistics[],
  episodes: readonly ConversationEpisodeRecord[],
): StandingPartyObserverJoinerComparison {
  const observerJoiners = agentStats.filter((a) => a.isObserverJoiner);
  const nonOj = agentStats.filter((a) => !a.isObserverJoiner);
  const nonOjIds = new Set(nonOj.map((a) => a.agentId));

  const nonOjSuccess = nonOj.reduce((s, a) => s + a.targetedTransitionSuccessCount, 0);
  const nonOjFailure = nonOj.reduce((s, a) => s + a.targetedTransitionFailureCount, 0);
  const venueExitCount = nonOj.filter((a) => a.hasExitedVenue).length;
  const nonOjCompletedDwells = episodes
    .filter((e) => e.status === "completed" && nonOjIds.has(e.agentId))
    .map((e) => e.dwellTicks);

  return {
    observerJoiners,
    nonObserverJoinerGroup: {
      agentCount: nonOj.length,
      episodeCount: summarizeDistribution(nonOj.map((a) => a.startedEpisodeCount)),
      completedDwellTicks: summarizeDistribution(nonOjCompletedDwells),
      distinctContactCount: summarizeDistribution(nonOj.map((a) => a.distinctContactCount)),
      targetedTransitionStartedCount: summarizeDistribution(
        nonOj.map((a) => a.targetedTransitionStartedCount),
      ),
      targetedTransitionSuccessRate: rateWithDenominator(nonOjSuccess, nonOjSuccess + nonOjFailure),
      stayedByAttachmentCount: summarizeDistribution(nonOj.map((a) => a.stayedByAttachmentCount)),
      stayedByDepartureConcernCount: summarizeDistribution(
        nonOj.map((a) => a.stayedByDepartureConcernCount),
      ),
      venueExitCount,
      venueExitRate: rateWithDenominator(venueExitCount, nonOj.length),
    },
  };
}

function buildSampleTicks(fromTick: number, toTick: number, sampleIntervalTicks: number): number[] {
  const interval = Math.max(1, Math.floor(sampleIntervalTicks));
  if (toTick < fromTick) return [];
  const ticks: number[] = [];
  for (let t = fromTick; t <= toTick; t += interval) {
    ticks.push(t);
  }
  if (ticks.length === 0 || ticks[ticks.length - 1] !== toTick) {
    ticks.push(toTick);
  }
  return ticks;
}

type AgentStateCensus = Record<
  "undecided" | "approaching" | "forming" | "joined" | "leaving" | "left",
  number
>;

const JOIN_EVENTS: ReadonlySet<SimulationEventType> = new Set([
  "agentJoined",
  "observerJoinedForming",
  "observerJoinedConfirmed",
  "clusterRejoined",
  "clusterTransitionCompleted",
]);

function applyEventToAgentState(states: Map<string, AgentState>, entry: LogEntry): void {
  const agentId = entry.metadata?.agentId;
  if (!agentId || !entry.eventType) return;
  const eventType = entry.eventType;

  if (eventType === "agentApproached" || eventType === "observerApproached") {
    states.set(agentId, "approaching");
    return;
  }
  if (eventType === "approachTargetInvalidated" || eventType === "searchRestarted") {
    states.set(agentId, "undecided");
    return;
  }
  if (JOIN_EVENTS.has(eventType)) {
    states.set(agentId, "joined");
    return;
  }
  if (
    eventType === "clusterDepartureCompleted" ||
    eventType === "clusterMemberReleased" ||
    eventType === "clusterMembershipLost" ||
    eventType === "clusterDepartureStarted" ||
    eventType === "clusterTransitionTargetSelected" ||
    eventType === "clusterTransitionAbandoned"
  ) {
    states.set(agentId, "undecided");
    return;
  }
  if (eventType === "observerLeaveStarted") {
    states.set(agentId, "leaving");
    return;
  }
  if (eventType === "observerLeft") {
    states.set(agentId, "left");
    return;
  }
  if (eventType === "nucleusCreated") {
    states.set(agentId, "forming");
  }
}

function censusFromStates(states: Map<string, AgentState>, population: number): AgentStateCensus {
  const counts: AgentStateCensus = {
    undecided: 0,
    approaching: 0,
    forming: 0,
    joined: 0,
    leaving: 0,
    left: 0,
  };
  for (const state of states.values()) {
    if (state in counts) {
      counts[state as keyof AgentStateCensus] += 1;
    }
  }
  const known = Object.values(counts).reduce((a, b) => a + b, 0);
  if (known < population) counts.undecided += population - known;
  return counts;
}

function countCovering(
  intervals: readonly { startedAtTick: number; endedAtTick?: number }[],
  tick: number,
  asOfTick: number,
): number {
  let count = 0;
  for (const interval of intervals) {
    const end = exclusiveEnd(interval.endedAtTick, asOfTick);
    if (interval.startedAtTick <= tick && tick < end) count += 1;
  }
  return count;
}

function countActiveClusters(
  lifetimes: readonly ClusterLifetimeRecord[],
  tick: number,
  asOfTick: number,
): number {
  let count = 0;
  for (const lifetime of lifetimes) {
    const end = exclusiveEnd(lifetime.endedAtTick, asOfTick);
    if (lifetime.createdAtTick <= tick && tick < end) count += 1;
  }
  return count;
}

/**
 * UI向け時系列。membership / contact / lifetime / transition / log から決定的に構築する。
 * agent状態は構造化イベントの best-effort 再構成(最終tickはlive stateで補正)。
 */
export function buildStandingPartyTimeSeries(args: {
  state: SimulationState;
  lifetimes: readonly ClusterLifetimeRecord[];
  memberships: readonly ClusterMembershipInterval[];
  contactIntervals: readonly ContactIntervalRecord[];
  episodes: readonly ConversationEpisodeRecord[];
  transitions: readonly ClusterTransitionRecord[];
  fromTick: number;
  toTick: number;
  asOfTick: number;
  sampleIntervalTicks: number;
}): StandingPartyTimeSeries {
  const {
    state,
    lifetimes,
    memberships,
    contactIntervals,
    episodes,
    transitions,
    fromTick,
    toTick,
    asOfTick,
    sampleIntervalTicks,
  } = args;

  const sampleTicks = buildSampleTicks(fromTick, toTick, sampleIntervalTicks);
  const agentStates = new Map<string, AgentState>();
  for (const agent of state.agents) {
    agentStates.set(agent.id, "undecided");
  }

  const log = [...state.log].sort((a, b) => a.tick - b.tick || a.message.localeCompare(b.message));
  let logIndex = 0;

  const edgeFirstTick = new Map<string, number>();
  for (const interval of contactIntervals) {
    const key =
      interval.agentIdA <= interval.agentIdB
        ? `${interval.agentIdA}:${interval.agentIdB}`
        : `${interval.agentIdB}:${interval.agentIdA}`;
    const prev = edgeFirstTick.get(key);
    if (prev === undefined || interval.startedAtTick < prev) {
      edgeFirstTick.set(key, interval.startedAtTick);
    }
  }
  const edgeStarts = [...edgeFirstTick.values()].sort((a, b) => a - b);

  const completedEpisodeEnds = episodes
    .filter((e) => e.status === "completed" && e.endedAtTick !== undefined)
    .map((e) => e.endedAtTick!)
    .sort((a, b) => a - b);

  const successTicks = transitions
    .filter((t) => isTargetedTransition(t) && t.result === "completed" && t.endedAtTick !== undefined)
    .map((t) => t.endedAtTick!)
    .sort((a, b) => a - b);
  const failureTicks = transitions
    .filter((t) => isTargetedTransition(t) && isTargetedFailure(t.result) && t.endedAtTick !== undefined)
    .map((t) => t.endedAtTick!)
    .sort((a, b) => a - b);

  const countUpTo = (sorted: readonly number[], tick: number): number => {
    let n = 0;
    for (const value of sorted) {
      if (value > tick) break;
      n += 1;
    }
    return n;
  };

  const points: StandingPartyTimeSeriesPoint[] = [];
  for (const tick of sampleTicks) {
    while (logIndex < log.length && log[logIndex].tick <= tick) {
      applyEventToAgentState(agentStates, log[logIndex]);
      logIndex += 1;
    }

    if (tick === asOfTick || tick === toTick) {
      for (const agent of state.agents) {
        agentStates.set(agent.id, agent.state);
      }
    }

    const census = censusFromStates(agentStates, state.agents.length);

    points.push({
      tick,
      activeClusterCount: countActiveClusters(lifetimes, tick, asOfTick),
      joinedCount: countCovering(memberships, tick, asOfTick),
      undecidedCount: census.undecided,
      approachingCount: census.approaching,
      formingCount: census.forming,
      leavingCount: census.leaving,
      leftCount: census.left,
      activeContactEdgeCount: (() => {
        const activePairs = new Set<string>();
        for (const interval of contactIntervals) {
          const end = exclusiveEnd(interval.endedAtTick, asOfTick);
          if (interval.startedAtTick <= tick && tick < end) {
            const key =
              interval.agentIdA <= interval.agentIdB
                ? `${interval.agentIdA}:${interval.agentIdB}`
                : `${interval.agentIdB}:${interval.agentIdA}`;
            activePairs.add(key);
          }
        }
        return activePairs.size;
      })(),
      cumulativeUniqueContactEdgeCount: countUpTo(edgeStarts, tick),
      cumulativeCompletedEpisodeCount: countUpTo(completedEpisodeEnds, tick),
      cumulativeTargetedTransitionSuccessCount: countUpTo(successTicks, tick),
      cumulativeTargetedTransitionFailureCount: countUpTo(failureTicks, tick),
    });
  }

  return {
    schemaVersion: STANDING_PARTY_ANALYSIS_SCHEMA_VERSION,
    fromTick,
    toTick,
    sampleIntervalTicks: Math.max(1, Math.floor(sampleIntervalTicks)),
    points,
  };
}

/**
 * 事前構築済みhistoryから Phase 4 統計snapshotを導出する。
 * 同一入力・同一optionsからは同一JSON結果。RNG非消費・入力非mutation。
 */
export function buildStandingPartyStatisticsFromHistory(
  state: SimulationState,
  history: StandingPartyConversationHistory,
  options?: BuildStandingPartyStatisticsOptions,
): StandingPartyRunStatistics {
  const opts = options ?? {};
  const filter = toAppliedFilter(opts);
  const asOfTick = opts.asOfTick ?? filter.toTick ?? state.tick;
  const fromTick = filter.fromTick ?? 0;
  const toTick = filter.toTick ?? asOfTick;
  const sampleIntervalTicks = opts.seriesSampleIntervalTicks ?? 1;
  const includeActive = filter.includeActive !== false;

  const network =
    opts.network ??
    buildContactNetworkFromHistory(state, history, {
      asOfTick,
      fromTick,
      toTick,
      includeActive,
      agentIds: filter.agentIds,
    });

  const agentMeta = buildAgentMetaMap(state);
  const agentFilter = normalizeIdSet(filter.agentIds);
  const clusterFilter = normalizeIdSet(filter.clusterIds);

  const episodes = filterEpisodes(
    history.episodes,
    filter,
    fromTick,
    toTick,
    asOfTick,
    agentMeta,
    agentFilter,
    clusterFilter,
  );
  const allowedEpisodeIds = new Set(episodes.map((e) => e.episodeId));
  const memberships = filterMemberships(
    history.membershipIntervals,
    fromTick,
    toTick,
    asOfTick,
    agentFilter,
    clusterFilter,
    includeActive,
    allowedEpisodeIds,
  );
  const lifetimes = filterLifetimes(
    history.clusterLifetimes,
    fromTick,
    toTick,
    asOfTick,
    clusterFilter,
    includeActive,
  );
  const transitions = filterTransitions(
    history.transitions,
    filter,
    fromTick,
    toTick,
    agentFilter,
    clusterFilter,
    agentMeta,
  );
  const contactIntervals = filterContactIntervals(
    network.contactIntervals,
    fromTick,
    toTick,
    asOfTick,
    agentFilter,
    clusterFilter,
    includeActive,
  );

  const agents = buildAgentStatistics({
    state,
    episodes,
    transitions,
    contactIntervals,
    fromTick,
    toTick,
    agentMeta,
    agentFilter,
    observerJoinerMode: filter.observerJoinerMode,
  });
  const clusters = buildClusterStatistics({
    lifetimes,
    memberships,
    transitions,
    asOfTick,
    fromTick,
    toTick,
  });
  const run = buildRunLevelStatistics({
    state,
    agentStats: agents,
    clusterStats: clusters,
    episodes,
    transitions,
    contactIntervals,
    network,
    fromTick,
    toTick,
    asOfTick,
  });
  const observerJoinerComparison = buildObserverJoinerComparison(agents, episodes);
  const series = buildStandingPartyTimeSeries({
    state,
    lifetimes,
    memberships,
    contactIntervals,
    episodes,
    transitions,
    fromTick,
    toTick,
    asOfTick,
    sampleIntervalTicks,
  });

  for (const agent of agents) {
    if (agent.totalContactTicks < 0 || !Number.isFinite(agent.totalContactTicks)) {
      throw new Error(`invalid totalContactTicks for ${agent.agentId}`);
    }
  }
  for (const cluster of clusters) {
    if (cluster.lifetimeTicks < 0 || !Number.isFinite(cluster.lifetimeTicks)) {
      throw new Error(`invalid lifetimeTicks for ${cluster.clusterId}`);
    }
    if (cluster.meanMemberCount !== undefined && !Number.isFinite(cluster.meanMemberCount)) {
      throw new Error(`invalid meanMemberCount for ${cluster.clusterId}`);
    }
  }

  return {
    schemaVersion: STANDING_PARTY_ANALYSIS_SCHEMA_VERSION,
    asOfTick,
    fromTick,
    toTick,
    filter,
    agents,
    clusters,
    run,
    observerJoinerComparison,
    series,
  };
}

/**
 * 入力stateをmutationしないことのテスト用アサーション。
 * `run`内で統計導出を実行し、前後でagents/logが変わっていないことを確認する。
 */
export function assertStatisticsDoesNotMutateState(
  state: SimulationState,
  run: () => unknown,
): void {
  const logLength = state.log.length;
  const agentSnap = state.agents.map((a) => ({
    id: a.id,
    state: a.state,
    stress: a.stress,
    joinedGroupId: a.joinedGroupId,
  }));
  run();
  if (state.log.length !== logLength) {
    throw new Error("statistics derivation mutated log length");
  }
  for (let i = 0; i < agentSnap.length; i++) {
    const agent = state.agents[i];
    const snap = agentSnap[i];
    if (
      agent.id !== snap.id ||
      agent.state !== snap.state ||
      agent.stress !== snap.stress ||
      agent.joinedGroupId !== snap.joinedGroupId
    ) {
      throw new Error("statistics derivation mutated agents");
    }
  }
}
