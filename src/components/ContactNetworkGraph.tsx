/**
 * Issue #216: standingParty専用の接触ネットワークグラフ。
 * #213の`buildStandingPartyContactNetwork`結果を表示するだけで、
 * simulation state / PRNG / 分析導出には影響しない。
 * afterParty / classroomPair では App 側で mount しない。
 */
import { useEffect, useMemo, useState } from "react";
import {
  buildStandingPartyContactNetwork,
  buildStandingPartyConversationHistory,
} from "../simulation/standingPartyAnalysis";
import type { ContactIntervalRecord, SimulationState } from "../simulation/types";
import { ContactNetworkControls } from "./ContactNetworkControls";
import { ContactNetworkDetail } from "./ContactNetworkDetail";
import {
  CONTACT_NETWORK_VIEW_HEIGHT,
  CONTACT_NETWORK_VIEW_WIDTH,
  contactIntervalsForEdge,
  DEFAULT_CONTACT_NETWORK_FILTER,
  findSelectedEdge,
  findSelectedInterval,
  findSelectedNode,
  projectContactNetwork,
  type ContactNetworkSelection,
  type ContactNetworkViewFilter,
} from "./contactNetworkProjection";

type Props = {
  state: SimulationState;
  selectedAgentId?: string;
  onSelectedAgentIdChange?: (agentId: string | undefined) => void;
  selectedClusterId?: string;
  onSelectedClusterIdChange?: (clusterId: string | undefined) => void;
  /** edge interval選択時にtimelineのtick範囲・clusterへ連携 */
  onTimelineFocus?: (focus: {
    agentId?: string;
    clusterId?: string;
    fromTick?: number;
    toTick?: number;
  }) => void;
};

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.4;
const ZOOM_STEP = 0.2;
const DEFAULT_ZOOM = 1;

