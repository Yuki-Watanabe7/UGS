/**
 * Issue #215: 会話履歴タイムラインの filter / 検索 UI。
 * 操作は表示専用で、simulation state / PRNG / 履歴生成には影響しない。
 */
import type {
  Agent,
  ClusterLifetimeRecord,
  ClusterTransitionResult,
  ConversationEpisodeEndReasonV2,
} from "../simulation/types";
import { EPISODE_END_REASON_LABEL, TRANSITION_RESULT_LABEL } from "./conversationHistoryLabels";
import type {
  ConversationHistoryDepartureKindFilter,
  ConversationHistoryIntervalStatusFilter,
  ConversationHistoryMode,
  ConversationHistoryViewFilter,
} from "./conversationHistoryProjection";

const END_REASON_OPTIONS: ConversationEpisodeEndReasonV2[] = [
  "voluntaryDeparture",
  "memberReleased",
  "membershipLost",
  "targetedTransition",
  "venueExit",
  "reset",
];

const TRANSITION_RESULT_OPTIONS: ClusterTransitionResult[] = [
  "completed",
  "invalidated",
  "abandoned",
  "explore",
];

type Props = {
  filter: ConversationHistoryViewFilter;
  onFilterChange: (next: ConversationHistoryViewFilter) => void;
  agents: readonly Agent[];
  lifetimes: readonly ClusterLifetimeRecord[];
  asOfTick: number;
};

