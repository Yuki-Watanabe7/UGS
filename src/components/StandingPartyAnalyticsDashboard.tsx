/**
 * Issue #217: standingParty専用の統計ダッシュボード。
 * #214の`buildStandingPartyRunStatistics`結果を分布・時系列・内訳・代替tableで表示し、
 * #217の JSON/CSV export を提供する。simulation state / PRNG には影響しない。
 * afterParty / classroomPair では App 側で mount しない。
 */
import { useEffect, useMemo, useState } from "react";
import {
  buildStandingPartyAnalysisCsvFiles,
  buildStandingPartyAnalysisExport,
  serializeStandingPartyAnalysisExport,
  triggerTextDownload,
} from "../simulation/analysisExport";
import {
  buildStandingPartyConversationHistory,
  buildStandingPartyRunStatistics,
} from "../simulation/standingPartyAnalysis";
import type { StandingPartyScenarioConfig } from "../simulation/standingPartyScenarioConfig";
import type {
  ClusterLifetimeEndReason,
  ClusterTransitionInvalidationReason,
  ClusterTransitionResult,
  ConversationEpisodeEndReasonV2,
  DistributionSummary,
  SimParams,
  SimulationState,
  StandingPartyRunStatistics,
  StandingPartyStatisticsFilter,
  StandingPartyTimeSeriesPoint,
} from "../simulation/types";
import {
  EPISODE_END_REASON_LABEL,
  INVALIDATION_REASON_LABEL,
  LIFETIME_END_REASON_LABEL,
  TRANSITION_RESULT_LABEL,
} from "./conversationHistoryLabels";
import {
  chooseSeriesSampleInterval,
  formatDistribution,
  formatNumber,
  formatRate,
} from "./analyticsDashboardFormat";

type Props = {
  state: SimulationState;
  params: SimParams;
  presetId: string;
  standingPartyConfig: StandingPartyScenarioConfig;
  selectedAgentId?: string;
  onSelectedAgentIdChange?: (agentId: string | undefined) => void;
  selectedClusterId?: string;
  onSelectedClusterIdChange?: (clusterId: string | undefined) => void;
  /** timeline / network への drill-down */
  onDrillDown?: (focus: {
    agentId?: string;
    clusterId?: string;
    fromTick?: number;
    toTick?: number;
  }) => void;
};

type ViewMode = "charts" | "tables";

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

const DEFAULT_FILTER: StandingPartyStatisticsFilter = {
  fromTick: 0,
  includeActive: true,
  observerJoinerMode: "all",
};

