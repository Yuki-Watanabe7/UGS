/**
 * Issue #216: node / edge / contact interval の詳細 panel。
 * contactとclique / trust / relationshipTieは別セクションに分離し、
 * 接触が信頼や好意を示すと断定しない。
 */
import { speechTrustPairKey } from "../simulation/speechTrust";
import { correctionFromHistory, tiePairKey } from "../simulation/relationshipTie";
import type {
  ContactIntervalRecord,
  SimulationState,
} from "../simulation/types";
import { INTERVAL_STATUS_LABEL, formatTickRange } from "./conversationHistoryLabels";
import { WEIGHT_MODE_LABEL, WEIGHT_MODE_UNIT } from "./contactNetworkLabels";
import type {
  ContactNetworkProjection,
  ContactNetworkSelection,
  ProjectedContactNetworkEdge,
  ProjectedContactNetworkNode,
} from "./contactNetworkProjection";
import { strongestContactsForNode } from "./contactNetworkProjection";

type Props = {
  state: SimulationState;
  selection: ContactNetworkSelection | undefined;
  node?: ProjectedContactNetworkNode;
  edge?: ProjectedContactNetworkEdge;
  interval?: ContactIntervalRecord;
  intervalsForEdge?: readonly ContactIntervalRecord[];
  projection: ContactNetworkProjection;
  onSelectInterval?: (interval: ContactIntervalRecord, edgeKey: string) => void;
  onFocusIntervalOnTimeline?: (interval: ContactIntervalRecord) => void;
};

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="contact-network-detail-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function agentDisplay(state: SimulationState, agentId: string): string {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) return agentId;
  return `${agent.label} (${agentId}${agent.isObserverJoiner ? ", OJ" : ""})`;
}

function NodeDetail({
  node,
  projection,
  state,
}: {
  node: ProjectedContactNetworkNode;
  projection: ContactNetworkProjection;
  state: SimulationState;
}) {
  const strongest = strongestContactsForNode(projection, node.agentId, 5);
  const live = state.agents.find((a) => a.id === node.agentId);
  return (
    <div data-testid="contact-network-detail-node">
      <DetailRow label="種別" value="agent node" />
      <DetailRow label="label" value={node.label} />
      <DetailRow label="agentId" value={node.agentId} />
      <DetailRow
        label="ObserverJoiner"
        value={node.isObserverJoiner ? "はい (OJ marker)" : "いいえ"}
      />
      <DetailRow label="接触人数 (degree)" value={String(node.degree)} />
      <DetailRow label="同席tick合計 (weightedDegree)" value={`${node.weightedDegree} tick`} />
      <DetailRow label="進行中の接触数" value={String(node.activeContactCount)} />
      <DetailRow label="episode数" value={String(node.episodeCount)} />
      <DetailRow
        label="現在のcluster"
        value={node.currentClusterId ?? "なし"}
      />
      <DetailRow
        label="現在のstate"
        value={live?.state ?? node.currentState}
      />
      <DetailRow
        label="isolated (表示上)"
        value={node.isolated ? "接触0 (このfilterでは辺なし)" : "接触あり"}
      />

      <h5 className="contact-network-detail-subtitle">
        最強接触上位（定義: {WEIGHT_MODE_LABEL[projection.weightMode]} 降順）
      </h5>
      {strongest.length === 0 ? (
        <p className="contact-network-detail-empty-list">表示中の接触相手はいません。</p>
      ) : (
        <ol className="contact-network-strongest" data-testid="contact-network-strongest">
          {strongest.map(({ edge, otherAgentId }) => (
            <li key={edge.edgeKey}>
              {agentDisplay(state, otherAgentId)} — {edge.weight}{" "}
              {WEIGHT_MODE_UNIT[projection.weightMode]}
            </li>
          ))}
        </ol>
      )}

      {node.comparisonAttributes?.cliqueId !== undefined && (
        <section
          className="contact-network-comparison"
          data-testid="contact-network-node-comparison"
        >
          <h5 className="contact-network-detail-subtitle">比較用属性（接触とは別軸）</h5>
          <DetailRow label="cliqueId" value={String(node.comparisonAttributes.cliqueId)} />
          <p className="contact-network-disclaimer">
            cliqueは事前の友人関係カテゴリです。接触の有無やweightとは同一視しません。
          </p>
        </section>
      )}
    </div>
  );
}

