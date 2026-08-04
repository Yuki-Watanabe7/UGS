/**
 * Issue #215: standingParty専用の会話履歴タイムライン。
 * `buildStandingPartyConversationHistory`のread modelを表示するだけで、
 * simulation state / PRNG / 履歴生成には影響しない。
 * afterParty / classroomPair では App 側で mount しない。
 */
import { useEffect, useMemo, useState } from "react";
import { buildStandingPartyConversationHistory } from "../simulation/standingPartyAnalysis";
import type {
  ConversationEpisodeRecord,
  SimulationState,
} from "../simulation/types";
import { ConversationHistoryDetail } from "./ConversationHistoryDetail";
import { ConversationHistoryFilters } from "./ConversationHistoryFilters";
import {
  EPISODE_END_REASON_ICON,
  EPISODE_END_REASON_LABEL,
  INTERVAL_STATUS_LABEL,
  TRANSITION_RESULT_LABEL,
} from "./conversationHistoryLabels";
import {
  currentTickMarkerPercent,
  findSelectedEpisode,
  findSelectedLifetime,
  findSelectedTransition,
  intervalToTrackStyle,
  projectConversationHistory,
  type ConversationHistorySelection,
  type ConversationHistoryViewFilter,
} from "./conversationHistoryProjection";

/** 長時間runでもDOMが膨らみすぎないよう、表示するレーン数の上限 */
const MAX_VISIBLE_LANES = 24;
/** 1レーンあたりの区間バー上限 */
const MAX_BARS_PER_LANE = 40;

type Props = {
  state: SimulationState;
  selectedAgentId?: string;
  onSelectedAgentIdChange?: (agentId: string | undefined) => void;
  selectedClusterId?: string;
  onSelectedClusterIdChange?: (clusterId: string | undefined) => void;
};

function episodeBarClass(episode: ConversationEpisodeRecord, selected: boolean): string {
  const parts = ["conversation-history-bar", `conversation-history-bar--${episode.status}`];
  if (episode.endReason) {
    parts.push(`conversation-history-bar--reason-${episode.endReason}`);
  }
  if (selected) parts.push("conversation-history-bar--selected");
  return parts.join(" ");
}

function episodeAccessibleName(episode: ConversationEpisodeRecord): string {
  const reason =
    episode.endReason !== undefined
      ? EPISODE_END_REASON_LABEL[episode.endReason]
      : INTERVAL_STATUS_LABEL[episode.status];
  const end =
    episode.endedAtTick === undefined
      ? episode.status === "censored"
        ? "観測打切り"
        : "進行中"
      : String(episode.endedAtTick);
  return `episode ${episode.episodeId}: agent ${episode.agentId} が cluster ${episode.clusterId} に t=${episode.startedAtTick}〜${end}、${reason}`;
}

