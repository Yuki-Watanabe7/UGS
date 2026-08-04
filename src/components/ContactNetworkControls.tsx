/**
 * Issue #216: 接触ネットワークの weight / 時間窓 / filter / zoom 操作 UI。
 * 操作は表示専用で、simulation state / PRNG / 分析結果には影響しない。
 */
import type { Agent, ClusterLifetimeRecord } from "../simulation/types";
import {
  WEIGHT_MODE_DESCRIPTION,
  WEIGHT_MODE_LABEL,
  WEIGHT_MODE_UNIT,
} from "./contactNetworkLabels";
import type {
  ContactNetworkViewFilter,
  ContactNetworkWeightMode,
} from "./contactNetworkProjection";

const WEIGHT_MODES: ContactNetworkWeightMode[] = [
  "totalCoPresenceTicks",
  "contactIntervalCount",
  "distinctClusterCount",
  "binary",
];

type Props = {
  filter: ContactNetworkViewFilter;
  onFilterChange: (next: ContactNetworkViewFilter) => void;
  agents: readonly Agent[];
  lifetimes: readonly ClusterLifetimeRecord[];
  asOfTick: number;
  selectedAgentId?: string;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetView: () => void;
  onFitView: () => void;
  graphVisible: boolean;
  onGraphVisibleChange: (visible: boolean) => void;
};

