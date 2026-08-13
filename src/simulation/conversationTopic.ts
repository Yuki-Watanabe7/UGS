/**
 * Issue #230 (Phase 5, roadmap #172): `docs/information-propagation-phase5-model.md`(#228 ADR)
 * §2.5の契約に基づく、confirmed clusterごとの会話topic runtime state。
 *
 * ここが持つのは「そのclusterで直近どんな会話が起きていたか」という決定的に導出・更新できる
 * runtime stateだけである。話者・topic・claim/variantの選択ロジックは`contentUtterance.ts`が扱う。
 * agentごとのtopic/claim状態(`informationState.ts`)は一切書き換えない(read-only参照のみ)。
 */

export type ClusterTopicState = {
  clusterId: string;
  currentTopicId?: string;
  topicStartedTick?: number;
  lastUtteranceTick?: number;
  /** 直近扱われたtopic ID。oldest-firstのrolling window(`MAX_RECENT_TOPICS_PER_CLUSTER`件まで) */
  recentTopicIds: string[];
  /** 直近発話したagent ID。oldest-firstのrolling window(`MAX_RECENT_SPEAKERS_PER_CLUSTER`件まで) */
  recentSpeakerIds: string[];
  /** 現在topicが連続して何回扱われたか(topic切替でリセット) */
  repetitionCount: number;
  /** 話者cooldown判定用。agentId -> このclusterで最後に発話したtick */
  speakerLastTurnTick: Record<string, number>;
  /** claim反復cooldown判定用。claimId -> このclusterで最後にそのclaimが話されたtick */
  claimLastToldTick: Record<string, number>;
  /** membership変化(新規join)検出用。直近確認できたmemberId一覧(sort済み) */
  knownMemberIds: string[];
  /** 直近記録したskip理由。同一理由の連続記録を避けるためだけに使う一時値(構造化eventの対象外) */
  lastSkipReason?: string;
};

export type ClusterTopicRuntimeState = Record<string, ClusterTopicState>;

export const MAX_RECENT_TOPICS_PER_CLUSTER = 8;
export const MAX_RECENT_SPEAKERS_PER_CLUSTER = 8;

export function createInitialClusterTopicState(clusterId: string): ClusterTopicState {
  return {
    clusterId,
    currentTopicId: undefined,
    topicStartedTick: undefined,
    lastUtteranceTick: undefined,
    recentTopicIds: [],
    recentSpeakerIds: [],
    repetitionCount: 0,
    speakerLastTurnTick: {},
    claimLastToldTick: {},
    knownMemberIds: [],
    lastSkipReason: undefined,
  };
}

function pushCapped(list: string[], value: string, cap: number): string[] {
  const next = [...list, value];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * memberの現在集合をsnapshotし、前tickには居なかった(=`knownMemberIds`未収録の)memberが
 * 増えていれば`hasNewMember: true`を返す(§4のtopic refreshトリガー用)。RNGを消費しない
 * 決定的規則であり、発話機会の有無に関わらず毎tick呼んでよい。
 */
export function syncClusterMembership(
  state: ClusterTopicState,
  currentMemberIds: readonly string[],
): { state: ClusterTopicState; hasNewMember: boolean } {
  const sorted = [...currentMemberIds].sort();
  const known = new Set(state.knownMemberIds);
  const hasNewMember = sorted.some((id) => !known.has(id));
  if (!hasNewMember && sorted.length === state.knownMemberIds.length) {
    return { state, hasNewMember: false };
  }
  return { state: { ...state, knownMemberIds: sorted }, hasNewMember };
}

/** 発話1件分をcluster topic runtime stateへ反映する(決定的、RNGを消費しない) */
export function recordUtterance(
  state: ClusterTopicState,
  input: { topicId: string; speakerId: string; claimId: string; tick: number },
): ClusterTopicState {
  const topicChanged = state.currentTopicId !== input.topicId;
  return {
    ...state,
    currentTopicId: input.topicId,
    topicStartedTick: topicChanged ? input.tick : (state.topicStartedTick ?? input.tick),
    lastUtteranceTick: input.tick,
    recentTopicIds: pushCapped(state.recentTopicIds, input.topicId, MAX_RECENT_TOPICS_PER_CLUSTER),
    recentSpeakerIds: pushCapped(state.recentSpeakerIds, input.speakerId, MAX_RECENT_SPEAKERS_PER_CLUSTER),
    repetitionCount: topicChanged ? 1 : state.repetitionCount + 1,
    speakerLastTurnTick: { ...state.speakerLastTurnTick, [input.speakerId]: input.tick },
    claimLastToldTick: { ...state.claimLastToldTick, [input.claimId]: input.tick },
    lastSkipReason: undefined,
  };
}

export function recordSkip(state: ClusterTopicState, reason: string): { state: ClusterTopicState; shouldLog: boolean } {
  if (state.lastSkipReason === reason) return { state, shouldLog: false };
  return { state: { ...state, lastSkipReason: reason }, shouldLog: true };
}

/**
 * cluster内で現在topicが繰り返された度合いから、cluster規模の"使い古され度"を導出する
 * (agentごとの`AgentTopicState.fatigue`とは別の、cluster runtime由来の一時値)。他topicには常に0を返す。
 */
export function computeClusterTopicFatigue(
  state: ClusterTopicState,
  topicId: string,
  fatigueGain: number,
  fatigueDecay: number,
): number {
  if (state.currentTopicId !== topicId) return 0;
  const raw = fatigueGain * state.repetitionCount - fatigueDecay;
  return Math.min(1, Math.max(0, raw));
}

/** cluster解散・membership喪失後、対応するruntime stateを破棄する(utterance logは呼び出し側が別途保持する) */
export function pruneClusterTopicRuntimeState(
  runtime: ClusterTopicRuntimeState,
  activeClusterIds: ReadonlySet<string>,
): ClusterTopicRuntimeState {
  const next: ClusterTopicRuntimeState = {};
  for (const [clusterId, clusterState] of Object.entries(runtime)) {
    if (activeClusterIds.has(clusterId)) next[clusterId] = clusterState;
  }
  return next;
}