function EdgeComparisonSection({
  state,
  edge,
}: {
  state: SimulationState;
  edge: ProjectedContactNetworkEdge;
}) {
  const agentA = state.agents.find((a) => a.id === edge.agentIdA);
  const agentB = state.agents.find((a) => a.id === edge.agentIdB);
  const sameClique =
    agentA?.cliqueId !== undefined &&
    agentB?.cliqueId !== undefined &&
    agentA.cliqueId === agentB.cliqueId;

  const trustAB = state.speechTrust?.[speechTrustPairKey(edge.agentIdA, edge.agentIdB)];
  const trustBA = state.speechTrust?.[speechTrustPairKey(edge.agentIdB, edge.agentIdA)];
  const histAB = state.tieHistory?.[tiePairKey(edge.agentIdA, edge.agentIdB)];
  const histBA = state.tieHistory?.[tiePairKey(edge.agentIdB, edge.agentIdA)];
  const tieAB = histAB && histAB.length > 0 ? correctionFromHistory(histAB) : undefined;
  const tieBA = histBA && histBA.length > 0 ? correctionFromHistory(histBA) : undefined;

  return (
    <section
      className="contact-network-comparison"
      data-testid="contact-network-edge-comparison"
    >
      <h5 className="contact-network-detail-subtitle">比較用属性（接触とは別軸）</h5>
      <DetailRow
        label="clique一致"
        value={
          agentA?.cliqueId === undefined && agentB?.cliqueId === undefined
            ? "両方未所属"
            : sameClique
              ? `一致 (clique ${agentA?.cliqueId})`
              : `不一致 (A=${agentA?.cliqueId ?? "なし"}, B=${agentB?.cliqueId ?? "なし"})`
        }
      />
      <DetailRow
        label={`trust ${edge.agentIdA}→${edge.agentIdB}`}
        value={trustAB === undefined ? "未記録(動的更新なし)" : String(trustAB)}
      />
      <DetailRow
        label={`trust ${edge.agentIdB}→${edge.agentIdA}`}
        value={trustBA === undefined ? "未記録(動的更新なし)" : String(trustBA)}
      />
      <DetailRow
        label={`relationshipTie補正 ${edge.agentIdA}→${edge.agentIdB}`}
        value={tieAB === undefined ? "未記録" : String(tieAB)}
      />
      <DetailRow
        label={`relationshipTie補正 ${edge.agentIdB}→${edge.agentIdA}`}
        value={tieBA === undefined ? "未記録" : String(tieBA)}
      />
      <p className="contact-network-disclaimer" data-testid="contact-network-disclaimer">
        接触(同席)は信頼・好意・関係の強さを意味しません。clique / trust / relationshipTieは
        別レイヤの観測であり、edge weightには混ざっていません。
      </p>
    </section>
  );
}