export function ContactNetworkGraph({
  state,
  selectedAgentId,
  onSelectedAgentIdChange,
  selectedClusterId,
  onSelectedClusterIdChange,
  onTimelineFocus,
}: Props) {
  const [filter, setFilter] = useState<ContactNetworkViewFilter>({
    ...DEFAULT_CONTACT_NETWORK_FILTER,
    clusterId: selectedClusterId,
  });
  const [selection, setSelection] = useState<ContactNetworkSelection | undefined>(undefined);
  const [open, setOpen] = useState(true);
  const [graphVisible, setGraphVisible] = useState(true);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);

  useEffect(() => {
    setFilter((prev) =>
      prev.clusterId === selectedClusterId ? prev : { ...prev, clusterId: selectedClusterId },
    );
  }, [selectedClusterId]);

  useEffect(() => {
    setSelection(undefined);
    setFilter((prev) => ({
      ...prev,
      fromTick: 0,
      toTick: undefined,
      minDurationTicks: 1,
      minWeight: 0,
      activeOnly: false,
      egoNetwork: false,
      observerJoinerEdgesOnly: false,
    }));
    setZoom(DEFAULT_ZOOM);
  }, [state.seed, state.formationScenarioId]);

  // Canvas/Inspectorのagent選択をnode選択へ反映(表示同期のみ)
  useEffect(() => {
    if (!selectedAgentId) return;
    setSelection((prev) => {
      if (prev?.kind === "node" && prev.agentId === selectedAgentId) return prev;
      if (prev?.kind === "edge" || prev?.kind === "interval") return prev;
      return { kind: "node", agentId: selectedAgentId };
    });
  }, [selectedAgentId]);

  const history = useMemo(() => buildStandingPartyConversationHistory(state), [state]);

  const networkOptions = useMemo(
    () => ({
      history,
      fromTick: filter.fromTick ?? 0,
      toTick: filter.toTick ?? Math.max(history.asOfTick, (filter.fromTick ?? 0) + 1),
      includeActive: true,
      minDurationTicks: filter.minDurationTicks ?? 1,
    }),
    [history, filter.fromTick, filter.toTick, filter.minDurationTicks],
  );

  const network = useMemo(
    () => buildStandingPartyContactNetwork(state, networkOptions),
    [state, networkOptions],
  );

  const projection = useMemo(
    () => projectContactNetwork(state, network, filter, selectedAgentId),
    [state, network, filter, selectedAgentId],
  );

  const handleFilterChange = (next: ContactNetworkViewFilter) => {
    setFilter(next);
    if (next.clusterId !== selectedClusterId) {
      onSelectedClusterIdChange?.(next.clusterId);
    }
  };

  const selectNode = (agentId: string) => {
    setSelection({ kind: "node", agentId });
    onSelectedAgentIdChange?.(agentId);
  };

  const selectEdge = (edgeKey: string, agentIdA: string, agentIdB: string) => {
    setSelection({ kind: "edge", edgeKey });
    // pairのどちらでもよいが、未選択ならAを採用。既選択がpair内なら維持。
    if (selectedAgentId !== agentIdA && selectedAgentId !== agentIdB) {
      onSelectedAgentIdChange?.(agentIdA);
    }
  };

  const selectInterval = (interval: ContactIntervalRecord, edgeKey: string) => {
    setSelection({ kind: "interval", contactIntervalId: interval.contactIntervalId, edgeKey });
    onSelectedClusterIdChange?.(interval.clusterId);
  };

  const focusIntervalOnTimeline = (interval: ContactIntervalRecord) => {
    onSelectedAgentIdChange?.(interval.agentIdA);
    onSelectedClusterIdChange?.(interval.clusterId);
    onTimelineFocus?.({
      agentId: interval.agentIdA,
      clusterId: interval.clusterId,
      fromTick: interval.startedAtTick,
      toTick: interval.endedAtTick ?? network.asOfTick,
    });
  };

  // SSR(renderToStaticMarkup)では useEffect が走らないため、propsのagent選択を表示に即反映する
  const displaySelection: ContactNetworkSelection | undefined =
    selection ??
    (selectedAgentId ? { kind: "node", agentId: selectedAgentId } : undefined);

  const selectedNode = findSelectedNode(projection, displaySelection);
  const selectedEdge = findSelectedEdge(projection, displaySelection);
  const selectedInterval = findSelectedInterval(network, displaySelection);
  const intervalsForEdge = selectedEdge
    ? contactIntervalsForEdge(network, selectedEdge.edgeKey, filter.clusterId)
    : [];

  const zoomPercent = Math.round(zoom * 100);
  const viewWidth = CONTACT_NETWORK_VIEW_WIDTH;
  const viewHeight = CONTACT_NETWORK_VIEW_HEIGHT;

  return (
    <details
      className="panel contact-network"
      data-testid="contact-network"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="contact-network-summary">接触ネットワーク</summary>
      <p className="contact-network-note">
        #213の接触事実(同一clusterへの同時所属)を可視化します。表示・layout操作はシミュレーション本体・
        PRNG・分析結果に影響しません。接触は信頼や好意を意味しません。
      </p>

      <ContactNetworkControls
        filter={filter}
        onFilterChange={handleFilterChange}
        agents={state.agents}
        lifetimes={history.clusterLifetimes}
        asOfTick={history.asOfTick}
        selectedAgentId={selectedAgentId}
        zoomPercent={zoomPercent}
        onZoomIn={() => setZoom((z) => Math.min(MAX_ZOOM, +(z + ZOOM_STEP).toFixed(2)))}
        onZoomOut={() => setZoom((z) => Math.max(MIN_ZOOM, +(z - ZOOM_STEP).toFixed(2)))}
        onResetView={() => setZoom(DEFAULT_ZOOM)}
        onFitView={() => setZoom(DEFAULT_ZOOM)}
        graphVisible={graphVisible}
        onGraphVisibleChange={setGraphVisible}
      />

      <div className="contact-network-metrics" data-testid="contact-network-metrics">
        <span>nodes {projection.nodes.length}</span>
        <span>edges {projection.edges.length}</span>
        <span>snapshot density {network.metrics.density.toFixed(3)}</span>
        <span>isolated(snapshot) {network.metrics.isolatedNodeCount}</span>
      </div>

      {graphVisible ? (
        <div className="contact-network-body">
          <div
            className="contact-network-viewport"
            data-testid="contact-network-viewport"
          >
            <svg
              className="contact-network-svg"
              data-testid="contact-network-svg"
              viewBox={`0 0 ${viewWidth} ${viewHeight}`}
              width={viewWidth * zoom}
              height={viewHeight * zoom}
              role="img"
              aria-label="接触ネットワークグラフ"
            >
              <title>接触ネットワーク</title>
              {projection.edges.map((edge) => {
                const a = projection.nodes.find((n) => n.agentId === edge.agentIdA);
                const b = projection.nodes.find((n) => n.agentId === edge.agentIdB);
                if (!a || !b) return null;
                const selected =
                  (displaySelection?.kind === "edge" || displaySelection?.kind === "interval") &&
                  displaySelection.edgeKey === edge.edgeKey;
                return (
                  <g key={edge.edgeKey}>
                    <line
                      className={
                        "contact-network-edge" +
                        (edge.isActive ? " contact-network-edge--active" : " contact-network-edge--past") +
                        (selected ? " contact-network-edge--selected" : "")
                      }
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      strokeWidth={edge.strokeWidth}
                      strokeDasharray={edge.isActive ? undefined : "4 3"}
                      opacity={edge.isActive ? 0.95 : 0.45}
                      data-testid={`contact-network-edge-${edge.edgeKey}`}
                      data-active={edge.isActive ? "true" : "false"}
                      data-weight={edge.weight}
                    />
                    {/* 太いhit area(キーボード選択は下部の代替listを使う) */}
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="transparent"
                      strokeWidth={Math.max(10, edge.strokeWidth + 8)}
                      className="contact-network-edge-hit"
                      onClick={() => selectEdge(edge.edgeKey, edge.agentIdA, edge.agentIdB)}
                    >
                      <title>{`edge ${edge.edgeKey}: weight ${edge.weight}${edge.isActive ? ", 進行中" : ", 過去"}`}</title>
                    </line>
                  </g>
                );
              })}
              {projection.nodes.map((node) => {
                const selected = displaySelection?.kind === "node" && displaySelection.agentId === node.agentId;
                const sharedSelected = selectedAgentId === node.agentId;
                return (
                  <g
                    key={node.agentId}
                    transform={`translate(${node.x}, ${node.y})`}
                    data-testid={`contact-network-node-${node.agentId}`}
                    data-isolated={node.isolated ? "true" : "false"}
                    data-observer-joiner={node.isObserverJoiner ? "true" : "false"}
                  >
                    <circle
                      className={
                        "contact-network-node-circle" +
                        (node.isObserverJoiner ? " contact-network-node-circle--oj" : "") +
                        (node.isolated ? " contact-network-node-circle--isolated" : "") +
                        (selected || sharedSelected ? " contact-network-node-circle--selected" : "")
                      }
                      r={node.isObserverJoiner ? 9 : 7}
                      onClick={() => selectNode(node.agentId)}
                    >
                      <title>{`agent ${node.label} (${node.agentId})${node.isObserverJoiner ? ", ObserverJoiner" : ""}${node.isolated ? ", isolated" : ""}`}</title>
                    </circle>
                    {node.isObserverJoiner && (
                      <text
                        className="contact-network-node-oj-marker"
                        y={-12}
                        textAnchor="middle"
                        aria-hidden="true"
                      >
                        OJ
                      </text>
                    )}
                    <text
                      className="contact-network-node-label"
                      y={18}
                      textAnchor="middle"
                      aria-hidden="true"
                    >
                      {node.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          <div className="contact-network-lists" data-testid="contact-network-lists">
            <div className="contact-network-list-block">
              <h5 className="contact-network-list-title">node一覧</h5>
              <ul className="contact-network-list" role="listbox" aria-label="agent node一覧">
                {projection.nodeList.map((node) => {
                  const selected =
                    (displaySelection?.kind === "node" && displaySelection.agentId === node.agentId) ||
                    selectedAgentId === node.agentId;
                  return (
                    <li key={node.agentId}>
                      <button
                        type="button"
                        className={
                          "contact-network-list-btn" +
                          (selected ? " contact-network-list-btn--selected" : "")
                        }
                        data-testid={`contact-network-list-node-${node.agentId}`}
                        aria-selected={selected}
                        onClick={() => selectNode(node.agentId)}
                      >
                        {node.label} ({node.agentId}
                        {node.isObserverJoiner ? ", OJ" : ""}
                        {node.isolated ? ", isolated" : ""})
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="contact-network-list-block">
              <h5 className="contact-network-list-title">edge一覧</h5>
              <ul className="contact-network-list" role="listbox" aria-label="contact edge一覧">
                {projection.edgeList.map((edge) => {
                  const selected =
                    (displaySelection?.kind === "edge" || displaySelection?.kind === "interval") &&
                    displaySelection.edgeKey === edge.edgeKey;
                  return (
                    <li key={edge.edgeKey}>
                      <button
                        type="button"
                        className={
                          "contact-network-list-btn" +
                          (selected ? " contact-network-list-btn--selected" : "")
                        }
                        data-testid={`contact-network-list-edge-${edge.edgeKey}`}
                        aria-selected={selected}
                        onClick={() => selectEdge(edge.edgeKey, edge.agentIdA, edge.agentIdB)}
                      >
                        {edge.edgeKey} — w={edge.weight}
                        {edge.isActive ? " (active)" : " (past)"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      ) : (
        <div
          className="contact-network-hidden"
          data-testid="contact-network-hidden"
          role="status"
        >
          グラフ表示OFF（分析snapshot・simulation stateは変更していません）
        </div>
      )}

      <ContactNetworkDetail
        state={state}
        selection={displaySelection}
        node={selectedNode}
        edge={selectedEdge}
        interval={selectedInterval}
        intervalsForEdge={intervalsForEdge}
        projection={projection}
        onSelectInterval={selectInterval}
        onFocusIntervalOnTimeline={focusIntervalOnTimeline}
      />
    </details>
  );
}
