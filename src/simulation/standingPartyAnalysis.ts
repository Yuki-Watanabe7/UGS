/**
 * Issue #212 (standing-party Phase 4 分析): 会話参加・離脱・クラスタ遷移を統合した会話履歴
 * read model。`docs/standing-party-analysis-phase4-model.md`の契約どおり、
 * `state.log`の構造化イベント(+ liveな`currentEpisode`/`pendingClusterTransition`/
 * `groupCandidates`)からpure・決定的に導出する。RNGは消費せず、入力stateをmutationしない。
 * 表示文言(`message`)は参照しない。contact / network / 統計集計は#213/#214の範囲。
 *
 * `standingPartyComparison.ts`(#190)と同様、afterParty/classroomPairのrunに対して呼び出しても
 * 対象イベントが無ければ空/ゼロ相当を返すだけで例外は投げない。
 */
import type {
  AnalysisIntervalStatus,
  ClusterLifetimeEndReason,
  ClusterLifetimeRecord,
  ClusterMembershipInterval,
  ClusterTransitionRecord,
  ClusterTransitionResult,
  ConversationEpisodeEndReasonV2,
  ConversationEpisodeRecord,
  GroupCandidateStatus,
  SimulationEventType,
  SimulationState,
  StandingPartyAnalysisDiagnostic,
  StandingPartyConversationHistory,
} from "./types";
import { STANDING_PARTY_ANALYSIS_SCHEMA_VERSION } from "./types";

/** join系イベント(同一episodeIdは1件に畳む)。Gap Bのcanonical開始信号 §2.4 */
const EPISODE_START_EVENT_TYPES: ReadonlySet<SimulationEventType> = new Set([
  "agentJoined",
  "observerJoinedForming",
  "observerJoinedConfirmed",
  "clusterRejoined",
  "clusterTransitionCompleted",
]);

export type BuildStandingPartyConversationHistoryOptions = {
  /**
   * 未完了区間の長さ・censored判定に使う観測時点。省略時は`state.tick`。
   * 半開区間`[start, end)`の`end`未定義時のdwellは`asOfTick - start`。
   */
  asOfTick?: number;
};

/**
 * `` `${agentId}:${clusterId}:${joinedAtTick}` `` を決定的にパースする。
 * agentId/clusterIdはコロンを含まない既存ID規約を前提とする。
 */
export function parseConversationEpisodeId(
  episodeId: string,
): { agentId: string; clusterId: string; joinedAtTick: number } | undefined {
  const parts = episodeId.split(":");
  if (parts.length !== 3) return undefined;
  const [agentId, clusterId, tickRaw] = parts;
  if (!agentId || !clusterId) return undefined;
  const joinedAtTick = Number(tickRaw);
  if (!Number.isFinite(joinedAtTick)) return undefined;
  return { agentId, clusterId, joinedAtTick };
}

/** `` `${agentId}:${sourceClusterId}:${decidedAtTick}` `` (ADR §1.4 / §6.1) */
export function createClusterTransitionId(
  agentId: string,
  sourceClusterId: string,
  decidedAtTick: number,
): string {
  return `${agentId}:${sourceClusterId}:${decidedAtTick}`;
}

function cloneSortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

function openIntervalStatus(finished: boolean, finishReason: string | undefined): AnalysisIntervalStatus {
  // observation horizon到達でfinishedした場合も、open区間は完了分布へ混ぜずcensoredとする。
  if (finished) return "censored";
  void finishReason;
  return "active";
}

type MutableEpisode = ConversationEpisodeRecord & { _closed?: boolean };
type MutableTransition = ClusterTransitionRecord;
type MutableLifetime = ClusterLifetimeRecord;

