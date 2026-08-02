/**
 * Issue #213 (standing-party Phase 4 分析): membership区間の時間重複から接触ネットワークを
 * 決定的に導出する read model。`docs/standing-party-analysis-phase4-model.md` §1.5 / §3 / §5 / §7 準拠。
 *
 * - contact = 同一clusterへの同時`joined`所属のみ(接近・空間近接・clique・trust・tieは非接触)
 * - pairはID昇順で正規化し、A-B / B-Aを別edgeにしない
 * - RNG非消費・入力非mutation・入力順序非依存
 * - 表示層の再renderでsimulationを変えない(pure導出のみ)
 *
 * 会話履歴の構築は`standingPartyAnalysis.ts`側。本モジュールは履歴→networkのみを担い、
 * 相互importによる循環依存を避ける。便利関数`buildStandingPartyContactNetwork`は
 * `standingPartyAnalysis.ts`から再エクスポートする。
 */
import type {
  AnalysisIntervalStatus,
  ClusterMembershipInterval,
  ContactIntervalRecord,
  ContactNetworkEdge,
  ContactNetworkMetrics,
  ContactNetworkNode,
  SimulationState,
  StandingPartyAnalysisDiagnostic,
  StandingPartyContactNetwork,
  StandingPartyConversationHistory,
} from "./types";
import { STANDING_PARTY_ANALYSIS_SCHEMA_VERSION } from "./types";

export type BuildContactNetworkFromHistoryOptions = {
  /**
   * 未完了区間の長さ・censored判定に使う観測時点。省略時は`history.asOfTick`。
   * 半開区間`[start, end)`の`end`未定義時のdwellは`asOfTick - start`。
   */
  asOfTick?: number;
  /** 時間窓の開始(含む)。省略時は0 */
  fromTick?: number;
  /** 時間窓の終了(含まない)。省略時は`asOfTick` */
  toTick?: number;
  /** falseのとき完了intervalのみ(active/censoredを除外)。default true */
  includeActive?: boolean;
  /** この長さ未満の(clip後)intervalを除外。default 1(= duration 0を除外) */
  minDurationTicks?: number;
  /** 指定時、両端が集合内のedge/intervalと集合内nodeのみを残す */
  agentIds?: ReadonlySet<string> | readonly string[];
};

/** memoization用。state参照が変わったときだけ再計算する想定(ADR §5.2 / §7.2) */
type ContactNetworkCacheEntry = {
  key: string;
  network: StandingPartyContactNetwork;
};

const contactNetworkMemo = new WeakMap<SimulationState, ContactNetworkCacheEntry>();

/** `` `${minId}:${maxId}:${clusterId}:${startTick}` `` (ADR §1.5 / §6.1) */
export function createContactIntervalId(
  agentIdA: string,
  agentIdB: string,
  clusterId: string,
  startedAtTick: number,
): string {
  const [a, b] = agentIdA <= agentIdB ? [agentIdA, agentIdB] : [agentIdB, agentIdA];
  return `${a}:${b}:${clusterId}:${startedAtTick}`;
}

/** `` `${minId}:${maxId}` `` (ADR §3.1 / §6.1) */
export function createContactNetworkEdgeKey(agentIdA: string, agentIdB: string): string {
  return agentIdA <= agentIdB ? `${agentIdA}:${agentIdB}` : `${agentIdB}:${agentIdA}`;
}

function normalizeAgentIdSet(
  agentIds: BuildContactNetworkFromHistoryOptions["agentIds"],
): Set<string> | undefined {
  if (agentIds === undefined) return undefined;
  return agentIds instanceof Set ? agentIds : new Set(agentIds);
}

function openIntervalStatus(finished: boolean): AnalysisIntervalStatus {
  return finished ? "censored" : "active";
}

function exclusiveEnd(interval: ClusterMembershipInterval, asOfTick: number): number {
  return interval.endedAtTick ?? asOfTick;
}

