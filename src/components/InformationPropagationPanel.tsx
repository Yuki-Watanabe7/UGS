/** Phase 5 (#234) の read-only 可視化。 */
import { useEffect, useMemo, useState } from "react";
import {
  buildInformationPropagationAnalysis,
  type InformationAnalysisFilter,
  type InformationPropagationEdge,
} from "../simulation/informationAnalysis";
import { buildStandingPartyContactNetwork } from "../simulation/standingPartyAnalysis";
import type { InformationPropagationConfig } from "../simulation/informationState";
import type { SimulationState } from "../simulation/types";

type Props = {
  state: SimulationState;
  config: InformationPropagationConfig;
  selectedAgentId?: string;
  onSelectedAgentIdChange?: (agentId: string | undefined) => void;
  onSelectedClusterIdChange?: (clusterId: string | undefined) => void;
  onTimelineFocus?: (focus: { agentId?: string; clusterId?: string; fromTick?: number; toTick?: number }) => void;
};

type Tab = "inspector" | "network" | "lineage" | "timeline" | "statistics";
const PAGE_SIZE = 80;
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "inspector", label: "状態・Inspector" },
  { id: "network", label: "伝播network" },
  { id: "lineage", label: "Claim lineage" },
  { id: "timeline", label: "timeline" },
  { id: "statistics", label: "記述統計" },
];

function percentage(value: { numerator: number; denominator: number; rate?: number }): string {
  return value.rate === undefined
    ? `${value.numerator}/${value.denominator}（分母0のため非該当）`
    : `${value.numerator}/${value.denominator}（${(value.rate * 100).toFixed(1)}%）`;
}

function labelForAgent(state: SimulationState, agentId: string): string {
  const agent = state.agents.find((item) => item.id === agentId);
  return agent ? `${agent.label} (${agent.id})` : agentId;
}

function edgeClass(edge: InformationPropagationEdge): string {
  return `information-propagation-edge information-propagation-edge--${edge.kind}`;
}