export function ConversationHistoryTimeline({
  state,
  selectedAgentId,
  onSelectedAgentIdChange,
  selectedClusterId,
  onSelectedClusterIdChange,
}: Props) {
  const [filter, setFilter] = useState<ConversationHistoryViewFilter>({
    mode: "agent",
    agentId: selectedAgentId,
    clusterId: selectedClusterId,
    fromTick: 0,
  });
  const [selection, setSelection] = useState<ConversationHistorySelection | undefined>(undefined);
  const [open, setOpen] = useState(true);

  // Canvas / Inspector の選択と filter を同期(表示専用。simは変更しない)
  useEffect(() => {
    setFilter((prev) =>
      prev.agentId === selectedAgentId ? prev : { ...prev, agentId: selectedAgentId },
    );
  }, [selectedAgentId]);

  useEffect(() => {
    setFilter((prev) =>
      prev.clusterId === selectedClusterId ? prev : { ...prev, clusterId: selectedClusterId },
    );
  }, [selectedClusterId]);

  // Reset / 新runで履歴が空になったら選択をクリア
  useEffect(() => {
    setSelection(undefined);
    setFilter((prev) => ({
      ...prev,
      fromTick: 0,
      toTick: undefined,
      endReasons: undefined,
      departureKind: "all",
      transitionResults: undefined,
      searchQuery: undefined,
    }));
  }, [state.seed, state.formationScenarioId]);

  const history = useMemo(() => buildStandingPartyConversationHistory(state), [state]);

  const effectiveFilter = useMemo(
    (): ConversationHistoryViewFilter => ({
      ...filter,
      toTick: filter.toTick ?? Math.max(history.asOfTick, (filter.fromTick ?? 0) + 1),
    }),
    [filter, history.asOfTick],
  );

  const projection = useMemo(
    () => projectConversationHistory(state, history, effectiveFilter),
    [state, history, effectiveFilter],
  );

  const handleFilterChange = (next: ConversationHistoryViewFilter) => {
    setFilter(next);
    if (next.agentId !== selectedAgentId) {
      onSelectedAgentIdChange?.(next.agentId);
    }
    if (next.clusterId !== selectedClusterId) {
      onSelectedClusterIdChange?.(next.clusterId);
    }
  };

  const selectEpisode = (episode: ConversationEpisodeRecord) => {
    setSelection({ kind: "episode", id: episode.episodeId });
    onSelectedAgentIdChange?.(episode.agentId);
    onSelectedClusterIdChange?.(episode.clusterId);
  };

  const selectTransition = (transitionId: string, agentId: string, clusterId: string) => {
    setSelection({ kind: "transition", id: transitionId });
    onSelectedAgentIdChange?.(agentId);
    onSelectedClusterIdChange?.(clusterId);
  };

  const selectLifetime = (clusterId: string) => {
    setSelection({ kind: "lifetime", id: clusterId });
    onSelectedClusterIdChange?.(clusterId);
  };

  const selectedEpisode = findSelectedEpisode(history, selection);
  const selectedTransition = findSelectedTransition(history, selection);
  const selectedLifetime = findSelectedLifetime(history, selection);

  const tickMarker = currentTickMarkerPercent(
    state.tick,
    projection.viewFromTick,
    projection.spanTicks,
  );

  const isEmpty =
    projection.episodes.length === 0 &&
    projection.transitions.length === 0 &&
    (effectiveFilter.mode === "cluster" ? projection.lifetimes.length === 0 : true);

  const visibleAgentLanes = projection.agentLanes.slice(0, MAX_VISIBLE_LANES);
  const visibleClusterLanes = projection.clusterLanes.slice(0, MAX_VISIBLE_LANES);
  const truncatedLanes =
    effectiveFilter.mode === "agent"
      ? projection.agentLanes.length > MAX_VISIBLE_LANES
      : projection.clusterLanes.length > MAX_VISIBLE_LANES;

  return (
    <details
      className="panel conversation-history"
      data-testid="conversation-history"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="conversation-history-summary">会話履歴タイムライン</summary>
      <p className="conversation-history-note">
        #212の正規履歴を表示します。表示操作はシミュレーション本体・PRNG・履歴生成に影響しません。
        過去tickの選択は閲覧のみで、将来のreplay実装との境界もここです(巻き戻しはしません)。
      </p>

      <ConversationHistoryFilters
        filter={effectiveFilter}
        onFilterChange={handleFilterChange}
        agents={state.agents}
        lifetimes={history.clusterLifetimes}
        asOfTick={history.asOfTick}
      />

      <div
        className="conversation-history-axis"
        data-testid="conversation-history-axis"
        aria-hidden="true"
      >
        <span>t={projection.viewFromTick}</span>
        <span>現在 tick={state.tick}</span>
        <span>t={projection.viewToTick} (半開)</span>
      </div>

      {isEmpty ? (
        <div
          className="conversation-history-empty"
          data-testid="conversation-history-empty"
          role="status"
        >
          条件に一致する履歴がありません。filter を緩めるか、シミュレーションを進めてください。
        </div>
      ) : (
        <div
          className="conversation-history-tracks"
          data-testid="conversation-history-tracks"
          role="list"
          aria-label={
            effectiveFilter.mode === "agent" ? "agent別会話区間" : "cluster別寿命と参加区間"
          }
        >
          {effectiveFilter.mode === "agent" &&
            visibleAgentLanes.map((lane) => (
              <div
                key={lane.agentId}
                className="conversation-history-lane"
                role="listitem"
                data-testid={`conversation-history-agent-lane-${lane.agentId}`}
              >
                <button
                  type="button"
                  className="conversation-history-lane-label"
                  onClick={() => onSelectedAgentIdChange?.(lane.agentId)}
                  aria-label={`agent ${lane.label} (${lane.agentId}) を選択`}
                >
                  {lane.label}
                </button>
                <div className="conversation-history-track">
                  {tickMarker !== undefined && (
                    <div
                      className="conversation-history-tick-marker"
                      style={{ left: `${tickMarker}%` }}
                      data-testid="conversation-history-tick-marker"
                    />
                  )}
                  {lane.episodes.slice(0, MAX_BARS_PER_LANE).map((episode) => {
                    const style = intervalToTrackStyle(
                      episode.startedAtTick,
                      episode.endedAtTick,
                      projection.asOfTick,
                      projection.viewFromTick,
                      projection.spanTicks,
                    );
                    const selected =
                      selection?.kind === "episode" && selection.id === episode.episodeId;
                    const icon = episode.endReason
                      ? EPISODE_END_REASON_ICON[episode.endReason]
                      : episode.status === "active"
                        ? "…"
                        : episode.status === "censored"
                          ? "|"
                          : "•";
                    return (
                      <button
                        key={episode.episodeId}
                        type="button"
                        className={episodeBarClass(episode, selected)}
                        style={{ left: `${style.leftPercent}%`, width: `${style.widthPercent}%` }}
                        data-testid={`conversation-history-episode-${episode.episodeId}`}
                        data-status={episode.status}
                        data-end-reason={episode.endReason}
                        aria-label={episodeAccessibleName(episode)}
                        aria-pressed={selected}
                        onClick={() => selectEpisode(episode)}
                      >
                        <span className="conversation-history-bar-icon" aria-hidden="true">
                          {icon}
                        </span>
                        <span className="conversation-history-bar-label">
                          {episode.clusterId}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

          {effectiveFilter.mode === "cluster" &&
            visibleClusterLanes.map((lane) => {
              const lifeStyle = intervalToTrackStyle(
                lane.lifetime.createdAtTick,
                lane.lifetime.endedAtTick,
                projection.asOfTick,
                projection.viewFromTick,
                projection.spanTicks,
              );
              const lifeSelected =
                selection?.kind === "lifetime" && selection.id === lane.clusterId;
              return (
                <div
                  key={lane.clusterId}
                  className="conversation-history-lane"
                  role="listitem"
                  data-testid={`conversation-history-cluster-lane-${lane.clusterId}`}
                >
                  <button
                    type="button"
                    className="conversation-history-lane-label"
                    onClick={() => selectLifetime(lane.clusterId)}
                    aria-label={`cluster ${lane.clusterId} を選択`}
                    aria-pressed={lifeSelected}
                  >
                    {lane.clusterId}
                  </button>
                  <div className="conversation-history-track">
                    {tickMarker !== undefined && (
                      <div
                        className="conversation-history-tick-marker"
                        style={{ left: `${tickMarker}%` }}
                      />
                    )}
                    <button
                      type="button"
                      className={
                        "conversation-history-bar conversation-history-bar--lifetime" +
                        ` conversation-history-bar--${lane.lifetime.status}` +
                        (lifeSelected ? " conversation-history-bar--selected" : "")
                      }
                      style={{
                        left: `${lifeStyle.leftPercent}%`,
                        width: `${lifeStyle.widthPercent}%`,
                      }}
                      data-testid={`conversation-history-lifetime-${lane.clusterId}`}
                      data-status={lane.lifetime.status}
                      aria-label={`cluster ${lane.clusterId} lifetime: ${INTERVAL_STATUS_LABEL[lane.lifetime.status]}、peak ${lane.lifetime.peakMemberCount}`}
                      aria-pressed={lifeSelected}
                      onClick={() => selectLifetime(lane.clusterId)}
                    >
                      <span className="conversation-history-bar-label">
                        peak {lane.lifetime.peakMemberCount} / join {lane.lifetime.joinCount}
                      </span>
                    </button>
                    {lane.episodes.slice(0, MAX_BARS_PER_LANE).map((episode) => {
                      const style = intervalToTrackStyle(
                        episode.startedAtTick,
                        episode.endedAtTick,
                        projection.asOfTick,
                        projection.viewFromTick,
                        projection.spanTicks,
                      );
                      const selected =
                        selection?.kind === "episode" && selection.id === episode.episodeId;
                      return (
                        <button
                          key={episode.episodeId}
                          type="button"
                          className={
                            episodeBarClass(episode, selected) +
                            " conversation-history-bar--membership"
                          }
                          style={{
                            left: `${style.leftPercent}%`,
                            width: `${style.widthPercent}%`,
                            top: "18px",
                          }}
                          data-testid={`conversation-history-episode-${episode.episodeId}`}
                          data-status={episode.status}
                          data-end-reason={episode.endReason}
                          aria-label={episodeAccessibleName(episode)}
                          aria-pressed={selected}
                          onClick={() => selectEpisode(episode)}
                        >
                          <span className="conversation-history-bar-label">{episode.agentId}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

          {projection.transitions.length > 0 && (
            <div
              className="conversation-history-lane conversation-history-lane--transitions"
              role="listitem"
              data-testid="conversation-history-transition-lane"
            >
              <span className="conversation-history-lane-label">遷移</span>
              <div className="conversation-history-track">
                {tickMarker !== undefined && (
                  <div
                    className="conversation-history-tick-marker"
                    style={{ left: `${tickMarker}%` }}
                  />
                )}
                {projection.transitions.slice(0, MAX_BARS_PER_LANE).map((transition) => {
                  const style = intervalToTrackStyle(
                    transition.startedAtTick,
                    transition.endedAtTick,
                    projection.asOfTick,
                    projection.viewFromTick,
                    projection.spanTicks,
                  );
                  const selected =
                    selection?.kind === "transition" && selection.id === transition.transitionId;
                  const resultLabel =
                    transition.result === undefined
                      ? "進行中"
                      : TRANSITION_RESULT_LABEL[transition.result];
                  const lineStyle =
                    transition.result === "completed"
                      ? "solid"
                      : transition.result === "explore"
                        ? "dotted"
                        : "dashed";
                  return (
                    <button
                      key={transition.transitionId}
                      type="button"
                      className={
                        "conversation-history-bar conversation-history-bar--transition" +
                        (selected ? " conversation-history-bar--selected" : "")
                      }
                      style={{
                        left: `${style.leftPercent}%`,
                        width: `${style.widthPercent}%`,
                        borderStyle: lineStyle,
                      }}
                      data-testid={`conversation-history-transition-${transition.transitionId}`}
                      data-result={transition.result}
                      aria-label={`transition ${transition.transitionId}: ${transition.sourceClusterId} → ${transition.targetClusterId ?? "explore"}、${resultLabel}`}
                      aria-pressed={selected}
                      onClick={() =>
                        selectTransition(
                          transition.transitionId,
                          transition.agentId,
                          transition.targetClusterId ?? transition.sourceClusterId,
                        )
                      }
                    >
                      <span className="conversation-history-bar-icon" aria-hidden="true">
                        →
                      </span>
                      <span className="conversation-history-bar-label">{resultLabel}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {truncatedLanes && (
        <p className="conversation-history-truncation" data-testid="conversation-history-truncation">
          表示レーンを{MAX_VISIBLE_LANES}件に制限しています。agent / cluster / tick範囲で絞り込んでください。
        </p>
      )}

      <ConversationHistoryDetail
        state={state}
        selection={selection}
        episode={selectedEpisode}
        transition={selectedTransition}
        lifetime={selectedLifetime}
        relatedEpisodes={
          selectedLifetime
            ? history.episodes.filter((e) => e.clusterId === selectedLifetime.clusterId)
            : []
        }
      />
    </details>
  );
}