function intervalsOverlapOnTick(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

/**
 * 同一agentが異なるclusterのmembership区間を時間的に重ねている不正を検出する。
 * 検出しても補正はせずdiagnosticのみ(ADR / Issue #213)。
 */
export function detectOverlappingMultiClusterMembership(
  membershipIntervals: readonly ClusterMembershipInterval[],
  asOfTick: number,
): StandingPartyAnalysisDiagnostic[] {
  const byAgent = new Map<string, ClusterMembershipInterval[]>();
  for (const interval of membershipIntervals) {
    const list = byAgent.get(interval.agentId);
    if (list) list.push(interval);
    else byAgent.set(interval.agentId, [interval]);
  }

  const diagnostics: StandingPartyAnalysisDiagnostic[] = [];
  for (const [agentId, intervals] of byAgent) {
    const sorted = [...intervals].sort(
      (a, b) =>
        a.startedAtTick - b.startedAtTick ||
        a.clusterId.localeCompare(b.clusterId) ||
        a.intervalId.localeCompare(b.intervalId),
    );
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (a.clusterId === b.clusterId) continue;
        const aEnd = exclusiveEnd(a, asOfTick);
        const bEnd = exclusiveEnd(b, asOfTick);
        if (!intervalsOverlapOnTick(a.startedAtTick, aEnd, b.startedAtTick, bEnd)) continue;
        diagnostics.push({
          code: "overlappingMultiClusterMembership",
          tick: Math.max(a.startedAtTick, b.startedAtTick),
          agentId,
          clusterId: a.clusterId,
          episodeId: a.episodeId,
          detail: `overlaps ${b.clusterId} (${b.episodeId})`,
        });
      }
    }
  }
  return diagnostics;
}

/**
 * membership区間の時間重複からcontact intervalを導出する。
 * cluster内の区間同士をpair走査する(ADR §7.2: O(Σ m_c²))。duration 0は生成しない。
 */
export function deriveContactIntervals(
  membershipIntervals: readonly ClusterMembershipInterval[],
  options: {
    asOfTick: number;
    finished?: boolean;
    includeActive?: boolean;
    minDurationTicks?: number;
    fromTick?: number;
    toTick?: number;
    agentIds?: ReadonlySet<string>;
  },
): { contactIntervals: ContactIntervalRecord[]; diagnostics: StandingPartyAnalysisDiagnostic[] } {
  const asOfTick = options.asOfTick;
  const fromTick = options.fromTick ?? 0;
  const toTick = options.toTick ?? asOfTick;
  const includeActive = options.includeActive !== false;
  const minDurationTicks = options.minDurationTicks ?? 1;
  const agentFilter = options.agentIds;
  const finished = options.finished === true;
  const openStatus = openIntervalStatus(finished);

  const diagnostics = detectOverlappingMultiClusterMembership(membershipIntervals, asOfTick);

  const byCluster = new Map<string, ClusterMembershipInterval[]>();
  for (const interval of membershipIntervals) {
    if (agentFilter && !agentFilter.has(interval.agentId)) continue;
    const list = byCluster.get(interval.clusterId);
    if (list) list.push(interval);
    else byCluster.set(interval.clusterId, [interval]);
  }

  const contactById = new Map<string, ContactIntervalRecord>();

  const clusterIds = [...byCluster.keys()].sort();
  for (const clusterId of clusterIds) {
    const intervals = byCluster.get(clusterId)!;
    // 決定性: agent → start → intervalId
    intervals.sort(
      (a, b) =>
        a.agentId.localeCompare(b.agentId) ||
        a.startedAtTick - b.startedAtTick ||
        a.intervalId.localeCompare(b.intervalId),
    );

    for (let i = 0; i < intervals.length; i++) {
      for (let j = i + 1; j < intervals.length; j++) {
        const left = intervals[i];
        const right = intervals[j];
        if (left.agentId === right.agentId) continue;
        if (agentFilter && (!agentFilter.has(left.agentId) || !agentFilter.has(right.agentId))) {
          continue;
        }

        const overlapStart = Math.max(left.startedAtTick, right.startedAtTick);
        const leftEnd = exclusiveEnd(left, asOfTick);
        const rightEnd = exclusiveEnd(right, asOfTick);
        if (overlapStart >= Math.min(leftEnd, rightEnd)) continue;

        const bothOpen = left.endedAtTick === undefined && right.endedAtTick === undefined;
        // どちらかが離脱したtickでcontact終了(半開のexclusive end)。両方openなら未定義。
        const naturalEnd: number | undefined = bothOpen
          ? undefined
          : Math.min(
              ...[left.endedAtTick, right.endedAtTick].filter((t): t is number => t !== undefined),
            );
        const effectiveEnd = naturalEnd ?? asOfTick;

        // 時間窓でclip(ADR §5.1)。元履歴はmutationしない。
        const clippedStart = Math.max(overlapStart, fromTick);
        const clippedEnd = Math.min(effectiveEnd, toTick);
        if (clippedStart >= clippedEnd) continue;

        const dwellTicks = clippedEnd - clippedStart;
        if (!Number.isFinite(dwellTicks) || dwellTicks < minDurationTicks || dwellTicks < 0) {
          continue;
        }

        // 窓が現在観測点まで開き、かつ自然終了していないときだけactive/censoredを維持する。
        const remainsActive = naturalEnd === undefined && toTick >= asOfTick && clippedEnd === asOfTick;
        const recordEndedAtTick = remainsActive ? undefined : clippedEnd;
        const recordStatus: AnalysisIntervalStatus = remainsActive ? openStatus : "completed";

        if (!includeActive && recordStatus !== "completed") continue;

        const [agentIdA, agentIdB] =
          left.agentId <= right.agentId
            ? [left.agentId, right.agentId]
            : [right.agentId, left.agentId];
        // IDは元のoverlap開始tickから決定的に生成(窓clipで変えない)
        const contactIntervalId = createContactIntervalId(
          agentIdA,
          agentIdB,
          clusterId,
          overlapStart,
        );

        if (contactById.has(contactIntervalId)) continue;

        contactById.set(contactIntervalId, {
          contactIntervalId,
          agentIdA,
          agentIdB,
          clusterId,
          startedAtTick: clippedStart,
          endedAtTick: recordEndedAtTick,
          status: recordStatus,
          dwellTicks,
        });
      }
    }
  }

  const contactIntervals = [...contactById.values()].sort((a, b) =>
    a.contactIntervalId.localeCompare(b.contactIntervalId),
  );

  return { contactIntervals, diagnostics };
}