function ensureLifetime(
  lifetimes: Map<string, MutableLifetime>,
  clusterId: string,
  createdAtTick: number,
  founderAgentId?: string,
): MutableLifetime {
  const existing = lifetimes.get(clusterId);
  if (existing) {
    if (founderAgentId !== undefined && existing.founderAgentId === undefined) {
      existing.founderAgentId = founderAgentId;
    }
    return existing;
  }
  const created: MutableLifetime = {
    clusterId,
    founderAgentId,
    createdAtTick,
    status: "active",
    peakMemberCount: 0,
    joinCount: 0,
    voluntaryLeaveCount: 0,
    forcedReleaseCount: 0,
  };
  lifetimes.set(clusterId, created);
  return created;
}

function bumpPeak(lifetime: MutableLifetime, memberCount: number): void {
  if (memberCount > lifetime.peakMemberCount) lifetime.peakMemberCount = memberCount;
}

function closeLifetime(
  lifetime: MutableLifetime,
  endedAtTick: number,
  endReason: ClusterLifetimeEndReason,
  status: AnalysisIntervalStatus = "completed",
): void {
  if (lifetime.endedAtTick !== undefined) return;
  lifetime.endedAtTick = endedAtTick;
  lifetime.endReason = endReason;
  lifetime.status = status;
}

/**
 * SimulationStateから会話履歴read modelを導出する。同じ入力からは同じ結果を返す(決定的)。
 */
