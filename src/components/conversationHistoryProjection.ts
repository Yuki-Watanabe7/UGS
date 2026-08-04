/**
 * Issue #215: `StandingPartyConversationHistory` → タイムライン表示用投影。
 * 履歴レコードを mutation せず、filter / 選択用の部分集合を返す。
 * 統計(#214)の完了分布用 clip とは別に、表示は元区間を保ちつつ交差判定のみ行う。
 */
import { clipHalfOpenInterval } from "../simulation/standingPartyAnalysis";
import type {
  AnalysisIntervalStatus,
  ClusterLifetimeRecord,
  ClusterTransitionRecord,
  ClusterTransitionResult,
  ConversationEpisodeEndReasonV2,
  ConversationEpisodeRecord,
  SimulationState,
  StandingPartyConversationHistory,
} from "../simulation/types";

export type ConversationHistoryMode = "agent" | "cluster";

export type ConversationHistoryIntervalStatusFilter = "all" | "active" | "completed";

/**
 * voluntary / forced / targeted は endReason の構造化値で区別する(文言解析なし)。
 * `targeted`は episode.endReason === "targetedTransition"、および
 * transition.result が explore 以外のものを含む。
 */
export type ConversationHistoryDepartureKindFilter =
  | "all"
  | "voluntary"
  | "forced"
  | "targeted";

export type ConversationHistoryViewFilter = {
  mode: ConversationHistoryMode;
  agentId?: string;
  clusterId?: string;
  /** 半開 `[fromTick, toTick)`。省略時は run 全体 */
  fromTick?: number;
  toTick?: number;
  endReasons?: readonly ConversationEpisodeEndReasonV2[];
  departureKind?: ConversationHistoryDepartureKindFilter;
  transitionResults?: readonly ClusterTransitionResult[];
  observerJoinerOnly?: boolean;
  intervalStatus?: ConversationHistoryIntervalStatusFilter;
  /** agent label / id、cluster id の部分一致(大小文字無視) */
  searchQuery?: string;
};

export type ConversationHistorySelection =
  | { kind: "episode"; id: string }
  | { kind: "transition"; id: string }
  | { kind: "lifetime"; id: string };

export type ConversationHistoryProjection = {
  asOfTick: number;
  viewFromTick: number;
  viewToTick: number;
  /** タイムライン横軸の長さ(最低1) */
  spanTicks: number;
  episodes: ConversationEpisodeRecord[];
  transitions: ClusterTransitionRecord[];
  lifetimes: ClusterLifetimeRecord[];
  /** agent mode: レーンごとの episode */
  agentLanes: Array<{ agentId: string; label: string; episodes: ConversationEpisodeRecord[] }>;
  /** cluster mode: レーンごとの lifetime + そのmembership episodes */
  clusterLanes: Array<{
    clusterId: string;
    lifetime: ClusterLifetimeRecord;
    episodes: ConversationEpisodeRecord[];
  }>;
};

function exclusiveEnd(endedAtTick: number | undefined, asOfTick: number): number {
  return endedAtTick ?? asOfTick;
}

function intersectsWindow(
  startTick: number,
  endedAtTick: number | undefined,
  asOfTick: number,
  fromTick: number,
  toTick: number,
): boolean {
  return clipHalfOpenInterval(startTick, exclusiveEnd(endedAtTick, asOfTick), fromTick, toTick) !== undefined;
}

function matchesIntervalStatus(
  status: AnalysisIntervalStatus,
  filter: ConversationHistoryIntervalStatusFilter | undefined,
): boolean {
  if (!filter || filter === "all") return true;
  if (filter === "active") return status === "active";
  // completedのみ: 完了。censoredは観測打切りであり完了分布に混ぜないが、
  // 「完了のみ」UIでは終了済みとして見せたい需要があるため completed のみに限定する。
  return status === "completed";
}

function matchesDepartureKind(
  endReason: ConversationEpisodeEndReasonV2 | undefined,
  kind: ConversationHistoryDepartureKindFilter | undefined,
): boolean {
  if (!kind || kind === "all") return true;
  if (kind === "voluntary") return endReason === "voluntaryDeparture";
  if (kind === "forced") return endReason === "memberReleased";
  return endReason === "targetedTransition";
}

function matchesSearch(
  query: string | undefined,
  candidates: Array<string | undefined>,
): boolean {
  const q = query?.trim().toLowerCase();
  if (!q) return true;
  return candidates.some((c) => c !== undefined && c.toLowerCase().includes(q));
}