function aggregateEdges(contactIntervals: readonly ContactIntervalRecord[]): ContactNetworkEdge[] {
  type MutableEdge = {
    edgeKey: string;
    agentIdA: string;
    agentIdB: string;
    totalCoPresenceTicks: number;
    contactIntervalCount: number;
    clusters: Set<string>;
    firstContactTick: number;
    lastContactTick: number;
    isActive: boolean;
  };

  const byKey = new Map<string, MutableEdge>();
  for (const interval of contactIntervals) {
    const edgeKey = createContactNetworkEdgeKey(interval.agentIdA, interval.agentIdB);
    const lastTick =
      interval.endedAtTick !== undefined
        ? interval.endedAtTick - 1
        : interval.startedAtTick + Math.max(0, interval.dwellTicks) - 1;
    const existing = byKey.get(edgeKey);
    if (!existing) {
      byKey.set(edgeKey, {
        edgeKey,
        agentIdA: interval.agentIdA,
        agentIdB: interval.agentIdB,
        totalCoPresenceTicks: interval.dwellTicks,
        contactIntervalCount: 1,
        clusters: new Set([interval.clusterId]),
        firstContactTick: interval.startedAtTick,
        lastContactTick: Math.max(interval.startedAtTick, lastTick),
        isActive: interval.status === "active" || interval.status === "censored",
      });
      continue;
    }
    existing.totalCoPresenceTicks += interval.dwellTicks;
    existing.contactIntervalCount += 1;
    existing.clusters.add(interval.clusterId);
    if (interval.startedAtTick < existing.firstContactTick) {
      existing.firstContactTick = interval.startedAtTick;
    }
    const last = Math.max(interval.startedAtTick, lastTick);
    if (last > existing.lastContactTick) existing.lastContactTick = last;
    if (interval.status === "active" || interval.status === "censored") {
      existing.isActive = true;
    }
  }

  return [...byKey.values()]
    .map((e) => ({
      edgeKey: e.edgeKey,
      agentIdA: e.agentIdA,
      agentIdB: e.agentIdB,
      totalCoPresenceTicks: e.totalCoPresenceTicks,
      contactIntervalCount: e.contactIntervalCount,
      distinctClusterCount: e.clusters.size,
      firstContactTick: e.firstContactTick,
      lastContactTick: e.lastContactTick,
      isActive: e.isActive,
    }))
    .sort((a, b) => a.edgeKey.localeCompare(b.edgeKey));
}

function connectedComponentCount(nodeIds: readonly string[], edges: readonly ContactNetworkEdge[]): number {
  if (nodeIds.length === 0) return 0;
  const parent = new Map<string, string>();
  for (const id of nodeIds) parent.set(id, id);

  function find(id: string): string {
    let cur = id;
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur)!;
      parent.set(cur, parent.get(p)!);
      cur = p;
    }
    return cur;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // 決定的: ID昇順を親に
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  }

  for (const edge of edges) {
    if (!parent.has(edge.agentIdA) || !parent.has(edge.agentIdB)) continue;
    union(edge.agentIdA, edge.agentIdB);
  }

  const roots = new Set<string>();
  for (const id of nodeIds) roots.add(find(id));
  return roots.size;
}

