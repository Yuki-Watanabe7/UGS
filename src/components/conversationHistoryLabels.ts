/**
 * Issue #215: 会話履歴タイムライン向けの表示ラベル。
 * 表示文言の文字列解析は行わず、構造化フィールドの値からラベルへ写像するだけ。
 */
import type {
  AnalysisIntervalStatus,
  ClusterLifetimeEndReason,
  ClusterTransitionInvalidationReason,
  ClusterTransitionResult,
  ConversationEpisodeEndReasonV2,
} from "../simulation/types";

export const EPISODE_END_REASON_LABEL: Record<ConversationEpisodeEndReasonV2, string> = {
  voluntaryDeparture: "自発離脱",
  memberReleased: "強制release",
  membershipLost: "所属喪失",
  targetedTransition: "目的地付き遷移",
  venueExit: "会場退出",
  reset: "reset",
};

export const EPISODE_END_REASON_ICON: Record<ConversationEpisodeEndReasonV2, string> = {
  voluntaryDeparture: "◇",
  memberReleased: "▣",
  membershipLost: "✕",
  targetedTransition: "→",
  venueExit: "⌂",
  reset: "↺",
};

export const INTERVAL_STATUS_LABEL: Record<AnalysisIntervalStatus, string> = {
  active: "進行中",
  completed: "完了",
  censored: "観測打切り",
};

export const LIFETIME_END_REASON_LABEL: Record<ClusterLifetimeEndReason, string> = {
  activeClusterDissolved: "最小人数割れ解散",
  groupDissolved: "候補解散",
  groupExpired: "候補期限切れ",
  cleanedUp: "linger cleanup",
};

export const TRANSITION_RESULT_LABEL: Record<ClusterTransitionResult, string> = {
  completed: "遷移成功",
  invalidated: "遷移失敗(無効化)",
  abandoned: "遷移失敗(abandon)",
  explore: "目的地なし再探索",
};

export const INVALIDATION_REASON_LABEL: Record<ClusterTransitionInvalidationReason, string> = {
  currentClusterLost: "元クラスタ喪失",
  targetMissing: "target不在",
  targetDissolved: "target解散",
  targetExpired: "target期限切れ",
  targetFull: "target満員",
  focusAgentLeft: "focus agent離脱",
  intentExpired: "意図TTL超過",
};

/** 値が無いとき0や「正常」と捏造しないための表示 */
export function formatOptionalValue(
  value: string | number | undefined | null,
  absentLabel: string,
): string {
  if (value === undefined || value === null || value === "") return absentLabel;
  return String(value);
}

export function formatTickRange(
  startedAtTick: number,
  endedAtTick: number | undefined,
  status: AnalysisIntervalStatus,
): string {
  if (endedAtTick === undefined) {
    if (status === "censored") return `t=${startedAtTick}〜(観測打切り)`;
    return `t=${startedAtTick}〜(進行中)`;
  }
  return `t=${startedAtTick}〜${endedAtTick}`;
}
