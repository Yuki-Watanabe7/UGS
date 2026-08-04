/**
 * Issue #215: 選択した episode / transition / cluster lifetime の詳細 panel。
 * 未記録・進行中・非該当を 0 や「正常」と捏造しない。
 */
import type {
  Agent,
  ClusterLifetimeRecord,
  ClusterTransitionRecord,
  ConversationEpisodeRecord,
  SimulationState,
} from "../simulation/types";
import {
  EPISODE_END_REASON_ICON,
  EPISODE_END_REASON_LABEL,
  formatOptionalValue,
  formatTickRange,
  INTERVAL_STATUS_LABEL,
  INVALIDATION_REASON_LABEL,
  LIFETIME_END_REASON_LABEL,
  TRANSITION_RESULT_LABEL,
} from "./conversationHistoryLabels";
import type { ConversationHistorySelection } from "./conversationHistoryProjection";

type Props = {
  state: SimulationState;
  selection: ConversationHistorySelection | undefined;
  episode?: ConversationEpisodeRecord;
  transition?: ClusterTransitionRecord;
  lifetime?: ClusterLifetimeRecord;
  /** lifetime詳細用。選択clusterに属するepisode(任意) */
  relatedEpisodes?: readonly ConversationEpisodeRecord[];
};

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="conversation-history-detail-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function memberListLabel(ids: readonly string[] | undefined, agents: readonly Agent[]): string {
  if (ids === undefined) return "未記録";
  if (ids.length === 0) return "(空)";
  return ids
    .map((id) => {
      const agent = agents.find((a) => a.id === id);
      return agent ? `${agent.label}(${id})` : id;
    })
    .join(", ");
}

function EpisodeDetail({
  episode,
  agents,
}: {
  episode: ConversationEpisodeRecord;
  agents: readonly Agent[];
}) {
  const live = agents.find((a) => a.id === episode.agentId)?.currentEpisode;
  const liveMatches = live?.episodeId === episode.episodeId;
  const satisfaction = liveMatches ? live?.conversationSatisfaction : undefined;
  const attachment = liveMatches ? live?.attachment?.value : undefined;

  return (
    <div data-testid="conversation-history-detail-episode">
      <DetailRow label="種別" value="conversation episode" />
      <DetailRow label="episodeId" value={episode.episodeId} />
      <DetailRow label="agentId" value={episode.agentId} />
      <DetailRow label="clusterId" value={episode.clusterId} />
      <DetailRow
        label="区間"
        value={formatTickRange(episode.startedAtTick, episode.endedAtTick, episode.status)}
      />
      <DetailRow label="duration (dwell)" value={`${episode.dwellTicks} tick`} />
      <DetailRow label="状態" value={INTERVAL_STATUS_LABEL[episode.status]} />
      <DetailRow
        label="終了理由"
        value={
          episode.endReason
            ? `${EPISODE_END_REASON_ICON[episode.endReason]} ${EPISODE_END_REASON_LABEL[episode.endReason]}`
            : episode.status === "active"
              ? "非該当(進行中)"
              : episode.status === "censored"
                ? "非該当(観測打切り)"
                : "未記録"
        }
      />
      <DetailRow label="合流時 group status" value={episode.joinedGroupStatus} />
      <DetailRow label="開始時 member" value={memberListLabel(episode.startMemberIds, agents)} />
      <DetailRow label="終了時 member" value={memberListLabel(episode.endMemberIds, agents)} />
      <DetailRow
        label="satisfaction"
        value={
          satisfaction === undefined
            ? liveMatches
              ? "未記録"
              : "非該当(履歴外のlive値)"
            : String(satisfaction)
        }
      />
      <DetailRow
        label="attachment"
        value={
          attachment === undefined
            ? liveMatches
              ? "未記録"
              : "非該当(履歴外のlive値)"
            : String(attachment)
        }
      />
    </div>
  );
}

function TransitionDetail({ transition }: { transition: ClusterTransitionRecord }) {
  return (
    <div data-testid="conversation-history-detail-transition">
      <DetailRow label="種別" value="cluster transition" />
      <DetailRow label="transitionId" value={transition.transitionId} />
      <DetailRow label="agentId" value={transition.agentId} />
      <DetailRow label="source cluster" value={transition.sourceClusterId} />
      <DetailRow
        label="target cluster"
        value={formatOptionalValue(transition.targetClusterId, "非該当(explore等)")}
      />
      <DetailRow
        label="focus agent"
        value={formatOptionalValue(transition.focusAgentId, "未記録")}
      />
      <DetailRow
        label="区間"
        value={
          transition.endedAtTick === undefined
            ? `t=${transition.startedAtTick}〜(進行中)`
            : `t=${transition.startedAtTick}〜${transition.endedAtTick}`
        }
      />
      <DetailRow
        label="elapsed"
        value={
          transition.elapsedTicks === undefined ? "未記録" : `${transition.elapsedTicks} tick`
        }
      />
      <DetailRow
        label="結果"
        value={
          transition.result === undefined
            ? "進行中"
            : TRANSITION_RESULT_LABEL[transition.result]
        }
      />
      <DetailRow
        label="無効化理由"
        value={
          transition.invalidationReason === undefined
            ? transition.result === "invalidated"
              ? "未記録"
              : "非該当"
            : INVALIDATION_REASON_LABEL[transition.invalidationReason]
        }
      />
      <DetailRow
        label="source episode"
        value={formatOptionalValue(transition.sourceEpisodeId, "未記録")}
      />
      <DetailRow
        label="target episode"
        value={formatOptionalValue(transition.targetEpisodeId, "未記録")}
      />
    </div>
  );
}