export function buildStandingPartyConversationHistory(
  state: SimulationState,
  options?: BuildStandingPartyConversationHistoryOptions,
): StandingPartyConversationHistory {
  const asOfTick = options?.asOfTick ?? state.tick;
  const diagnostics: StandingPartyAnalysisDiagnostic[] = [];

  const episodesById = new Map<string, MutableEpisode>();
  const episodeOrder: string[] = [];
  /** agentあたり同時に1つだけのopen episodeを追跡 */
  const openEpisodeByAgent = new Map<string, string>();

  const transitionsById = new Map<string, MutableTransition>();
  const transitionOrder: string[] = [];
  /** agent → 直近のopen targeted transitionId */
  const openTransitionByAgent = new Map<string, string>();

  const lifetimes = new Map<string, MutableLifetime>();
  const lifetimeOrder: string[] = [];

  /** clusterId → 現在のjoined member集合(導出用の走行状態。入力はmutationしない) */
  const membersByCluster = new Map<string, Set<string>>();
  /** nucleusCreatedのfounder(Gap B: groupConfirmed時のepisode開始) */
  const founderByCluster = new Map<string, string>();

  const finishReason = [...state.log]
    .reverse()
    .find((entry) => entry.eventType === "simulationFinished")?.metadata?.finishReason;

  function membersOf(clusterId: string): Set<string> {
    let set = membersByCluster.get(clusterId);
    if (!set) {
      set = new Set();
      membersByCluster.set(clusterId, set);
    }
    return set;
  }

  function trackLifetimeCreated(clusterId: string, tick: number, founderAgentId?: string): void {
    const isNew = !lifetimes.has(clusterId);
    ensureLifetime(lifetimes, clusterId, tick, founderAgentId);
    if (isNew) lifetimeOrder.push(clusterId);
  }

  function openEpisode(args: {
    episodeId: string;
    agentId: string;
    clusterId: string;
    startedAtTick: number;
    joinedGroupStatus: GroupCandidateStatus;
    startMemberIds: string[];
    tick: number;
    fromEventType?: SimulationEventType;
  }): MutableEpisode | undefined {
    const existing = episodesById.get(args.episodeId);
    if (existing) {
      if (args.fromEventType && EPISODE_START_EVENT_TYPES.has(args.fromEventType)) {
        diagnostics.push({
          code: "duplicateEpisodeStart",
          tick: args.tick,
          agentId: args.agentId,
          clusterId: args.clusterId,
          episodeId: args.episodeId,
          detail: `duplicate start via ${args.fromEventType}`,
        });
      }
      return existing;
    }

    const priorOpenId = openEpisodeByAgent.get(args.agentId);
    if (priorOpenId !== undefined && priorOpenId !== args.episodeId) {
      diagnostics.push({
        code: "overlappingMembership",
        tick: args.tick,
        agentId: args.agentId,
        clusterId: args.clusterId,
        episodeId: args.episodeId,
        detail: `prior open episode ${priorOpenId}`,
      });
      const prior = episodesById.get(priorOpenId);
      if (prior && prior.endedAtTick === undefined) {
        prior.endedAtTick = args.startedAtTick;
        prior.dwellTicks = Math.max(0, args.startedAtTick - prior.startedAtTick);
        prior.status = "completed";
        prior.endMemberIds = cloneSortedIds(membersOf(prior.clusterId));
      }
      openEpisodeByAgent.delete(args.agentId);
    }

    const record: MutableEpisode = {
      episodeId: args.episodeId,
      agentId: args.agentId,
      clusterId: args.clusterId,
      startedAtTick: args.startedAtTick,
      dwellTicks: 0,
      status: "active",
      joinedGroupStatus: args.joinedGroupStatus,
      startMemberIds: cloneSortedIds(args.startMemberIds),
    };
    episodesById.set(args.episodeId, record);
    episodeOrder.push(args.episodeId);
    openEpisodeByAgent.set(args.agentId, args.episodeId);

    trackLifetimeCreated(args.clusterId, args.startedAtTick);
    const lifetime = ensureLifetime(lifetimes, args.clusterId, args.startedAtTick);
    lifetime.joinCount += 1;
    bumpPeak(lifetime, args.startMemberIds.length);
    membersOf(args.clusterId).add(args.agentId);
    bumpPeak(lifetime, membersOf(args.clusterId).size);

    return record;
  }

  function closeEpisode(args: {
    episodeId: string | undefined;
    agentId: string;
    clusterId: string | undefined;
    tick: number;
    endReason: ConversationEpisodeEndReasonV2;
    emitMissingDiagnostic?: boolean;
  }): void {
    let episodeId = args.episodeId;
    let record = episodeId !== undefined ? episodesById.get(episodeId) : undefined;

    if (!record) {
      const openId = openEpisodeByAgent.get(args.agentId);
      if (openId !== undefined) {
        record = episodesById.get(openId);
        episodeId = openId;
      }
    }

    if (!record && episodeId !== undefined) {
      const parsed = parseConversationEpisodeId(episodeId);
      if (parsed) {
        // Gap B: joinイベント無しで開始したepisodeが終了イベントだけで現れた場合、開始を復元する。
        const startMembers = [...membersOf(parsed.clusterId)];
        if (!startMembers.includes(parsed.agentId)) startMembers.push(parsed.agentId);
        openEpisode({
          episodeId,
          agentId: parsed.agentId,
          clusterId: parsed.clusterId,
          startedAtTick: parsed.joinedAtTick,
          joinedGroupStatus: "confirmed",
          startMemberIds: startMembers,
          tick: args.tick,
        });
        record = episodesById.get(episodeId);
      } else if (args.emitMissingDiagnostic !== false) {
        diagnostics.push({
          code: "episodeCloseWithoutOpen",
          tick: args.tick,
          agentId: args.agentId,
          clusterId: args.clusterId,
          episodeId,
          detail: "unparseable episodeId on close",
        });
      }
    } else if (!record && args.emitMissingDiagnostic !== false) {
      diagnostics.push({
        code: "episodeCloseWithoutOpen",
        tick: args.tick,
        agentId: args.agentId,
        clusterId: args.clusterId,
        detail: "close without open episode",
      });
    }

    if (!record || record.endedAtTick !== undefined) return;

    const endMemberIds = cloneSortedIds(membersOf(record.clusterId));
    record.endedAtTick = args.tick;
    record.dwellTicks = Math.max(0, args.tick - record.startedAtTick);
    record.status = "completed";
    record.endReason = args.endReason;
    record.endMemberIds = endMemberIds;

    membersOf(record.clusterId).delete(record.agentId);
    if (openEpisodeByAgent.get(record.agentId) === record.episodeId) {
      openEpisodeByAgent.delete(record.agentId);
    }
  }

  function openOrGetTransition(
    transitionId: string,
    seed: Omit<ClusterTransitionRecord, "transitionId"> & { transitionId?: string },
  ): MutableTransition {
    const existing = transitionsById.get(transitionId);
    if (existing) return existing;
    const created: MutableTransition = { ...seed, transitionId };
    transitionsById.set(transitionId, created);
    transitionOrder.push(transitionId);
    return created;
  }

  function finalizeTransition(
    transitionId: string,
    tick: number,
    result: ClusterTransitionResult,
    extra?: Partial<ClusterTransitionRecord>,
  ): void {
    const record = transitionsById.get(transitionId);
    if (!record) {
      diagnostics.push({
        code: "transitionCloseWithoutOpen",
        tick,
        transitionId,
        detail: `close as ${result} without open`,
      });
      return;
    }
    if (record.endedAtTick === undefined) {
      record.endedAtTick = tick;
      record.elapsedTicks = Math.max(0, tick - record.startedAtTick);
    }
    record.result = result;
    if (extra) Object.assign(record, extra);
    if (openTransitionByAgent.get(record.agentId) === transitionId) {
      openTransitionByAgent.delete(record.agentId);
    }
  }

  for (const entry of state.log) {
    const { tick, eventType, metadata } = entry;
    if (!eventType || !metadata) continue;

    switch (eventType) {
      case "nucleusCreated": {
        const clusterId = metadata.groupId;
        const agentId = metadata.agentId;
        if (!clusterId || !agentId) break;
        trackLifetimeCreated(clusterId, tick, agentId);
        founderByCluster.set(clusterId, agentId);
        membersOf(clusterId).add(agentId);
        bumpPeak(ensureLifetime(lifetimes, clusterId, tick, agentId), membersOf(clusterId).size);
        break;
      }
      case "groupConfirmed": {
        const clusterId = metadata.groupId;
        if (!clusterId) break;
        trackLifetimeCreated(clusterId, tick);
        const lifetime = ensureLifetime(lifetimes, clusterId, tick);
        lifetime.confirmedAtTick = tick;
        bumpPeak(lifetime, metadata.memberCount ?? membersOf(clusterId).size);

        // Gap B: forming→joinedになったfounderはagentJoinedを伴わないことがある。
        const founderId = founderByCluster.get(clusterId) ?? lifetime.founderAgentId;
        if (founderId) {
          const episodeId = `${founderId}:${clusterId}:${tick}`;
          if (!episodesById.has(episodeId) && openEpisodeByAgent.get(founderId) === undefined) {
            const startMembers = cloneSortedIds(membersOf(clusterId));
            if (!startMembers.includes(founderId)) startMembers.push(founderId);
            openEpisode({
              episodeId,
              agentId: founderId,
              clusterId,
              startedAtTick: tick,
              joinedGroupStatus: "confirmed",
              startMemberIds: startMembers,
              tick,
            });
          }
        }
        break;
      }
      case "agentJoined":
      case "observerJoinedForming":
      case "observerJoinedConfirmed":
      case "clusterRejoined": {
        const agentId = metadata.agentId;
        const clusterId = metadata.groupId;
        const episodeId = metadata.episodeId;
        if (!agentId || !clusterId || !episodeId) break;
        trackLifetimeCreated(clusterId, tick);
        const parsed = parseConversationEpisodeId(episodeId);
        const startedAtTick = parsed?.joinedAtTick ?? tick;
        const joinedGroupStatus: GroupCandidateStatus =
          metadata.joinedGroupStatus ??
          (eventType === "observerJoinedConfirmed" ? "confirmed" : "forming");
        const startMembers = cloneSortedIds(membersOf(clusterId));
        if (!startMembers.includes(agentId)) startMembers.push(agentId);
        openEpisode({
          episodeId,
          agentId,
          clusterId,
          startedAtTick,
          joinedGroupStatus,
          startMemberIds: startMembers,
          tick,
          fromEventType: eventType,
        });
        break;
      }
      case "clusterTransitionCompleted": {
        const agentId = metadata.agentId;
        const targetClusterId = metadata.groupId ?? metadata.targetClusterId;
        const episodeId = metadata.episodeId;
        if (!agentId || !targetClusterId) break;

        const openTransitionId = openTransitionByAgent.get(agentId);
        if (openTransitionId) {
          finalizeTransition(openTransitionId, tick, "completed", {
            targetClusterId,
            targetEpisodeId: episodeId,
            focusAgentId: metadata.focusAgentId,
          });
        } else {
          // TargetSelected欠落時もtransitionIdを決定的に復元できないため診断のみ。
          diagnostics.push({
            code: "transitionCloseWithoutOpen",
            tick,
            agentId,
            clusterId: targetClusterId,
            detail: "clusterTransitionCompleted without open targeted transition",
          });
        }

        if (episodeId) {
          trackLifetimeCreated(targetClusterId, tick);
          const parsed = parseConversationEpisodeId(episodeId);
          const startedAtTick = parsed?.joinedAtTick ?? tick;
          const startMembers = cloneSortedIds(membersOf(targetClusterId));
          if (!startMembers.includes(agentId)) startMembers.push(agentId);
          openEpisode({
            episodeId,
            agentId,
            clusterId: targetClusterId,
            startedAtTick,
            joinedGroupStatus: metadata.joinedGroupStatus ?? "confirmed",
            startMemberIds: startMembers,
            tick,
            fromEventType: eventType,
          });
        }
        break;
      }
      case "clusterDepartureCompleted": {
        const agentId = metadata.agentId;
        const clusterId = metadata.groupId;
        if (!agentId || !clusterId) break;
        const endReason: ConversationEpisodeEndReasonV2 =
          metadata.transitionAction === "switchToTargetCluster" ? "targetedTransition" : "voluntaryDeparture";
        closeEpisode({
          episodeId: metadata.episodeId,
          agentId,
          clusterId,
          tick,
          endReason,
        });
        const lifetime = ensureLifetime(lifetimes, clusterId, tick);
        lifetime.voluntaryLeaveCount += 1;

        if (metadata.transitionAction === "switchToTargetCluster") {
          // TargetSelectedが同一tickで続く。sourceEpisodeIdだけ先に控える用途でopenはSelected側。
        } else {
          // 目的地なし再探索(departAndExplore / Phase 2のみ経路)
          const transitionId = createClusterTransitionId(agentId, clusterId, tick);
          const created = openOrGetTransition(transitionId, {
            agentId,
            sourceClusterId: clusterId,
            startedAtTick: tick,
            endedAtTick: tick,
            result: "explore",
            sourceEpisodeId: metadata.episodeId,
            elapsedTicks: 0,
          });
          created.result = "explore";
          created.endedAtTick = tick;
          created.elapsedTicks = 0;
          created.sourceEpisodeId = metadata.episodeId ?? created.sourceEpisodeId;
        }
        break;
      }
      case "clusterMemberReleased": {
        const agentId = metadata.agentId;
        const clusterId = metadata.groupId;
        if (!agentId || !clusterId) break;
        closeEpisode({
          episodeId: metadata.episodeId,
          agentId,
          clusterId,
          tick,
          endReason: "memberReleased",
        });
        const lifetime = ensureLifetime(lifetimes, clusterId, tick);
        lifetime.forcedReleaseCount += 1;
        break;
      }
      case "clusterMembershipLost": {
        const agentId = metadata.agentId;
        const clusterId = metadata.groupId;
        if (!agentId) break;
        closeEpisode({
          episodeId: metadata.episodeId,
          agentId,
          clusterId,
          tick,
          endReason: "membershipLost",
        });
        break;
      }
      case "clusterTransitionTargetSelected": {
        const agentId = metadata.agentId;
        const sourceClusterId = metadata.groupId;
        const targetClusterId = metadata.targetClusterId;
        if (!agentId || !sourceClusterId || !targetClusterId) break;
        const transitionId = createClusterTransitionId(agentId, sourceClusterId, tick);
        const sourceEpisodeId =
          metadata.episodeId ??
          [...episodesById.values()].find(
            (ep) => ep.agentId === agentId && ep.clusterId === sourceClusterId && ep.endedAtTick === tick,
          )?.episodeId;
        openOrGetTransition(transitionId, {
          agentId,
          sourceClusterId,
          targetClusterId,
          focusAgentId: metadata.focusAgentId,
          startedAtTick: tick,
          sourceEpisodeId,
        });
        openTransitionByAgent.set(agentId, transitionId);
        break;
      }
      case "clusterTransitionTargetInvalidated": {
        const agentId = metadata.agentId;
        const sourceClusterId = metadata.groupId;
        if (!agentId) break;
        const transitionId =
          openTransitionByAgent.get(agentId) ??
          (sourceClusterId !== undefined
            ? createClusterTransitionId(agentId, sourceClusterId, tick)
            : undefined);
        if (!transitionId) {
          diagnostics.push({
            code: "transitionCloseWithoutOpen",
            tick,
            agentId,
            detail: "invalidated without open transition",
          });
          break;
        }
        // Abandonedが直後に来るので、ここではinvalidatedを暫定結果として残す。
        const record = transitionsById.get(transitionId) ??
          openOrGetTransition(transitionId, {
            agentId,
            sourceClusterId: sourceClusterId ?? "unknown",
            targetClusterId: metadata.targetClusterId,
            focusAgentId: metadata.focusAgentId,
            startedAtTick: tick,
          });
        record.invalidationReason = metadata.invalidationReason;
        record.result = "invalidated";
        record.endedAtTick = tick;
        record.elapsedTicks = Math.max(0, tick - record.startedAtTick);
        break;
      }
      case "clusterTransitionAbandoned": {
        const agentId = metadata.agentId;
        if (!agentId) break;
        const transitionId = openTransitionByAgent.get(agentId);
        if (!transitionId) {
          diagnostics.push({
            code: "transitionCloseWithoutOpen",
            tick,
            agentId,
            detail: "abandoned without open transition",
          });
          break;
        }
        finalizeTransition(transitionId, tick, "abandoned", {
          invalidationReason: transitionsById.get(transitionId)?.invalidationReason ?? metadata.invalidationReason,
          targetClusterId: metadata.targetClusterId ?? transitionsById.get(transitionId)?.targetClusterId,
          focusAgentId: metadata.focusAgentId ?? transitionsById.get(transitionId)?.focusAgentId,
        });
        break;
      }
      case "activeClusterDissolving": {
        const clusterId = metadata.groupId;
        if (!clusterId) break;
        trackLifetimeCreated(clusterId, tick);
        const lifetime = ensureLifetime(lifetimes, clusterId, tick);
        lifetime.dissolvingAtTick = tick;
        bumpPeak(lifetime, metadata.memberCountBefore ?? lifetime.peakMemberCount);
        break;
      }
      case "activeClusterDissolved": {
        const clusterId = metadata.groupId;
        if (!clusterId) break;
        trackLifetimeCreated(clusterId, tick);
        const lifetime = ensureLifetime(lifetimes, clusterId, tick);
        if (lifetime.dissolvingAtTick === undefined) lifetime.dissolvingAtTick = tick;
        closeLifetime(lifetime, tick, "activeClusterDissolved");
        membersByCluster.set(clusterId, new Set());
        break;
      }
      case "groupDissolved": {
        const clusterId = metadata.groupId;
        if (!clusterId) break;
        trackLifetimeCreated(clusterId, tick);
        closeLifetime(ensureLifetime(lifetimes, clusterId, tick), tick, "groupDissolved");
        membersByCluster.set(clusterId, new Set());
        break;
      }
      case "groupExpired": {
        const clusterId = metadata.groupId;
        if (!clusterId) break;
        trackLifetimeCreated(clusterId, tick);
        closeLifetime(ensureLifetime(lifetimes, clusterId, tick), tick, "groupExpired");
        membersByCluster.set(clusterId, new Set());
        break;
      }
      default:
        break;
    }
  }

  // live stateで未完了区間を補完(正本はlog、open区間の現状確認用)。
  for (const agent of state.agents) {
    const live = agent.currentEpisode;
    if (live) {
      if (!episodesById.has(live.episodeId)) {
        const startMembers = cloneSortedIds(membersOf(live.clusterId));
        if (!startMembers.includes(agent.id)) startMembers.push(agent.id);
        openEpisode({
          episodeId: live.episodeId,
          agentId: agent.id,
          clusterId: live.clusterId,
          startedAtTick: live.joinedAtTick,
          joinedGroupStatus: "confirmed",
          startMemberIds: startMembers,
          tick: asOfTick,
        });
      }
      openEpisodeByAgent.set(agent.id, live.episodeId);
    }

    const pending = agent.pendingClusterTransition;
    if (pending) {
      const transitionId = createClusterTransitionId(agent.id, pending.sourceClusterId, pending.decidedAtTick);
      openOrGetTransition(transitionId, {
        agentId: agent.id,
        sourceClusterId: pending.sourceClusterId,
        targetClusterId: pending.targetClusterId,
        focusAgentId: pending.focusAgentId,
        startedAtTick: pending.decidedAtTick,
      });
      openTransitionByAgent.set(agent.id, transitionId);
    }

    // membership整合: joinedならopen episodeがあり、clusterIdが一致する。
    if (agent.state === "joined" && agent.joinedGroupId !== undefined) {
      const openId = openEpisodeByAgent.get(agent.id);
      const open = openId !== undefined ? episodesById.get(openId) : undefined;
      if (!open || open.clusterId !== agent.joinedGroupId || open.endedAtTick !== undefined) {
        diagnostics.push({
          code: "membershipStateMismatch",
          tick: asOfTick,
          agentId: agent.id,
          clusterId: agent.joinedGroupId,
          episodeId: open?.episodeId ?? agent.currentEpisode?.episodeId,
          detail: "joined agent without matching open episode in history",
        });
      }
    } else if (agent.state !== "joined" && openEpisodeByAgent.has(agent.id) && !agent.currentEpisode) {
      // log上はopenのままだがliveでは所属なし → 通常は終了イベント欠落。診断のみ(黙って閉じない)。
      const openId = openEpisodeByAgent.get(agent.id);
      diagnostics.push({
        code: "membershipStateMismatch",
        tick: asOfTick,
        agentId: agent.id,
        episodeId: openId,
        detail: "open episode in history but agent is not joined",
      });
    }
  }

  for (const candidate of state.groupCandidates) {
    if (!lifetimes.has(candidate.id)) {
      trackLifetimeCreated(candidate.id, asOfTick);
    }
    const lifetime = ensureLifetime(lifetimes, candidate.id, asOfTick);
    const joinedMemberCount = candidate.memberIds.filter((id) => {
      const agent = state.agents.find((a) => a.id === id);
      return agent?.state === "joined";
    }).length;
    bumpPeak(lifetime, joinedMemberCount > 0 ? joinedMemberCount : candidate.memberIds.length);
    if (candidate.status === "dissolving" && lifetime.dissolvingAtTick === undefined) {
      lifetime.dissolvingAtTick = asOfTick;
    }
    if (
      (candidate.status === "dissolved" || candidate.status === "expired") &&
      lifetime.endedAtTick === undefined
    ) {
      closeLifetime(
        lifetime,
        asOfTick,
        candidate.status === "expired" ? "groupExpired" : "activeClusterDissolved",
      );
    }
  }

  // cleanupで配列から消えたcluster: lifetimeは残し、未終了ならcleanedUp。
  const liveClusterIds = new Set(state.groupCandidates.map((c) => c.id));
  for (const lifetime of lifetimes.values()) {
    if (lifetime.endedAtTick === undefined && !liveClusterIds.has(lifetime.clusterId)) {
      closeLifetime(lifetime, asOfTick, "cleanedUp");
    }
  }

  const openStatus = openIntervalStatus(state.finished, finishReason);

  const episodes: ConversationEpisodeRecord[] = episodeOrder.map((id) => {
    const ep = episodesById.get(id)!;
    if (ep.endedAtTick === undefined) {
      return {
        ...ep,
        dwellTicks: Math.max(0, asOfTick - ep.startedAtTick),
        status: openStatus,
      };
    }
    return {
      episodeId: ep.episodeId,
      agentId: ep.agentId,
      clusterId: ep.clusterId,
      startedAtTick: ep.startedAtTick,
      endedAtTick: ep.endedAtTick,
      dwellTicks: ep.dwellTicks,
      status: ep.status,
      endReason: ep.endReason,
      joinedGroupStatus: ep.joinedGroupStatus,
      startMemberIds: ep.startMemberIds,
      endMemberIds: ep.endMemberIds,
    };
  });

  const membershipIntervals: ClusterMembershipInterval[] = episodes.map((ep) => ({
    intervalId: ep.episodeId,
    agentId: ep.agentId,
    clusterId: ep.clusterId,
    startedAtTick: ep.startedAtTick,
    endedAtTick: ep.endedAtTick,
    status: ep.status,
    episodeId: ep.episodeId,
  }));

  const clusterLifetimes: ClusterLifetimeRecord[] = lifetimeOrder.map((id) => {
    const life = lifetimes.get(id)!;
    if (life.endedAtTick === undefined) {
      return { ...life, status: openStatus };
    }
    return { ...life };
  });

  const transitions: ClusterTransitionRecord[] = transitionOrder.map((id) => {
    const tr = transitionsById.get(id)!;
    if (tr.endedAtTick === undefined) {
      return {
        ...tr,
        elapsedTicks: Math.max(0, asOfTick - tr.startedAtTick),
      };
    }
    return { ...tr };
  });

  return {
    schemaVersion: STANDING_PARTY_ANALYSIS_SCHEMA_VERSION,
    asOfTick,
    episodes,
    membershipIntervals,
    clusterLifetimes,
    transitions,
    diagnostics,
  };
}