export function ContactNetworkControls({
  filter,
  onFilterChange,
  agents,
  lifetimes,
  asOfTick,
  selectedAgentId,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onResetView,
  onFitView,
  graphVisible,
  onGraphVisibleChange,
}: Props) {
  const patch = (partial: Partial<ContactNetworkViewFilter>) => {
    onFilterChange({ ...filter, ...partial });
  };

  return (
    <div className="contact-network-controls" data-testid="contact-network-controls">
      <div className="contact-network-filter-row">
        <label className="contact-network-filter-check">
          <input
            type="checkbox"
            data-testid="contact-network-graph-visible"
            checked={graphVisible}
            onChange={(e) => onGraphVisibleChange(e.target.checked)}
          />
          グラフ表示
        </label>
      </div>

      <div className="contact-network-filter-row">
        <label className="contact-network-filter-label" htmlFor="cn-weight">
          weight
        </label>
        <select
          id="cn-weight"
          className="contact-network-filter-select"
          data-testid="contact-network-weight-mode"
          value={filter.weightMode}
          onChange={(e) => patch({ weightMode: e.target.value as ContactNetworkWeightMode })}
          aria-label="edge weightの定義"
        >
          {WEIGHT_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {WEIGHT_MODE_LABEL[mode]}
            </option>
          ))}
        </select>
      </div>
      <p className="contact-network-weight-meta" data-testid="contact-network-weight-meta">
        {WEIGHT_MODE_LABEL[filter.weightMode]}（単位: {WEIGHT_MODE_UNIT[filter.weightMode]}）—{" "}
        {WEIGHT_MODE_DESCRIPTION[filter.weightMode]}
        {filter.weightMode !== "binary" && (
          <>
            {" "}
            / 最小しきい値: {filter.minWeight ?? 0}
          </>
        )}
      </p>

      {filter.weightMode !== "binary" && (
        <div className="contact-network-filter-row">
          <label className="contact-network-filter-label" htmlFor="cn-min-weight">
            最小weight
          </label>
          <input
            id="cn-min-weight"
            className="contact-network-filter-number"
            data-testid="contact-network-min-weight"
            type="number"
            min={0}
            step={1}
            value={filter.minWeight ?? 0}
            onChange={(e) => {
              const value = Number(e.target.value);
              patch({
                minWeight: Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0,
              });
            }}
            aria-label="表示するedgeの最小weight"
          />
        </div>
      )}

      <div className="contact-network-filter-row contact-network-filter-row--ticks">
        <label className="contact-network-filter-label" htmlFor="cn-from-tick">
          tick範囲
        </label>
        <input
          id="cn-from-tick"
          className="contact-network-filter-number"
          data-testid="contact-network-from-tick"
          type="number"
          min={0}
          max={asOfTick}
          value={filter.fromTick ?? 0}
          onChange={(e) => {
            const value = Number(e.target.value);
            patch({ fromTick: Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0 });
          }}
          aria-label="接触集計の開始tick"
        />
        <span className="contact-network-filter-sep" aria-hidden="true">
          〜
        </span>
        <input
          id="cn-to-tick"
          className="contact-network-filter-number"
          data-testid="contact-network-to-tick"
          type="number"
          min={0}
          value={filter.toTick ?? asOfTick}
          onChange={(e) => {
            const value = Number(e.target.value);
            patch({
              toTick: Number.isFinite(value) && value >= 0 ? Math.floor(value) : asOfTick,
            });
          }}
          aria-label="接触集計の終了tick(半開)"
        />
      </div>

      <div className="contact-network-filter-row">
        <label className="contact-network-filter-label" htmlFor="cn-min-duration">
          最小duration
        </label>
        <input
          id="cn-min-duration"
          className="contact-network-filter-number"
          data-testid="contact-network-min-duration"
          type="number"
          min={1}
          value={filter.minDurationTicks ?? 1}
          onChange={(e) => {
            const value = Number(e.target.value);
            patch({
              minDurationTicks:
                Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1,
            });
          }}
          aria-label="接触intervalの最小duration(tick)"
        />
      </div>

      <div className="contact-network-filter-row">
        <label className="contact-network-filter-label" htmlFor="cn-cluster">
          cluster
        </label>
        <select
          id="cn-cluster"
          className="contact-network-filter-select"
          data-testid="contact-network-cluster-filter"
          value={filter.clusterId ?? ""}
          onChange={(e) => patch({ clusterId: e.target.value || undefined })}
          aria-label="clusterで接触edgeを絞り込み"
        >
          <option value="">すべて</option>
          {lifetimes.map((lifetime) => (
            <option key={lifetime.clusterId} value={lifetime.clusterId}>
              {lifetime.clusterId}
            </option>
          ))}
        </select>
      </div>

      <div className="contact-network-filter-row contact-network-filter-row--checks">
        <label className="contact-network-filter-check">
          <input
            type="checkbox"
            data-testid="contact-network-active-only"
            checked={filter.activeOnly === true}
            onChange={(e) => patch({ activeOnly: e.target.checked || undefined })}
          />
          進行中の接触のみ
        </label>
        <label className="contact-network-filter-check">
          <input
            type="checkbox"
            data-testid="contact-network-ego"
            checked={filter.egoNetwork === true}
            disabled={!selectedAgentId}
            onChange={(e) => patch({ egoNetwork: e.target.checked || undefined })}
          />
          選択agentのego network
          {!selectedAgentId && (
            <span className="contact-network-filter-hint">（agent未選択）</span>
          )}
        </label>
        <label className="contact-network-filter-check">
          <input
            type="checkbox"
            data-testid="contact-network-oj-edges"
            checked={filter.observerJoinerEdgesOnly === true}
            onChange={(e) =>
              patch({ observerJoinerEdgesOnly: e.target.checked || undefined })
            }
          />
          ObserverJoinerを含むedgeのみ
        </label>
        <label className="contact-network-filter-check">
          <input
            type="checkbox"
            data-testid="contact-network-show-isolated"
            checked={filter.showIsolated !== false}
            onChange={(e) => patch({ showIsolated: e.target.checked })}
          />
          接触0のisolated nodeを表示
        </label>
      </div>

      <div
        className="contact-network-zoom"
        data-testid="contact-network-zoom"
        role="group"
        aria-label="グラフ表示倍率"
      >
        <button
          type="button"
          className="contact-network-zoom-btn"
          data-testid="contact-network-zoom-out"
          onClick={onZoomOut}
          aria-label="縮小"
        >
          −
        </button>
        <span className="contact-network-zoom-label" data-testid="contact-network-zoom-label">
          {zoomPercent}%
        </span>
        <button
          type="button"
          className="contact-network-zoom-btn"
          data-testid="contact-network-zoom-in"
          onClick={onZoomIn}
          aria-label="拡大"
        >
          ＋
        </button>
        <button
          type="button"
          className="contact-network-zoom-btn"
          data-testid="contact-network-fit-view"
          onClick={onFitView}
        >
          fit
        </button>
        <button
          type="button"
          className="contact-network-zoom-btn"
          data-testid="contact-network-reset-view"
          onClick={onResetView}
        >
          reset view
        </button>
      </div>

      <p className="contact-network-agent-count" aria-hidden="true">
        population {agents.length}人
      </p>
    </div>
  );
}