function agentLabelMap(state: SimulationState): Map<string, { label: string; isObserverJoiner: boolean }> {
  const map = new Map<string, { label: string; isObserverJoiner: boolean }>();
  for (const agent of state.agents) {
    map.set(agent.id, { label: agent.label, isObserverJoiner: agent.isObserverJoiner });
  }
  return map;
}

function isTargetedTransition(transition: ClusterTransitionRecord): boolean {
  return transition.result !== "explore";
}

/**
 * 履歴を表示用に絞り込む。入力`history`/`state`はmutationしない。
 */
export function projectConversationHistory(
  state: SimulationState,
  history: StandingPartyConversationHistory,
  filter: ConversationHistoryViewFilter,
): ConversationHistoryProjection {
  const asOfTick = history.asOfTick;
  const fromTick = filter.fromTick ?? 0;
  const toTick = filter.toTick ?? Math.max(asOfTick, fromTick + 1);
  const spanTicks = Math.max(1, toTick - fromTick);
  const meta = agentLabelMap(state);
  const endReasonFilter =
    filter.endReasons !== undefined ? new Set(filter.endReasons) : undefined;
  const transitionResultFilter =
    filter.transitionResults !== undefined ? new Set(filter.transitionResults) : undefined;
  const departureKind = filter.departureKind ?? "all";
  const statusFilter = filter.intervalStatus ?? "all";

  const episodes = history.episodes.filter((episode) => {
    if (filter.agentId && episode.agentId !== filter.agentId) return false;
    if (filter.clusterId && episode.clusterId !== filter.clusterId) return false;
    if (filter.mode === "agent" && filter.agentId === undefined && filter.searchQuery === undefined) {
      // agent modeで未選択かつ検索なしのときは全agentを出す(後でレーン化)。
    }
    const agentMeta = meta.get(episode.agentId);
    if (filter.observerJoinerOnly && agentMeta && !agentMeta.isObserverJoiner) return false;
    if (!matchesIntervalStatus(episode.status, statusFilter)) return false;
    if (!intersectsWindow(episode.startedAtTick, episode.endedAtTick, asOfTick, fromTick, toTick)) {
      return false;
    }
    if (episode.status === "completed") {
      if (endReasonFilter && (episode.endReason === undefined || !endReasonFilter.has(episode.endReason))) {
        return false;
      }
      if (!matchesDepartureKind(episode.endReason, departureKind)) return false;
    } else if (departureKind !== "all" || endReasonFilter) {
      // 進行中/打切りは endReason フィルタ適用時は除外(未記録を捏造しない)
      return false;
    }
    if (
      !matchesSearch(filter.searchQuery, [
        episode.agentId,
        agentMeta?.label,
        episode.clusterId,
        episode.episodeId,
      ])
    ) {
      return false;
    }
    return true;
  });

  const transitions = history.transitions.filter((transition) => {
    if (filter.agentId && transition.agentId !== filter.agentId) return false;
    if (
      filter.clusterId &&
      transition.sourceClusterId !== filter.clusterId &&
      transition.targetClusterId !== filter.clusterId
    ) {
      return false;
    }
    const agentMeta = meta.get(transition.agentId);
    if (filter.observerJoinerOnly && agentMeta && !agentMeta.isObserverJoiner) return false;
    if (transition.startedAtTick < fromTick || transition.startedAtTick >= toTick) return false;
    if (statusFilter === "active" && transition.endedAtTick !== undefined) return false;
    if (statusFilter === "completed" && transition.endedAtTick === undefined) return false;
    if (transitionResultFilter) {
      if (transition.result === undefined || !transitionResultFilter.has(transition.result)) {
        return false;
      }
    }
    if (departureKind === "targeted" && !isTargetedTransition(transition)) return false;
    if (departureKind === "voluntary" || departureKind === "forced") {
      // episode側の離脱種別フィルタ時は transition レーンを出さない
      return false;
    }
    if (
      !matchesSearch(filter.searchQuery, [
        transition.agentId,
        agentMeta?.label,
        transition.sourceClusterId,
        transition.targetClusterId,
        transition.transitionId,
      ])
    ) {
      return false;
    }
    return true;
  });

  const lifetimes = history.clusterLifetimes.filter((lifetime) => {
    if (filter.clusterId && lifetime.clusterId !== filter.clusterId) return false;
    if (filter.mode === "agent" && filter.agentId) {
      // agent modeで特定agent選択時は、そのagentのepisodeが属するclusterのみ
      const related = episodes.some((e) => e.clusterId === lifetime.clusterId);
      if (!related) return false;
    }
    if (!matchesIntervalStatus(lifetime.status, statusFilter)) return false;
    if (!intersectsWindow(lifetime.createdAtTick, lifetime.endedAtTick, asOfTick, fromTick, toTick)) {
      return false;
    }
    if (!matchesSearch(filter.searchQuery, [lifetime.clusterId, lifetime.founderAgentId])) {
      return false;
    }
    // departureKind / endReasons は episode 向け。lifetime 自体は残す(cluster modeの軸)。
    if (filter.mode === "cluster" && (departureKind !== "all" || endReasonFilter)) {
      const hasMatchingEpisode = episodes.some((e) => e.clusterId === lifetime.clusterId);
      if (!hasMatchingEpisode && departureKind !== "all") return false;
    }
    return true;
  });

  const episodeByCluster = new Map<string, ConversationEpisodeRecord[]>();
  for (const episode of episodes) {
    const list = episodeByCluster.get(episode.clusterId) ?? [];
    list.push(episode);
    episodeByCluster.set(episode.clusterId, list);
  }

  const agentIds = [...new Set(episodes.map((e) => e.agentId))].sort((a, b) => a.localeCompare(b));
  const agentLanes = agentIds.map((agentId) => ({
    agentId,
    label: meta.get(agentId)?.label ?? agentId,
    episodes: episodes
      .filter((e) => e.agentId === agentId)
      .sort((a, b) => a.startedAtTick - b.startedAtTick || a.episodeId.localeCompare(b.episodeId)),
  }));

  const clusterLanes = lifetimes
    .slice()
    .sort((a, b) => a.createdAtTick - b.createdAtTick || a.clusterId.localeCompare(b.clusterId))
    .map((lifetime) => ({
      clusterId: lifetime.clusterId,
      lifetime,
      episodes: (episodeByCluster.get(lifetime.clusterId) ?? []).sort(
        (a, b) => a.startedAtTick - b.startedAtTick || a.episodeId.localeCompare(b.episodeId),
      ),
    }));

  return {
    asOfTick,
    viewFromTick: fromTick,
    viewToTick: toTick,
    spanTicks,
    episodes,
    transitions,
    lifetimes,
    agentLanes,
    clusterLanes,
  };
}