function buildMetrics(nodes: readonly ContactNetworkNode[], edges: readonly ContactNetworkEdge[]): ContactNetworkMetrics {
  const n = nodes.length;
  const edgeCount = edges.length;
  const density = n < 2 ? 0 : (2 * edgeCount) / (n * (n - 1));
  const isolatedNodeCount = nodes.filter((node) => node.degree === 0).length;
  return {
    nodeCount: n,
    edgeCount,
    density,
    isolatedNodeCount,
    connectedComponentCount: connectedComponentCount(
      nodes.map((node) => node.agentId),
      edges,
    ),
  };
}

function buildNodes(
  state: SimulationState,
  edges: readonly ContactNetworkEdge[],
  history: StandingPartyConversationHistory,
  agentFilter: Set<string> | undefined,
): ContactNetworkNode[] {
  const degreeByAgent = new Map<string, number>();
  const weightedByAgent = new Map<string, number>();
  const activeByAgent = new Map<string, number>();

  for (const edge of edges) {
    degreeByAgent.set(edge.agentIdA, (degreeByAgent.get(edge.agentIdA) ?? 0) + 1);
    degreeByAgent.set(edge.agentIdB, (degreeByAgent.get(edge.agentIdB) ?? 0) + 1);
    weightedByAgent.set(
      edge.agentIdA,
      (weightedByAgent.get(edge.agentIdA) ?? 0) + edge.totalCoPresenceTicks,
    );
    weightedByAgent.set(
      edge.agentIdB,
      (weightedByAgent.get(edge.agentIdB) ?? 0) + edge.totalCoPresenceTicks,
    );
    if (edge.isActive) {
      activeByAgent.set(edge.agentIdA, (activeByAgent.get(edge.agentIdA) ?? 0) + 1);
      activeByAgent.set(edge.agentIdB, (activeByAgent.get(edge.agentIdB) ?? 0) + 1);
    }
  }

  const episodeCountByAgent = new Map<string, number>();
  for (const episode of history.episodes) {
    episodeCountByAgent.set(episode.agentId, (episodeCountByAgent.get(episode.agentId) ?? 0) + 1);
  }

  const agents = [...state.agents]
    .filter((agent) => !agentFilter || agentFilter.has(agent.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  return agents.map((agent) => {
    const comparisonAttributes =
      agent.cliqueId !== undefined ? { cliqueId: agent.cliqueId } : undefined;
    return {
      agentId: agent.id,
      label: agent.label,
      isObserverJoiner: agent.isObserverJoiner,
      currentState: agent.state,
      currentClusterId: agent.joinedGroupId,
      degree: degreeByAgent.get(agent.id) ?? 0,
      weightedDegree: weightedByAgent.get(agent.id) ?? 0,
      activeContactCount: activeByAgent.get(agent.id) ?? 0,
      episodeCount: episodeCountByAgent.get(agent.id) ?? 0,
      ...(comparisonAttributes ? { comparisonAttributes } : {}),
    };
  });
}

function optionsCacheKey(
  asOfTick: number,
  fromTick: number,
  toTick: number,
  includeActive: boolean,
  minDurationTicks: number,
  agentFilter: Set<string> | undefined,
  historyAsOf: number,
  logLength: number,
): string {
  const agentsKey = agentFilter ? [...agentFilter].sort().join(",") : "";
  return [
    STANDING_PARTY_ANALYSIS_SCHEMA_VERSION,
    asOfTick,
    fromTick,
    toTick,
    includeActive ? 1 : 0,
    minDurationTicks,
    agentsKey,
    historyAsOf,
    logLength,
  ].join("|");
}

/**
 * 会話履歴 + live stateから接触ネットワークsnapshotを導出する。
 * 同じ入力・同じoptionsからは同じ結果を返す(決定的)。RNGは消費しない。
 * stateからの一括導出は`standingPartyAnalysis.buildStandingPartyContactNetwork`を使う。
 */
export function buildContactNetworkFromHistory(
  state: SimulationState,
  history: StandingPartyConversationHistory,
  options?: BuildContactNetworkFromHistoryOptions,
): StandingPartyContactNetwork {
  const asOfTick = options?.asOfTick ?? history.asOfTick;
  const fromTick = options?.fromTick ?? 0;
  const toTick = options?.toTick ?? asOfTick;
  const includeActive = options?.includeActive !== false;
  const minDurationTicks = options?.minDurationTicks ?? 1;
  const agentFilter = normalizeAgentIdSet(options?.agentIds);

  const { contactIntervals, diagnostics } = deriveContactIntervals(history.membershipIntervals, {
    asOfTick,
    finished: state.finished,
    includeActive,
    minDurationTicks,
    fromTick,
    toTick,
    agentIds: agentFilter,
  });

  // membership入力順を変えても同一結果になることを保証するため、
  // derive側でcluster/agent順にソート済み。ここではID順で安定化する。
  const edges = aggregateEdges(contactIntervals);
  const nodes = buildNodes(state, edges, history, agentFilter);
  const metrics = buildMetrics(nodes, edges);

  for (const interval of contactIntervals) {
    if (!Number.isFinite(interval.dwellTicks) || interval.dwellTicks < 0) {
      throw new Error(`invalid contact dwellTicks: ${interval.contactIntervalId}`);
    }
  }
  for (const edge of edges) {
    if (!Number.isFinite(edge.totalCoPresenceTicks) || edge.totalCoPresenceTicks < 0) {
      throw new Error(`invalid edge totalCoPresenceTicks: ${edge.edgeKey}`);
    }
  }
  if (!Number.isFinite(metrics.density) || metrics.density < 0) {
    throw new Error("invalid network density");
  }

  return {
    schemaVersion: STANDING_PARTY_ANALYSIS_SCHEMA_VERSION,
    asOfTick,
    fromTick,
    toTick,
    contactIntervals,
    edges,
    nodes,
    metrics,
    diagnostics: [...history.diagnostics, ...diagnostics],
  };
}

/**
 * membership配列の順序を入れ替えてもcontact/edgeが変わらないことを検証するテスト用ヘルパー。
 */
export function assertContactDerivationOrderIndependent(
  membershipIntervals: readonly ClusterMembershipInterval[],
  asOfTick: number,
): ContactIntervalRecord[] {
  const forward = deriveContactIntervals(membershipIntervals, { asOfTick });
  const reversed = deriveContactIntervals([...membershipIntervals].reverse(), { asOfTick });
  if (JSON.stringify(forward.contactIntervals) !== JSON.stringify(reversed.contactIntervals)) {
    throw new Error("deriveContactIntervals depends on membership input order");
  }
  return forward.contactIntervals;
}

/** memoizationキー生成(入口ラッパから利用) */
export function buildContactNetworkMemoKey(
  state: SimulationState,
  options: BuildContactNetworkFromHistoryOptions | undefined,
  historyAsOf: number,
): string {
  const asOfTick = options?.asOfTick ?? historyAsOf;
  const fromTick = options?.fromTick ?? 0;
  const toTick = options?.toTick ?? asOfTick;
  const includeActive = options?.includeActive !== false;
  const minDurationTicks = options?.minDurationTicks ?? 1;
  const agentFilter = normalizeAgentIdSet(options?.agentIds);
  return optionsCacheKey(
    asOfTick,
    fromTick,
    toTick,
    includeActive,
    minDurationTicks,
    agentFilter,
    historyAsOf,
    state.log.length,
  );
}

export function readContactNetworkMemo(
  state: SimulationState,
  key: string,
): StandingPartyContactNetwork | undefined {
  const cached = contactNetworkMemo.get(state);
  return cached && cached.key === key ? cached.network : undefined;
}

export function writeContactNetworkMemo(
  state: SimulationState,
  key: string,
  network: StandingPartyContactNetwork,
): void {
  contactNetworkMemo.set(state, { key, network });
}

/**
 * 入力stateをmutationしていないこと・導出が決定的であることの軽い自己検査用。
 * テストから呼び、本番経路では使わない。
 */
export function assertContactNetworkDoesNotMutateState(
  state: SimulationState,
  history: StandingPartyConversationHistory,
  build: (
    s: SimulationState,
    h: StandingPartyConversationHistory,
  ) => StandingPartyContactNetwork = buildContactNetworkFromHistory,
): StandingPartyContactNetwork {
  const logLengthBefore = state.log.length;
  const agentSnapshot = state.agents.map((a) => ({
    id: a.id,
    state: a.state,
    joinedGroupId: a.joinedGroupId,
    stress: a.stress,
  }));
  const first = build(state, history);
  const second = build(state, history);
  if (state.log.length !== logLengthBefore) {
    throw new Error("buildContactNetworkFromHistory mutated state.log");
  }
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("buildContactNetworkFromHistory is not deterministic");
  }
  for (let i = 0; i < agentSnapshot.length; i++) {
    const agent = state.agents[i];
    const snap = agentSnapshot[i];
    if (
      agent.id !== snap.id ||
      agent.state !== snap.state ||
      agent.joinedGroupId !== snap.joinedGroupId ||
      agent.stress !== snap.stress
    ) {
      throw new Error("buildContactNetworkFromHistory mutated agents");
    }
  }
  return first;
}