function LifetimeDetail({
  lifetime,
  relatedEpisodes,
  agents,
}: {
  lifetime: ClusterLifetimeRecord;
  relatedEpisodes: readonly ConversationEpisodeRecord[];
  agents: readonly Agent[];
}) {
  const first = relatedEpisodes[0];
  const last = relatedEpisodes[relatedEpisodes.length - 1];
  return (
    <div data-testid="conversation-history-detail-lifetime">
      <DetailRow label="種別" value="cluster lifetime" />
      <DetailRow label="clusterId" value={lifetime.clusterId} />
      <DetailRow
        label="founder"
        value={formatOptionalValue(lifetime.founderAgentId, "未記録")}
      />
      <DetailRow
        label="区間"
        value={formatTickRange(lifetime.createdAtTick, lifetime.endedAtTick, lifetime.status)}
      />
      <DetailRow
        label="confirmedAt"
        value={
          lifetime.confirmedAtTick === undefined ? "未確認" : `t=${lifetime.confirmedAtTick}`
        }
      />
      <DetailRow
        label="dissolvingAt"
        value={
          lifetime.dissolvingAtTick === undefined
            ? "非該当"
            : `t=${lifetime.dissolvingAtTick}`
        }
      />
      <DetailRow label="状態" value={INTERVAL_STATUS_LABEL[lifetime.status]} />
      <DetailRow
        label="終了理由"
        value={
          lifetime.endReason
            ? LIFETIME_END_REASON_LABEL[lifetime.endReason]
            : lifetime.status === "active"
              ? "非該当(進行中)"
              : lifetime.status === "censored"
                ? "非該当(観測打切り)"
                : "未記録"
        }
      />
      <DetailRow label="peak size" value={String(lifetime.peakMemberCount)} />
      <DetailRow label="join count" value={String(lifetime.joinCount)} />
      <DetailRow label="voluntary leave" value={String(lifetime.voluntaryLeaveCount)} />
      <DetailRow label="forced release" value={String(lifetime.forcedReleaseCount)} />
      <DetailRow
        label="開始時 member (最初のepisode)"
        value={first ? memberListLabel(first.startMemberIds, agents) : "未記録"}
      />
      <DetailRow
        label="終了時 member (最後のepisode)"
        value={last ? memberListLabel(last.endMemberIds, agents) : "未記録"}
      />
    </div>
  );
}

export function ConversationHistoryDetail({
  state,
  selection,
  episode,
  transition,
  lifetime,
  relatedEpisodes = [],
}: Props) {
  if (!selection) {
    return (
      <div
        className="conversation-history-detail conversation-history-detail--empty"
        data-testid="conversation-history-detail-empty"
      >
        区間または遷移を選択すると詳細を表示します。過去tickの選択は履歴閲覧のみで、シミュレーションは巻き戻りません。
      </div>
    );
  }

  return (
    <div
      className="conversation-history-detail"
      data-testid="conversation-history-detail"
      aria-live="polite"
    >
      <h4 className="conversation-history-detail-title">詳細</h4>
      {selection.kind === "episode" && episode && (
        <EpisodeDetail episode={episode} agents={state.agents} />
      )}
      {selection.kind === "transition" && transition && (
        <TransitionDetail transition={transition} />
      )}
      {selection.kind === "lifetime" && lifetime && (
        <LifetimeDetail
          lifetime={lifetime}
          relatedEpisodes={relatedEpisodes}
          agents={state.agents}
        />
      )}
      {selection.kind === "episode" && !episode && (
        <p className="conversation-history-detail-missing">選択したepisodeは現在の履歴にありません。</p>
      )}
      {selection.kind === "transition" && !transition && (
        <p className="conversation-history-detail-missing">選択したtransitionは現在の履歴にありません。</p>
      )}
      {selection.kind === "lifetime" && !lifetime && (
        <p className="conversation-history-detail-missing">選択したclusterは現在の履歴にありません。</p>
      )}
    </div>
  );
}