/** 区間をタイムライン横軸上の [0,1] 比率に写す。短い区間も最小幅を確保する */
export function intervalToTrackStyle(
  startedAtTick: number,
  endedAtTick: number | undefined,
  asOfTick: number,
  viewFromTick: number,
  spanTicks: number,
  minWidthRatio = 0.012,
): { leftPercent: number; widthPercent: number } {
  const end = exclusiveEnd(endedAtTick, asOfTick);
  const left = (startedAtTick - viewFromTick) / spanTicks;
  const rawWidth = (end - startedAtTick) / spanTicks;
  const width = Math.max(rawWidth, minWidthRatio);
  const clampedLeft = Math.max(0, Math.min(1, left));
  const clampedWidth = Math.max(minWidthRatio, Math.min(1 - clampedLeft, width));
  return {
    leftPercent: clampedLeft * 100,
    widthPercent: clampedWidth * 100,
  };
}

export function currentTickMarkerPercent(
  currentTick: number,
  viewFromTick: number,
  spanTicks: number,
): number | undefined {
  if (currentTick < viewFromTick || currentTick > viewFromTick + spanTicks) return undefined;
  return ((currentTick - viewFromTick) / spanTicks) * 100;
}

export function findSelectedEpisode(
  history: StandingPartyConversationHistory,
  selection: ConversationHistorySelection | undefined,
): ConversationEpisodeRecord | undefined {
  if (selection?.kind !== "episode") return undefined;
  return history.episodes.find((e) => e.episodeId === selection.id);
}

export function findSelectedTransition(
  history: StandingPartyConversationHistory,
  selection: ConversationHistorySelection | undefined,
): ClusterTransitionRecord | undefined {
  if (selection?.kind !== "transition") return undefined;
  return history.transitions.find((t) => t.transitionId === selection.id);
}

export function findSelectedLifetime(
  history: StandingPartyConversationHistory,
  selection: ConversationHistorySelection | undefined,
): ClusterLifetimeRecord | undefined {
  if (selection?.kind !== "lifetime") return undefined;
  return history.clusterLifetimes.find((l) => l.clusterId === selection.id);
}