/**
 * 入力stateをmutationしていないこと・導出が決定的であることの軽い自己検査用。
 * テストから呼び、本番経路では使わない。
 */
export function assertHistoryDoesNotMutateState(
  state: SimulationState,
  build: (s: SimulationState) => StandingPartyConversationHistory = buildStandingPartyConversationHistory,
): StandingPartyConversationHistory {
  const logLengthBefore = state.log.length;
  const agentSnapshot = state.agents.map((a) => ({
    id: a.id,
    state: a.state,
    joinedGroupId: a.joinedGroupId,
    episodeId: a.currentEpisode?.episodeId,
  }));
  const first = build(state);
  const second = build(state);
  if (state.log.length !== logLengthBefore) {
    throw new Error("buildStandingPartyConversationHistory mutated state.log");
  }
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("buildStandingPartyConversationHistory is not deterministic");
  }
  for (let i = 0; i < agentSnapshot.length; i++) {
    const agent = state.agents[i];
    const snap = agentSnapshot[i];
    if (
      agent.id !== snap.id ||
      agent.state !== snap.state ||
      agent.joinedGroupId !== snap.joinedGroupId ||
      agent.currentEpisode?.episodeId !== snap.episodeId
    ) {
      throw new Error("buildStandingPartyConversationHistory mutated agents");
    }
  }
  return first;
}