export function InformationPropagationPanel({
  state,
  config,
  selectedAgentId,
  onSelectedAgentIdChange,
  onSelectedClusterIdChange,
  onTimelineFocus,
}: Props) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("inspector");
  const [filter, setFilter] = useState<InformationAnalysisFilter>({ fromTick: 0, observerJoinerMode: "all" });
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [showContactBackground, setShowContactBackground] = useState(true);
  const [timelinePage, setTimelinePage] = useState(0);

  useEffect(() => {
    setFilter({ fromTick: 0, observerJoinerMode: "all" });
    setSelectedEdgeId(undefined);
    setTimelinePage(0);
  }, [state.seed, state.formationScenarioId]);

  useEffect(() => setTimelinePage(0), [filter]);

  const analysis = useMemo(
    () => buildInformationPropagationAnalysis(state, { config, filter }),
    [state, config, filter],
  );
  const contactNetwork = useMemo(() => buildStandingPartyContactNetwork(state), [state]);
  const selectedSnapshot = analysis.agentSnapshots.find((snapshot) => snapshot.agentId === selectedAgentId) ?? analysis.agentSnapshots[0];
  const selectedEdge = analysis.propagationEdges.find((edge) => edge.edgeId === selectedEdgeId);
  const pageCount = Math.max(1, Math.ceil(analysis.timeline.length / PAGE_SIZE));
  const timelineEntries = analysis.timeline.slice(timelinePage * PAGE_SIZE, (timelinePage + 1) * PAGE_SIZE);
  const nodeIds = useMemo(
    () => Array.from(new Set([...state.agents.map((agent) => agent.id), ...analysis.propagationEdges.flatMap((edge) => [edge.speakerId, edge.receiverId])])).sort(),
    [state.agents, analysis.propagationEdges],
  );
  const nodePositions = useMemo(() => {
    const radius = 94;
    const cx = 150;
    const cy = 126;
    return new Map(nodeIds.map((id, index) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, nodeIds.length);
      return [id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }];
    }));
  }, [nodeIds]);

  const patch = (partial: Partial<InformationAnalysisFilter>) => setFilter((previous) => ({ ...previous, ...partial }));
  const selectEdge = (edge: InformationPropagationEdge) => {
    setSelectedEdgeId(edge.edgeId);
    onSelectedAgentIdChange?.(edge.receiverId);
    onSelectedClusterIdChange?.(edge.clusterId);
  };

  return (
    <details className="panel information-propagation" data-testid="information-propagation" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary className="information-propagation-summary">情報伝播の観察・分析 (Phase 5)</summary>
      <p className="information-propagation-note">
        内容発話・受信・採用・記憶・再伝達の構造化記録を読むだけの表示です。接触networkの線は「同席」、このpanelの矢印は実際の内容伝達であり、意味を混同しません。confidence／trustはシミュレーション内部値で、正しさや人物評価を示しません。
      </p>

      {!config.enabled ? (
        <p className="information-propagation-empty" data-testid="information-propagation-disabled">このrunではPhase 5が無効です。情報状態・伝播eventは生成されていません。</p>
      ) : (
        <>
          <div className="information-propagation-filters" data-testid="information-propagation-filters" role="group" aria-label="情報伝播の共通filter">
            <label>topic
              <select value={filter.topicIds?.[0] ?? ""} onChange={(event) => patch({ topicIds: event.target.value ? [event.target.value] : undefined })}>
                <option value="">すべて</option>
                {analysis.topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.id}</option>)}
              </select>
            </label>
            <label>claim
              <select value={filter.claimIds?.[0] ?? ""} onChange={(event) => patch({ claimIds: event.target.value ? [event.target.value] : undefined })}>
                <option value="">すべて</option>
                {analysis.claims.map((claim) => <option key={claim.id} value={claim.id}>{claim.id}</option>)}
              </select>
            </label>
            <label>variant
              <select value={filter.variantIds?.[0] ?? ""} onChange={(event) => patch({ variantIds: event.target.value ? [event.target.value] : undefined })}>
                <option value="">すべて</option>
                {analysis.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.id}</option>)}
              </select>
            </label>
            <label>agent
              <select value={filter.agentIds?.[0] ?? ""} onChange={(event) => patch({ agentIds: event.target.value ? [event.target.value] : undefined })}>
                <option value="">すべて</option>
                {state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}{agent.isObserverJoiner ? " (OJ)" : ""}</option>)}
              </select>
            </label>
            <label>source
              <select value={filter.sourceAgentIds?.[0] ?? ""} onChange={(event) => patch({ sourceAgentIds: event.target.value ? [event.target.value] : undefined })}>
                <option value="">すべて</option>
                {state.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
              </select>
            </label>
            <label>cluster
              <select value={filter.clusterIds?.[0] ?? ""} onChange={(event) => { const clusterId = event.target.value || undefined; patch({ clusterIds: clusterId ? [clusterId] : undefined }); onSelectedClusterIdChange?.(clusterId); }}>
                <option value="">すべて</option>
                {analysis.clusterSnapshots.map((cluster) => <option key={cluster.clusterId} value={cluster.clusterId}>{cluster.clusterId}</option>)}
              </select>
            </label>
            <label>結果
              <select value={filter.results?.[0] ?? ""} onChange={(event) => patch({ results: event.target.value ? [event.target.value as NonNullable<InformationAnalysisFilter["results"]>[number]] : undefined })}>
                <option value="">すべて</option>
                <option value="heardNotUnderstood">heard / not understood</option>
                <option value="adopted">adopted</option>
                <option value="rejected">rejected</option>
                <option value="uncertain">uncertain</option>
                <option value="alreadyKnown">already known</option>
                <option value="notHeard">not heard</option>
              </select>
            </label>
            <label>再伝達
              <select value={filter.retellingResults?.[0] ?? ""} onChange={(event) => patch({ retellingResults: event.target.value ? [event.target.value as NonNullable<InformationAnalysisFilter["retellingResults"]>[number]] : undefined })}>
                <option value="">すべて</option>
                <option value="faithful">faithful</option>
                <option value="mutated">mutated</option>
                <option value="variantReused">variant reused</option>
                <option value="blockedByLimit">blocked by limit</option>
              </select>
            </label>
            <label>tick
              <input type="number" min={0} max={analysis.asOfTick} value={filter.fromTick ?? 0} onChange={(event) => patch({ fromTick: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} />
              〜
              <input type="number" min={0} max={analysis.asOfTick} value={filter.toTick ?? analysis.asOfTick} onChange={(event) => patch({ toTick: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} />
            </label>
            <label>min confidence <input type="number" min={0} max={1} step={0.05} value={filter.minConfidence ?? ""} onChange={(event) => patch({ minConfidence: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
            <label>min memory <input type="number" min={0} max={1} step={0.05} value={filter.minMemoryStrength ?? ""} onChange={(event) => patch({ minMemoryStrength: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>
            <label>ObserverJoiner
              <select value={filter.observerJoinerMode ?? "all"} onChange={(event) => patch({ observerJoinerMode: event.target.value as InformationAnalysisFilter["observerJoinerMode"] })}>
                <option value="all">全員</option><option value="only">OJのみ</option><option value="exclude">OJ除外</option>
              </select>
            </label>
          </div>

          <div className="information-propagation-tabs" role="tablist" aria-label="情報伝播の表示">
            {TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "is-active" : undefined} onClick={() => setTab(item.id)}>{item.label}</button>)}
          </div>

          {tab === "inspector" && (
            <section data-testid="information-propagation-inspector">
              <div className="information-inspector-picker"><label>表示するagent <select value={selectedSnapshot?.agentId ?? ""} onChange={(event) => onSelectedAgentIdChange?.(event.target.value || undefined)}>{analysis.agentSnapshots.map((snapshot) => <option key={snapshot.agentId} value={snapshot.agentId}>{snapshot.label} ({snapshot.agentId})</option>)}</select></label></div>
              {selectedSnapshot ? <>
                <h3>{selectedSnapshot.label} の情報状態</h3>
                <p>満足度へのtopic寄与: {selectedSnapshot.satisfactionTopicContribution === undefined ? "今回のstateには記録なし" : selectedSnapshot.satisfactionTopicContribution.toFixed(3)} / 移動へのtopic寄与: {selectedSnapshot.transitionTopicContribution === undefined ? "今回のstateには記録なし" : selectedSnapshot.transitionTopicContribution.toFixed(3)}</p>
                <table className="information-table"><thead><tr><th>claim</th><th>状態</th><th>confidence / memory</th><th>variant</th><th>first / last heard</th><th>source traces</th><th>retell</th></tr></thead><tbody>
                  {analysis.claims.map((claim) => {
                    const current = selectedSnapshot.claims.find((item) => item.claimId === claim.id);
                    if (!current) return <tr key={claim.id}><td>{claim.id}</td><td colSpan={6}>未接触（状態recordなし）</td></tr>;
                    return <tr key={claim.id}><td>{claim.id}</td><td>{current.awareness} / {current.acceptance}</td><td>{current.confidence.toFixed(2)} / {current.memoryStrength.toFixed(2)}</td><td>{current.activeVariantId ?? "該当なし"}</td><td>{current.firstHeardTick ?? "未聴取"} / {current.lastHeardTick ?? "未聴取"}</td><td>{current.sourceTraces.length === 0 ? "source traceなし" : current.sourceTraces.map((trace) => `${trace.kind}:${trace.immediateSpeakerId ?? trace.originalSourceId ?? "不明"}`).join("、")}</td><td>{current.retellingCount} / {current.lastRetoldTick ?? "なし"}</td></tr>;
                  })}
                </tbody></table>
                <h4>聞いたが採用しなかった記録</h4>
                {selectedSnapshot.notAdoptedTransmissions.length === 0 ? <p>該当なし（未接触とは区別しています）。</p> : <ul>{selectedSnapshot.notAdoptedTransmissions.map((record) => <li key={record.id}>t={record.tick}: {record.claimId} を {labelForAgent(state, record.speakerId)} から聞き、{record.result}</li>)}</ul>}
              </> : <p>選択条件に合うagent情報はありません。</p>}
              <h3>現在のcluster topic</h3>
              <table className="information-table"><thead><tr><th>cluster</th><th>current topic</th><th>最近のtopic</th><th>member knowledge summary</th></tr></thead><tbody>{analysis.clusterSnapshots.map((cluster) => <tr key={cluster.clusterId}><td><button type="button" onClick={() => onSelectedClusterIdChange?.(cluster.clusterId)}>{cluster.clusterId}</button></td><td>{cluster.currentTopicId ?? "topic未設定"}{cluster.changedAtCurrentTick ? "（今tickに変更）" : ""}</td><td>{cluster.recentTopicIds.join(" → ") || "記録なし"}</td><td>{cluster.knowledgeSummary.length === 0 ? "情報状態なし" : cluster.knowledgeSummary.map((item) => `${item.topicId}: aware ${item.awareCount}, adopted ${item.adoptedCount}, remembered ${item.rememberedCount}`).join(" / ")}</td></tr>)}</tbody></table>
            </section>
          )}

          {tab === "network" && (
            <section data-testid="information-propagation-network">
              <p>背景の灰線は同席による接触、色と線種のある矢印は内容発話を実際に聞いた・採用した・採用しなかった伝播です。接触だけでは矢印を表示しません。</p>
              <label className="information-contact-toggle"><input type="checkbox" checked={showContactBackground} onChange={(event) => setShowContactBackground(event.target.checked)} /> 接触edgeを背景に表示</label>
              <div className="information-network-layout">
                <svg className="information-network-svg" viewBox="0 0 300 252" role="img" aria-label="情報伝播network。矢印は実際の情報伝播、灰線は接触を表す">
                  <defs><marker id="information-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" /></marker></defs>
                  {showContactBackground && contactNetwork.edges.map((edge) => { const a = nodePositions.get(edge.agentIdA); const b = nodePositions.get(edge.agentIdB); return a && b ? <line key={edge.edgeKey} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="information-contact-edge" /> : null; })}
                  {analysis.propagationEdges.map((edge) => { const a = nodePositions.get(edge.speakerId); const b = nodePositions.get(edge.receiverId); return a && b ? <line key={edge.edgeId} x1={a.x} y1={a.y} x2={b.x} y2={b.y} markerEnd="url(#information-arrow)" className={`${edgeClass(edge)}${selectedEdge?.edgeId === edge.edgeId ? " is-selected" : ""}`} onClick={() => selectEdge(edge)} tabIndex={0} role="button" aria-label={`${edge.speakerId}から${edge.receiverId}へ ${edge.result}`} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") selectEdge(edge); }} /> : null; })}
                  {nodeIds.map((id) => { const pos = nodePositions.get(id)!; const agent = state.agents.find((item) => item.id === id); return <g key={id} onClick={() => onSelectedAgentIdChange?.(id)} className="information-network-node" tabIndex={0} role="button" aria-label={`${agent?.label ?? id}を選択`}><circle cx={pos.x} cy={pos.y} r="12" /><text x={pos.x} y={pos.y + 26}>{agent?.label ?? id}</text></g>; })}
                </svg>
                <div>{selectedEdge ? <><h4>選択した伝播</h4><dl className="information-edge-detail"><div><dt>source → receiver</dt><dd>{labelForAgent(state, selectedEdge.speakerId)} → {labelForAgent(state, selectedEdge.receiverId)}</dd></div><div><dt>結果</dt><dd>{selectedEdge.result}</dd></div><div><dt>claim / variant</dt><dd>{selectedEdge.claimId} / {selectedEdge.variantId}</dd></div><div><dt>confidence delta</dt><dd>{selectedEdge.confidenceDelta ?? "該当なし"}</dd></div><div><dt>因果ID</dt><dd>{selectedEdge.contentUtteranceId} → {selectedEdge.informationReceptionEventId} → {selectedEdge.adoptionEventId ?? "adoptionなし"}</dd></div></dl><button type="button" onClick={() => onTimelineFocus?.({ agentId: selectedEdge.receiverId, clusterId: selectedEdge.clusterId, fromTick: selectedEdge.tick, toTick: selectedEdge.tick + 1 })}>timelineで確認</button></> : <p>矢印またはtableの行を選ぶと、発話・受信・採用のID連鎖を表示します。</p>}</div>
              </div>
              <table className="information-table"><thead><tr><th>tick</th><th>source → receiver</th><th>claim / variant</th><th>結果</th><th>再伝達</th></tr></thead><tbody>{analysis.propagationEdges.map((edge) => <tr key={edge.edgeId} onClick={() => selectEdge(edge)}><td>{edge.tick}</td><td>{edge.speakerId} → {edge.receiverId}</td><td>{edge.claimId} / {edge.variantId}</td><td>{edge.result}</td><td>{edge.retellingResult ?? "なし"}</td></tr>)}</tbody></table>
            </section>
          )}

          {tab === "lineage" && <section data-testid="information-propagation-lineage"><p>variantはcanonical claimからの構造化された変容です。semantic distanceやuncertainを、虚偽・誤情報と断定しません。</p><table className="information-table"><thead><tr><th>variant</th><th>parent</th><th>depth / hop / distance</th><th>生成</th><th>mutation factor</th><th>子variant / retelling</th></tr></thead><tbody>{analysis.lineage.map((row) => <tr key={row.variantId}><td style={{ paddingLeft: `${8 + row.lineageDepth * 16}px` }}>{row.variantId}</td><td>{row.parentVariantId ?? "canonical root"}</td><td>{row.lineageDepth} / {row.hopDistance} / {row.canonicalDistance}</td><td>t={row.generatedAtTick} / {row.generatorAgentId ?? "initial catalog"}</td><td>{row.mutationFactors.length === 0 ? "なし" : row.mutationFactors.map((factor) => `${factor.kind} (${factor.direction})`).join("、")}</td><td>{row.childVariantIds.join("、") || "なし"} / {row.retellingEventIds.length}</td></tr>)}</tbody></table></section>}

          {tab === "timeline" && <section data-testid="information-propagation-timeline"><p>eventはページング表示（1ページ {PAGE_SIZE} 件）です。filter後の全件はJSON/CSV exportにも含まれます。</p><div className="information-pagination"><button type="button" disabled={timelinePage === 0} onClick={() => setTimelinePage((page) => page - 1)}>前</button><span>{timelinePage + 1} / {pageCount}</span><button type="button" disabled={timelinePage >= pageCount - 1} onClick={() => setTimelinePage((page) => page + 1)}>次</button></div><table className="information-table"><thead><tr><th>tick</th><th>種別</th><th>claim / variant</th><th>source → receiver</th><th>結果</th><th>ID連鎖</th></tr></thead><tbody>{timelineEntries.map((entry) => <tr key={`${entry.kind}:${entry.id}`}><td>{entry.tick}</td><td>{entry.kind}</td><td>{entry.claimId} / {entry.variantId ?? "該当なし"}</td><td>{entry.speakerId ?? ""}{entry.speakerId && entry.receiverId ? " → " : ""}{entry.receiverId ?? ""}</td><td>{entry.result ?? ""}</td><td>{entry.id}{entry.relatedIds.length > 0 ? ` → ${entry.relatedIds.join(" → ")}` : ""}</td></tr>)}</tbody></table></section>}

          {tab === "statistics" && <section data-testid="information-propagation-statistics"><h3>伝播率</h3><dl className="information-stat-grid"><div><dt>utterance → heard</dt><dd>{percentage(analysis.statistics.utteranceToHeard)}</dd></div><div><dt>heard → adopt</dt><dd>{percentage(analysis.statistics.heardToAdopt)}</dd></div><div><dt>adopt → retell</dt><dd>{percentage(analysis.statistics.adoptToRetell)}</dd></div><div><dt>source diversity</dt><dd>{percentage(analysis.statistics.sourceDiversity)}</dd></div><div><dt>cluster間をまたぐ再受信</dt><dd>{analysis.statistics.crossClusterTransmissionCount}</dd></div></dl><h3>topic / claim の現在分布と到達時刻</h3><table className="information-table"><thead><tr><th>topic / claim</th><th>aware / adopted / remembered</th><th>first spread</th><th>time to N agents</th><th>unique speaker / receiver</th></tr></thead><tbody>{analysis.statistics.claims.map((stat) => <tr key={stat.claimId}><td>{stat.topicId} / {stat.claimId}</td><td>{stat.awareCount} / {stat.adoptedCount} / {stat.rememberedCount}</td><td>{stat.firstSpreadTick ?? "未到達"}</td><td>{stat.timeToAgentCounts.map((point) => `${point.agentCount}:${point.tick ?? "未到達"}`).join("、") || "未到達"}</td><td>{stat.uniqueSpeakerCount} / {stat.uniqueReceiverCount}</td></tr>)}</tbody></table><h3>variant / retelling</h3><p>faithful: {analysis.statistics.retellingResultCounts.faithful} / mutated: {analysis.statistics.retellingResultCounts.mutated} / reused: {analysis.statistics.retellingResultCounts.variantReused} / blocked: {analysis.statistics.retellingResultCounts.blockedByLimit}</p><p>source hop: {Object.entries(analysis.statistics.sourceHopDistribution).map(([key, value]) => `${key}=${value}`).join("、") || "該当なし"}</p><p>lineage depth: {Object.entries(analysis.statistics.lineageDepthDistribution).map(([key, value]) => `${key}=${value}`).join("、") || "該当なし"}</p><p>OJ（{analysis.statistics.observerJoiner.agentIds.join("、") || "なし"}）: received {analysis.statistics.observerJoiner.receivedCount} / adopted {analysis.statistics.observerJoiner.adoptedCount} / retelling {analysis.statistics.observerJoiner.retellingCount}</p></section>}
        </>
      )}
    </details>
  );
}