function DistributionBox({
  title,
  summary,
  unit,
  activeCount,
  testId,
}: {
  title: string;
  summary: DistributionSummary;
  unit: string;
  activeCount?: number;
  testId: string;
}) {
  return (
    <section className="analytics-dist" data-testid={testId}>
      <h4 className="analytics-section-title">{title}</h4>
      <p className="analytics-dist-meta">
        単位: {unit} / 対象件数: {summary.count}
        {activeCount !== undefined ? ` / 進行中(分布外): ${activeCount}` : ""}
      </p>
      {summary.count === 0 ? (
        <p className="analytics-empty">完了サンプルなし (中央値・分位点は非該当)</p>
      ) : (
        <>
          <div className="analytics-box" aria-hidden="true">
            <span className="analytics-box-whisker" style={{ left: "8%" }} />
            <span
              className="analytics-box-iqr"
              title={`p25=${formatNumber(summary.p25)}〜p75=${formatNumber(summary.p75)}`}
              style={{ left: "28%", width: "44%" }}
            />
            <span
              className="analytics-box-median"
              title={`median=${formatNumber(summary.median)}`}
              style={{ left: "50%" }}
            />
          </div>
          <dl className="analytics-dist-stats">
            <div>
              <dt>median</dt>
              <dd>{formatNumber(summary.median)}</dd>
            </div>
            <div>
              <dt>p25</dt>
              <dd>{formatNumber(summary.p25)}</dd>
            </div>
            <div>
              <dt>p75</dt>
              <dd>{formatNumber(summary.p75)}</dd>
            </div>
            <div>
              <dt>mean</dt>
              <dd>{formatNumber(summary.mean)}</dd>
            </div>
            <div>
              <dt>min〜max</dt>
              <dd>
                {formatNumber(summary.min)}〜{formatNumber(summary.max)}
              </dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}

function TimeSeriesSvg({
  points,
  seriesKey,
  label,
}: {
  points: readonly StandingPartyTimeSeriesPoint[];
  seriesKey: keyof StandingPartyTimeSeriesPoint;
  label: string;
}) {
  const width = 320;
  const height = 96;
  const pad = 8;
  if (points.length === 0) {
    return <p className="analytics-empty">{label}: サンプルなし</p>;
  }
  const values = points.map((p) => Number(p[seriesKey]));
  const maxV = Math.max(...values, 1);
  const minTick = points[0]!.tick;
  const maxTick = points[points.length - 1]!.tick;
  const span = Math.max(maxTick - minTick, 1);
  const path = points
    .map((p, i) => {
      const x = pad + ((p.tick - minTick) / span) * (width - pad * 2);
      const y = height - pad - (Number(p[seriesKey]) / maxV) * (height - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <figure className="analytics-series" data-testid={`analytics-series-${seriesKey}`}>
      <figcaption>
        {label} (max={maxV}, ticks={points.length})
      </figcaption>
      <svg
        className="analytics-series-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label}の時系列。最大値${maxV}、サンプル数${points.length}`}
      >
        <path d={path} className="analytics-series-line" fill="none" />
        <text x={pad} y={14} className="analytics-series-label">
          {label}
        </text>
      </svg>
    </figure>
  );
}

export function StandingPartyAnalyticsDashboard({
  state,
  params,
  presetId,
  standingPartyConfig,
  selectedAgentId,
  onSelectedAgentIdChange,
  selectedClusterId,
  onSelectedClusterIdChange,
  onDrillDown,
}: Props) {
  const [filter, setFilter] = useState<StandingPartyStatisticsFilter>({
    ...DEFAULT_FILTER,
    agentIds: selectedAgentId ? [selectedAgentId] : undefined,
    clusterIds: selectedClusterId ? [selectedClusterId] : undefined,
  });
  const [viewMode, setViewMode] = useState<ViewMode>("charts");
  const [open, setOpen] = useState(true);
  const [endReasonDraft, setEndReasonDraft] = useState<ConversationEpisodeEndReasonV2 | "">("");
  const [transitionResultDraft, setTransitionResultDraft] = useState<ClusterTransitionResult | "">(
    "",
  );

  useEffect(() => {
    setFilter((prev) => {
      const nextAgentIds = selectedAgentId ? [selectedAgentId] : undefined;
      const prevId = prev.agentIds?.[0];
      if (prevId === selectedAgentId || (!prevId && !selectedAgentId)) return prev;
      return { ...prev, agentIds: nextAgentIds };
    });
  }, [selectedAgentId]);

  useEffect(() => {
    setFilter((prev) => {
      const nextClusterIds = selectedClusterId ? [selectedClusterId] : undefined;
      const prevId = prev.clusterIds?.[0];
      if (prevId === selectedClusterId || (!prevId && !selectedClusterId)) return prev;
      return { ...prev, clusterIds: nextClusterIds };
    });
  }, [selectedClusterId]);

  useEffect(() => {
    setFilter({ ...DEFAULT_FILTER });
    setEndReasonDraft("");
    setTransitionResultDraft("");
  }, [state.seed, state.formationScenarioId, presetId]);

  const history = useMemo(() => buildStandingPartyConversationHistory(state), [state]);
  const asOfTick = history.asOfTick;
  const fromTick = filter.fromTick ?? 0;
  const toTick = filter.toTick ?? asOfTick;
  const seriesSampleIntervalTicks = chooseSeriesSampleInterval(fromTick, toTick);

  const statistics: StandingPartyRunStatistics = useMemo(
    () =>
      buildStandingPartyRunStatistics(state, {
        history,
        ...filter,
        asOfTick,
        seriesSampleIntervalTicks,
      }),
    [state, history, filter, asOfTick, seriesSampleIntervalTicks],
  );

  const run = statistics.run;
  const oj = statistics.observerJoinerComparison;

  const actionTotals = useMemo(() => {
    let explore = 0;
    let started = 0;
    let success = 0;
    let failure = 0;
    let fallback = 0;
    let attachment = 0;
    let concern = 0;
    let mixed = 0;
    for (const agent of statistics.agents) {
      explore += agent.departAndExploreCount;
      started += agent.targetedTransitionStartedCount;
      success += agent.targetedTransitionSuccessCount;
      failure += agent.targetedTransitionFailureCount;
      fallback += agent.targetedTransitionFallbackCount;
      attachment += agent.stayedByAttachmentCount;
      concern += agent.stayedByDepartureConcernCount;
      mixed += agent.stayedByMixedInhibitionCount;
    }
    return { explore, started, success, failure, fallback, attachment, concern, mixed };
  }, [statistics.agents]);

  const clusterEndReasons = useMemo(() => {
    const counts: Partial<Record<ClusterLifetimeEndReason, number>> = {};
    for (const cluster of statistics.clusters) {
      if (!cluster.endReason) continue;
      counts[cluster.endReason] = (counts[cluster.endReason] ?? 0) + 1;
    }
    return counts;
  }, [statistics.clusters]);

  const patchFilter = (partial: Partial<StandingPartyStatisticsFilter>) => {
    setFilter((prev) => ({ ...prev, ...partial }));
  };

  const handleAgentFilter = (agentId: string) => {
    const next = agentId || undefined;
    patchFilter({ agentIds: next ? [next] : undefined });
    onSelectedAgentIdChange?.(next);
  };

  const handleClusterFilter = (clusterId: string) => {
    const next = clusterId || undefined;
    patchFilter({ clusterIds: next ? [next] : undefined });
    onSelectedClusterIdChange?.(next);
  };

  const handleExportJson = () => {
    const bundle = buildStandingPartyAnalysisExport(state, {
      history,
      ...filter,
      asOfTick,
      presetId,
      standingPartyConfig,
      simParams: params,
      statistics,
      seriesSampleIntervalTicks,
    });
    triggerTextDownload(
      `standing-party-analysis-seed${bundle.run.seed}-t${bundle.generatedAtTick}.json`,
      serializeStandingPartyAnalysisExport(bundle),
      "application/json;charset=utf-8",
    );
  };

  const handleExportCsv = () => {
    const bundle = buildStandingPartyAnalysisExport(state, {
      history,
      ...filter,
      asOfTick,
      presetId,
      standingPartyConfig,
      simParams: params,
      statistics,
      seriesSampleIntervalTicks,
    });
    for (const file of buildStandingPartyAnalysisCsvFiles(bundle)) {
      triggerTextDownload(file.filename, file.content, "text/csv;charset=utf-8");
    }
  };

  const drillToTimeline = () => {
    onDrillDown?.({
      agentId: filter.agentIds?.[0],
      clusterId: filter.clusterIds?.[0],
      fromTick: filter.fromTick,
      toTick: filter.toTick,
    });
  };

  const failureEntries = Object.entries(run.targetedTransitionFailureByReason) as [
    ClusterTransitionInvalidationReason,
    number,
  ][];

  return (
    <details
      className="panel analytics-dashboard"
      data-testid="analytics-dashboard"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="analytics-dashboard-summary">統計ダッシュボード (#217)</summary>
      <p className="analytics-dashboard-note">
        #214の記述統計を分布・時系列・内訳で確認します。接触人数は友人数や人気ではありません。
        表示・export操作はsimulation / PRNGに影響しません。
      </p>

      <div className="analytics-filters" data-testid="analytics-filters" role="group" aria-label="統計filter">
        <div className="analytics-filter-row">
          <label htmlFor="ad-from-tick">tick範囲</label>
          <input
            id="ad-from-tick"
            data-testid="analytics-from-tick"
            type="number"
            min={0}
            max={asOfTick}
            value={filter.fromTick ?? 0}
            onChange={(e) => {
              const value = Number(e.target.value);
              patchFilter({
                fromTick: Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0,
              });
            }}
          />
          <span aria-hidden="true">〜</span>
          <input
            id="ad-to-tick"
            data-testid="analytics-to-tick"
            type="number"
            min={0}
            value={filter.toTick ?? asOfTick}
            onChange={(e) => {
              const value = Number(e.target.value);
              patchFilter({
                toTick: Number.isFinite(value) && value >= 0 ? Math.floor(value) : asOfTick,
              });
            }}
          />
        </div>

        <div className="analytics-filter-row">
          <label htmlFor="ad-agent">agent</label>
          <select
            id="ad-agent"
            data-testid="analytics-agent-filter"
            value={filter.agentIds?.[0] ?? ""}
            onChange={(e) => handleAgentFilter(e.target.value)}
          >
            <option value="">すべて</option>
            {state.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label} ({agent.id}
                {agent.isObserverJoiner ? ", OJ" : ""})
              </option>
            ))}
          </select>
        </div>

        <div className="analytics-filter-row">
          <label htmlFor="ad-cluster">cluster</label>
          <select
            id="ad-cluster"
            data-testid="analytics-cluster-filter"
            value={filter.clusterIds?.[0] ?? ""}
            onChange={(e) => handleClusterFilter(e.target.value)}
          >
            <option value="">すべて</option>
            {history.clusterLifetimes.map((life) => (
              <option key={life.clusterId} value={life.clusterId}>
                {life.clusterId}
              </option>
            ))}
          </select>
        </div>

        <div className="analytics-filter-row">
          <label htmlFor="ad-oj">ObserverJoiner</label>
          <select
            id="ad-oj"
            data-testid="analytics-oj-filter"
            value={filter.observerJoinerMode ?? "all"}
            onChange={(e) =>
              patchFilter({
                observerJoinerMode: e.target.value as StandingPartyStatisticsFilter["observerJoinerMode"],
              })
            }
          >
            <option value="all">全員</option>
            <option value="only">OJのみ</option>
            <option value="exclude">OJ除外</option>
          </select>
        </div>

        <div className="analytics-filter-row">
          <label htmlFor="ad-end-reason">episode終了理由</label>
          <select
            id="ad-end-reason"
            data-testid="analytics-end-reason-filter"
            value={endReasonDraft}
            onChange={(e) => {
              const value = e.target.value as ConversationEpisodeEndReasonV2 | "";
              setEndReasonDraft(value);
              patchFilter({ endReasons: value ? [value] : undefined });
            }}
          >
            <option value="">すべて</option>
            {END_REASON_OPTIONS.map((reason) => (
              <option key={reason} value={reason}>
                {EPISODE_END_REASON_LABEL[reason]}
              </option>
            ))}
          </select>
        </div>

        <div className="analytics-filter-row">
          <label htmlFor="ad-transition-result">transition結果</label>
          <select
            id="ad-transition-result"
            data-testid="analytics-transition-result-filter"
            value={transitionResultDraft}
            onChange={(e) => {
              const value = e.target.value as ClusterTransitionResult | "";
              setTransitionResultDraft(value);
              patchFilter({ transitionResults: value ? [value] : undefined });
            }}
          >
            <option value="">すべて</option>
            {TRANSITION_RESULT_OPTIONS.map((result) => (
              <option key={result} value={result}>
                {TRANSITION_RESULT_LABEL[result]}
              </option>
            ))}
          </select>
        </div>

        <label className="analytics-filter-check">
          <input
            data-testid="analytics-include-active"
            type="checkbox"
            checked={filter.includeActive !== false}
            onChange={(e) => patchFilter({ includeActive: e.target.checked })}
          />
          進行中/打切りを件数・系列に含める (完了分布には混ぜない)
        </label>
      </div>

      <div className="analytics-toolbar">
        <div className="analytics-view-toggle" role="group" aria-label="表示切替">
          <button
            type="button"
            data-testid="analytics-view-charts"
            className={viewMode === "charts" ? "is-active" : undefined}
            aria-pressed={viewMode === "charts"}
            onClick={() => setViewMode("charts")}
          >
            チャート
          </button>
          <button
            type="button"
            data-testid="analytics-view-tables"
            className={viewMode === "tables" ? "is-active" : undefined}
            aria-pressed={viewMode === "tables"}
            onClick={() => setViewMode("tables")}
          >
            代替table
          </button>
        </div>
        <div className="analytics-export" role="group" aria-label="データ出力">
          <button type="button" data-testid="analytics-export-json" onClick={handleExportJson}>
            JSON export
          </button>
          <button type="button" data-testid="analytics-export-csv" onClick={handleExportCsv}>
            CSV一式
          </button>
          <button type="button" data-testid="analytics-drilldown" onClick={drillToTimeline}>
            timeline/networkへ
          </button>
        </div>
      </div>

      <section className="analytics-overview" data-testid="analytics-overview" aria-label="overview">
        <article className="analytics-card">
          <h4>観測</h4>
          <p>
            現在tick {run.asOfTick} / 窓 [{run.observationFromTick}, {run.observationToTick})
          </p>
        </article>
        <article className="analytics-card">
          <h4>episode</h4>
          <p>
            完了 {run.completedEpisodeCount} / 進行中 {run.activeEpisodeCount}
            {filter.includeActive === false ? " (進行中はfilter除外)" : ""}
          </p>
        </article>
        <article className="analytics-card">
          <h4>接触network</h4>
          <p>
            unique edge {run.network.edgeCount} / isolated {run.network.isolatedNodeCount} / density{" "}
            {formatNumber(run.network.density, 3)}
          </p>
          <p className="analytics-card-hint">人口分母density: {formatRate(run.networkDensityVsPopulation)}</p>
        </article>
        <article className="analytics-card">
          <h4>cluster</h4>
          <p>
            生成総数 {run.clusterCreatedCount} / 終了 {run.clusterEndedCount} / 現在active{" "}
            {run.activeClusterCountAtAsOf}
          </p>
        </article>
        <article className="analytics-card">
          <h4>離脱・遷移</h4>
          <p>
            自発離脱 {run.voluntaryDepartureCount} / 強制release {run.forcedReleaseCount}
          </p>
          <p>
            目的地付き開始 {actionTotals.started} / 成功 {run.targetedTransitionSuccessCount} / 失敗{" "}
            {run.targetedTransitionFailureCount}
          </p>
          <p>成功率: {formatRate(run.targetedTransitionSuccessRate)}</p>
        </article>
        <article className="analytics-card">
          <h4>会場退出</h4>
          <p>{run.venueExitCount} 人</p>
        </article>
      </section>

      {viewMode === "charts" ? (
        <div className="analytics-charts" data-testid="analytics-charts">
          <DistributionBox
            title="完了episodeの滞在tick分布"
            summary={run.completedEpisodeDwellTicks}
            unit="tick"
            activeCount={run.activeEpisodeCount}
            testId="analytics-dwell-dist"
          />
          <DistributionBox
            title="agent別unique接触相手数"
            summary={run.agentDistinctContactCounts}
            unit="人 (接触相手数。友人数ではない)"
            testId="analytics-contact-degree-dist"
          />
          <DistributionBox
            title="pair総接触tick分布"
            summary={run.pairContactDurationTicks}
            unit="tick"
            testId="analytics-pair-contact-dist"
          />
          <DistributionBox
            title="完了cluster寿命"
            summary={run.completedClusterLifetimeTicks}
            unit="tick"
            testId="analytics-cluster-lifetime-dist"
          />
          <DistributionBox
            title="完了cluster peak size"
            summary={run.completedClusterPeakSizes}
            unit="人"
            testId="analytics-cluster-peak-dist"
          />

          <section className="analytics-breakdown" data-testid="analytics-motion-breakdown">
            <h4 className="analytics-section-title">移動・葛藤の内訳</h4>
            <ul>
              <li>departAndExplore: {actionTotals.explore}</li>
              <li>
                switchToTargetCluster 開始/成功/失敗/fallback: {actionTotals.started} /{" "}
                {actionTotals.success} / {actionTotals.failure} / {actionTotals.fallback}
              </li>
              <li>成功率 (eligible=成功+失敗): {formatRate(run.targetedTransitionSuccessRate)}</li>
              <li>stay (愛着): {actionTotals.attachment}</li>
              <li>stay (離脱配慮): {actionTotals.concern}</li>
              <li>stay (混合抑制): {actionTotals.mixed}</li>
            </ul>
            {failureEntries.length > 0 && (
              <ul data-testid="analytics-invalidation-reasons">
                {failureEntries.map(([reason, count]) => (
                  <li key={reason}>
                    {INVALIDATION_REASON_LABEL[reason]}: {count}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="analytics-breakdown" data-testid="analytics-cluster-end-reasons">
            <h4 className="analytics-section-title">cluster終了理由</h4>
            {Object.keys(clusterEndReasons).length === 0 ? (
              <p className="analytics-empty">終了済みclusterなし</p>
            ) : (
              <ul>
                {(Object.entries(clusterEndReasons) as [ClusterLifetimeEndReason, number][]).map(
                  ([reason, count]) => (
                    <li key={reason}>
                      {LIFETIME_END_REASON_LABEL[reason]}: {count}
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>

          <section className="analytics-oj" data-testid="analytics-oj-comparison">
            <h4 className="analytics-section-title">ObserverJoiner比較 (記述のみ・優劣なし)</h4>
            {oj.observerJoiners.length === 0 ? (
              <p className="analytics-empty">ObserverJoinerなし</p>
            ) : (
              <ul>
                {oj.observerJoiners.map((agent) => (
                  <li key={agent.agentId}>
                    <button
                      type="button"
                      className="analytics-link-btn"
                      onClick={() => {
                        handleAgentFilter(agent.agentId);
                        onDrillDown?.({ agentId: agent.agentId });
                      }}
                    >
                      {agent.label} ({agent.agentId})
                    </button>
                    : 接触相手 {agent.distinctContactCount} / 総接触tick {agent.totalContactTicks} /
                    完了滞在 {formatDistribution(agent.completedDwellTicks)}
                  </li>
                ))}
              </ul>
            )}
            <p>
              非OJ集団 (n={oj.nonObserverJoinerGroup.agentCount}): 接触相手{" "}
              {formatDistribution(oj.nonObserverJoinerGroup.distinctContactCount)} / 完了滞在{" "}
              {formatDistribution(oj.nonObserverJoinerGroup.completedDwellTicks)} / 退出率{" "}
              {formatRate(oj.nonObserverJoinerGroup.venueExitRate)}
            </p>
          </section>

          <div className="analytics-series-grid" data-testid="analytics-series-grid">
            <TimeSeriesSvg
              points={statistics.series.points}
              seriesKey="activeClusterCount"
              label="active cluster数"
            />
            <TimeSeriesSvg
              points={statistics.series.points}
              seriesKey="cumulativeCompletedEpisodeCount"
              label="完了episode累積"
            />
            <TimeSeriesSvg
              points={statistics.series.points}
              seriesKey="cumulativeUniqueContactEdgeCount"
              label="unique接触edge累積"
            />
            <TimeSeriesSvg
              points={statistics.series.points}
              seriesKey="cumulativeTargetedTransitionSuccessCount"
              label="遷移成功累積"
            />
          </div>
          <p className="analytics-card-hint">
            時系列sample間隔: {statistics.series.sampleIntervalTicks} tick (最終tickは保持)
          </p>
        </div>
      ) : (
        <div className="analytics-tables" data-testid="analytics-tables">
          <h4 className="analytics-section-title">agent統計</h4>
          <div className="analytics-table-wrap">
            <table className="analytics-table" data-testid="analytics-agent-table">
              <thead>
                <tr>
                  <th scope="col">agent</th>
                  <th scope="col">OJ</th>
                  <th scope="col">完了episode</th>
                  <th scope="col">進行中</th>
                  <th scope="col">滞在median</th>
                  <th scope="col">接触相手</th>
                  <th scope="col">遷移成功/失敗</th>
                </tr>
              </thead>
              <tbody>
                {statistics.agents.length === 0 ? (
                  <tr>
                    <td colSpan={7}>該当agentなし</td>
                  </tr>
                ) : (
                  statistics.agents.map((agent) => (
                    <tr key={agent.agentId}>
                      <td>
                        <button
                          type="button"
                          className="analytics-link-btn"
                          onClick={() => {
                            handleAgentFilter(agent.agentId);
                            onDrillDown?.({ agentId: agent.agentId });
                          }}
                        >
                          {agent.label}
                        </button>
                      </td>
                      <td>{agent.isObserverJoiner ? "yes" : "no"}</td>
                      <td>{agent.completedEpisodeCount}</td>
                      <td>{agent.activeEpisodeCount}</td>
                      <td>
                        {agent.completedDwellTicks.count === 0
                          ? "非該当"
                          : formatNumber(agent.completedDwellTicks.median)}
                      </td>
                      <td>{agent.distinctContactCount}</td>
                      <td>
                        {agent.targetedTransitionSuccessCount}/{agent.targetedTransitionFailureCount}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <h4 className="analytics-section-title">cluster統計</h4>
          <div className="analytics-table-wrap">
            <table className="analytics-table" data-testid="analytics-cluster-table">
              <thead>
                <tr>
                  <th scope="col">cluster</th>
                  <th scope="col">status</th>
                  <th scope="col">寿命</th>
                  <th scope="col">peak</th>
                  <th scope="col">mean</th>
                  <th scope="col">join/leave/release</th>
                  <th scope="col">終了理由</th>
                </tr>
              </thead>
              <tbody>
                {statistics.clusters.length === 0 ? (
                  <tr>
                    <td colSpan={7}>該当clusterなし</td>
                  </tr>
                ) : (
                  statistics.clusters.map((cluster) => (
                    <tr key={cluster.clusterId}>
                      <td>
                        <button
                          type="button"
                          className="analytics-link-btn"
                          onClick={() => {
                            handleClusterFilter(cluster.clusterId);
                            onDrillDown?.({ clusterId: cluster.clusterId });
                          }}
                        >
                          {cluster.clusterId}
                        </button>
                      </td>
                      <td>{cluster.status}</td>
                      <td>{cluster.lifetimeTicks}</td>
                      <td>{cluster.peakMemberCount}</td>
                      <td>
                        {cluster.meanMemberCount === undefined
                          ? "非該当"
                          : formatNumber(cluster.meanMemberCount)}
                      </td>
                      <td>
                        {cluster.joinCount}/{cluster.voluntaryLeaveCount}/{cluster.forcedReleaseCount}
                      </td>
                      <td>
                        {cluster.endReason
                          ? LIFETIME_END_REASON_LABEL[cluster.endReason]
                          : cluster.status === "active"
                            ? "進行中"
                            : "非該当"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <h4 className="analytics-section-title">時系列 (table)</h4>
          <div className="analytics-table-wrap">
            <table className="analytics-table" data-testid="analytics-series-table">
              <thead>
                <tr>
                  <th scope="col">tick</th>
                  <th scope="col">active cluster</th>
                  <th scope="col">joined</th>
                  <th scope="col">接触edge累積</th>
                  <th scope="col">完了episode累積</th>
                  <th scope="col">遷移成功累積</th>
                </tr>
              </thead>
              <tbody>
                {statistics.series.points.map((point) => (
                  <tr key={point.tick}>
                    <td>{point.tick}</td>
                    <td>{point.activeClusterCount}</td>
                    <td>{point.joinedCount}</td>
                    <td>{point.cumulativeUniqueContactEdgeCount}</td>
                    <td>{point.cumulativeCompletedEpisodeCount}</td>
                    <td>{point.cumulativeTargetedTransitionSuccessCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </details>
  );
}