function EdgeDetail({
  edge,
  intervals,
  projection,
  state,
  selectedIntervalId,
  onSelectInterval,
  onFocusIntervalOnTimeline,
}: {
  edge: ProjectedContactNetworkEdge;
  intervals: readonly ContactIntervalRecord[];
  projection: ContactNetworkProjection;
  state: SimulationState;
  selectedIntervalId?: string;
  onSelectInterval?: (interval: ContactIntervalRecord, edgeKey: string) => void;
  onFocusIntervalOnTimeline?: (interval: ContactIntervalRecord) => void;
}) {
  return (
    <div data-testid="contact-network-detail-edge">
      <DetailRow label="種別" value="contact edge" />
      <DetailRow label="edgeKey" value={edge.edgeKey} />
      <DetailRow label="agent pair" value={`${agentDisplay(state, edge.agentIdA)} — ${agentDisplay(state, edge.agentIdB)}`} />
      <DetailRow label="同席tick合計" value={`${edge.totalCoPresenceTicks} tick`} />
      <DetailRow label="接触区間数" value={`${edge.contactIntervalCount} 回`} />
      <DetailRow label="異なるcluster数" value={String(edge.distinctClusterCount)} />
      <DetailRow
        label="表示weight"
        value={`${edge.weight} ${WEIGHT_MODE_UNIT[projection.weightMode]} (${WEIGHT_MODE_LABEL[projection.weightMode]})`}
      />
      <DetailRow label="初回接触tick" value={`t=${edge.firstContactTick}`} />
      <DetailRow label="最終接触tick" value={`t=${edge.lastContactTick}`} />
      <DetailRow
        label="進行中の接触"
        value={edge.isActive ? "あり (active)" : "なし (pastのみ)"}
      />

      <h5 className="contact-network-detail-subtitle">contact interval一覧</h5>
      {intervals.length === 0 ? (
        <p className="contact-network-detail-empty-list">区間がありません。</p>
      ) : (
        <ul className="contact-network-intervals" data-testid="contact-network-intervals">
          {intervals.map((interval) => {
            const selected = selectedIntervalId === interval.contactIntervalId;
            return (
              <li key={interval.contactIntervalId}>
                <button
                  type="button"
                  className={
                    "contact-network-interval-btn" +
                    (selected ? " contact-network-interval-btn--selected" : "")
                  }
                  data-testid={`contact-network-interval-${interval.contactIntervalId}`}
                  aria-pressed={selected}
                  onClick={() => onSelectInterval?.(interval, edge.edgeKey)}
                >
                  {interval.clusterId}:{" "}
                  {formatTickRange(interval.startedAtTick, interval.endedAtTick, interval.status)}{" "}
                  ({interval.dwellTicks} tick, {INTERVAL_STATUS_LABEL[interval.status]})
                </button>
                {onFocusIntervalOnTimeline && (
                  <button
                    type="button"
                    className="contact-network-interval-timeline-btn"
                    data-testid={`contact-network-interval-timeline-${interval.contactIntervalId}`}
                    onClick={() => onFocusIntervalOnTimeline(interval)}
                  >
                    timelineへ
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <EdgeComparisonSection state={state} edge={edge} />
    </div>
  );
}

function IntervalDetail({
  interval,
  state,
  onFocusIntervalOnTimeline,
}: {
  interval: ContactIntervalRecord;
  state: SimulationState;
  onFocusIntervalOnTimeline?: (interval: ContactIntervalRecord) => void;
}) {
  return (
    <div data-testid="contact-network-detail-interval">
      <DetailRow label="種別" value="contact interval" />
      <DetailRow label="contactIntervalId" value={interval.contactIntervalId} />
      <DetailRow
        label="agent pair"
        value={`${agentDisplay(state, interval.agentIdA)} — ${agentDisplay(state, interval.agentIdB)}`}
      />
      <DetailRow label="clusterId" value={interval.clusterId} />
      <DetailRow
        label="区間"
        value={formatTickRange(interval.startedAtTick, interval.endedAtTick, interval.status)}
      />
      <DetailRow label="duration" value={`${interval.dwellTicks} tick`} />
      <DetailRow label="状態" value={INTERVAL_STATUS_LABEL[interval.status]} />
      {onFocusIntervalOnTimeline && (
        <button
          type="button"
          className="contact-network-interval-timeline-btn"
          data-testid="contact-network-interval-focus-timeline"
          onClick={() => onFocusIntervalOnTimeline(interval)}
        >
          この区間をtimelineのtick範囲・clusterへ反映
        </button>
      )}
      <p className="contact-network-disclaimer">
        接触は同一clusterへの同時所属の事実です。好意や信頼を意味しません。
      </p>
    </div>
  );
}

export function ContactNetworkDetail({
  state,
  selection,
  node,
  edge,
  interval,
  intervalsForEdge = [],
  projection,
  onSelectInterval,
  onFocusIntervalOnTimeline,
}: Props) {
  if (!selection) {
    return (
      <div
        className="contact-network-detail contact-network-detail--empty"
        data-testid="contact-network-detail-empty"
      >
        node または edge を選択すると、接触人数・同席tick・interval一覧を表示します。
        layout操作は simulation の座標を変更しません。
      </div>
    );
  }

  return (
    <div
      className="contact-network-detail"
      data-testid="contact-network-detail"
      aria-live="polite"
    >
      <h4 className="contact-network-detail-title">詳細</h4>
      {selection.kind === "node" && node && (
        <NodeDetail node={node} projection={projection} state={state} />
      )}
      {selection.kind === "edge" && edge && (
        <EdgeDetail
          edge={edge}
          intervals={intervalsForEdge}
          projection={projection}
          state={state}
          onSelectInterval={onSelectInterval}
          onFocusIntervalOnTimeline={onFocusIntervalOnTimeline}
        />
      )}
      {selection.kind === "interval" && interval && (
        <IntervalDetail
          interval={interval}
          state={state}
          onFocusIntervalOnTimeline={onFocusIntervalOnTimeline}
        />
      )}
      {selection.kind === "interval" && edge && (
        <EdgeComparisonSection state={state} edge={edge} />
      )}
      {selection.kind === "node" && !node && (
        <p className="contact-network-detail-missing">選択したnodeは現在の表示にありません。</p>
      )}
      {(selection.kind === "edge" || selection.kind === "interval") && !edge && selection.kind === "edge" && (
        <p className="contact-network-detail-missing">選択したedgeは現在の表示にありません。</p>
      )}
      {selection.kind === "interval" && !interval && (
        <p className="contact-network-detail-missing">選択したintervalは現在の履歴にありません。</p>
      )}
    </div>
  );
}