export function ConversationHistoryFilters({
  filter,
  onFilterChange,
  agents,
  lifetimes,
  asOfTick,
}: Props) {
  const patch = (partial: Partial<ConversationHistoryViewFilter>) => {
    onFilterChange({ ...filter, ...partial });
  };

  return (
    <div className="conversation-history-filters" data-testid="conversation-history-filters">
      <div className="conversation-history-filter-row" role="group" aria-label="表示モード">
        <label className="conversation-history-filter-label" htmlFor="ch-mode">
          表示
        </label>
        <select
          id="ch-mode"
          className="conversation-history-filter-select"
          data-testid="conversation-history-mode"
          value={filter.mode}
          onChange={(e) => patch({ mode: e.target.value as ConversationHistoryMode })}
          aria-label="タイムライン表示モード"
        >
          <option value="agent">agent timeline</option>
          <option value="cluster">cluster timeline</option>
        </select>
      </div>

      <div className="conversation-history-filter-row">
        <label className="conversation-history-filter-label" htmlFor="ch-agent">
          agent
        </label>
        <select
          id="ch-agent"
          className="conversation-history-filter-select"
          data-testid="conversation-history-agent-filter"
          value={filter.agentId ?? ""}
          onChange={(e) => patch({ agentId: e.target.value || undefined })}
          aria-label="agentで絞り込み"
        >
          <option value="">すべて</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.label} ({agent.id}
              {agent.isObserverJoiner ? ", OJ" : ""})
            </option>
          ))}
        </select>
      </div>

      <div className="conversation-history-filter-row">
        <label className="conversation-history-filter-label" htmlFor="ch-cluster">
          cluster
        </label>
        <select
          id="ch-cluster"
          className="conversation-history-filter-select"
          data-testid="conversation-history-cluster-filter"
          value={filter.clusterId ?? ""}
          onChange={(e) => patch({ clusterId: e.target.value || undefined })}
          aria-label="clusterで絞り込み"
        >
          <option value="">すべて</option>
          {lifetimes.map((lifetime) => (
            <option key={lifetime.clusterId} value={lifetime.clusterId}>
              {lifetime.clusterId}
            </option>
          ))}
        </select>
      </div>

      <div className="conversation-history-filter-row conversation-history-filter-row--ticks">
        <label className="conversation-history-filter-label" htmlFor="ch-from-tick">
          tick範囲
        </label>
        <input
          id="ch-from-tick"
          className="conversation-history-filter-number"
          data-testid="conversation-history-from-tick"
          type="number"
          min={0}
          max={asOfTick}
          value={filter.fromTick ?? 0}
          onChange={(e) => {
            const value = Number(e.target.value);
            patch({ fromTick: Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0 });
          }}
          aria-label="表示開始tick"
        />
        <span className="conversation-history-filter-sep" aria-hidden="true">
          〜
        </span>
        <input
          id="ch-to-tick"
          className="conversation-history-filter-number"
          data-testid="conversation-history-to-tick"
          type="number"
          min={0}
          value={filter.toTick ?? asOfTick}
          onChange={(e) => {
            const value = Number(e.target.value);
            patch({
              toTick: Number.isFinite(value) && value >= 0 ? Math.floor(value) : asOfTick,
            });
          }}
          aria-label="表示終了tick(半開)"
        />
      </div>

      <div className="conversation-history-filter-row">
        <label className="conversation-history-filter-label" htmlFor="ch-end-reason">
          終了理由
        </label>
        <select
          id="ch-end-reason"
          className="conversation-history-filter-select"
          data-testid="conversation-history-end-reason"
          value={filter.endReasons?.[0] ?? ""}
          onChange={(e) => {
            const value = e.target.value as ConversationEpisodeEndReasonV2 | "";
            patch({ endReasons: value ? [value] : undefined });
          }}
          aria-label="episode終了理由で絞り込み"
        >
          <option value="">すべて</option>
          {END_REASON_OPTIONS.map((reason) => (
            <option key={reason} value={reason}>
              {EPISODE_END_REASON_LABEL[reason]}
            </option>
          ))}
        </select>
      </div>

      <div className="conversation-history-filter-row">
        <label className="conversation-history-filter-label" htmlFor="ch-departure">
          離脱種別
        </label>
        <select
          id="ch-departure"
          className="conversation-history-filter-select"
          data-testid="conversation-history-departure-kind"
          value={filter.departureKind ?? "all"}
          onChange={(e) =>
            patch({ departureKind: e.target.value as ConversationHistoryDepartureKindFilter })
          }
          aria-label="自発離脱・強制release・目的地付き遷移で絞り込み"
        >
          <option value="all">すべて</option>
          <option value="voluntary">自発離脱のみ</option>
          <option value="forced">強制releaseのみ</option>
          <option value="targeted">目的地付き遷移のみ</option>
        </select>
      </div>

      <div className="conversation-history-filter-row">
        <label className="conversation-history-filter-label" htmlFor="ch-transition-result">
          遷移結果
        </label>
        <select
          id="ch-transition-result"
          className="conversation-history-filter-select"
          data-testid="conversation-history-transition-result"
          value={filter.transitionResults?.[0] ?? ""}
          onChange={(e) => {
            const value = e.target.value as ClusterTransitionResult | "";
            patch({ transitionResults: value ? [value] : undefined });
          }}
          aria-label="targeted transitionの成功・失敗で絞り込み"
        >
          <option value="">すべて</option>
          {TRANSITION_RESULT_OPTIONS.map((result) => (
            <option key={result} value={result}>
              {TRANSITION_RESULT_LABEL[result]}
            </option>
          ))}
        </select>
      </div>

      <div className="conversation-history-filter-row">
        <label className="conversation-history-filter-label" htmlFor="ch-status">
          区間状態
        </label>
        <select
          id="ch-status"
          className="conversation-history-filter-select"
          data-testid="conversation-history-interval-status"
          value={filter.intervalStatus ?? "all"}
          onChange={(e) =>
            patch({
              intervalStatus: e.target.value as ConversationHistoryIntervalStatusFilter,
            })
          }
          aria-label="進行中のみ・完了のみで絞り込み"
        >
          <option value="all">すべて</option>
          <option value="active">進行中のみ</option>
          <option value="completed">完了のみ</option>
        </select>
      </div>

      <div className="conversation-history-filter-row">
        <label className="conversation-history-filter-check">
          <input
            type="checkbox"
            data-testid="conversation-history-oj-only"
            checked={filter.observerJoinerOnly === true}
            onChange={(e) => patch({ observerJoinerOnly: e.target.checked || undefined })}
          />
          ObserverJoinerのみ
        </label>
      </div>

      <div className="conversation-history-filter-row">
        <label className="conversation-history-filter-label" htmlFor="ch-search">
          検索
        </label>
        <input
          id="ch-search"
          className="conversation-history-filter-search"
          data-testid="conversation-history-search"
          type="search"
          value={filter.searchQuery ?? ""}
          onChange={(e) => patch({ searchQuery: e.target.value || undefined })}
          placeholder="agent / cluster ID"
          aria-label="agentラベル・ID、cluster IDを検索"
        />
      </div>
    </div>
  );
}
