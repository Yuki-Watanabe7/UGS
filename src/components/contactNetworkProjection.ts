/**
 * Issue #216: `StandingPartyContactNetwork` → グラフ表示用投影。
 * #213のsnapshotをmutationせず、filter / weight / layout 用の部分集合を返す。
 * layoutはpresentation専用の決定的配置で、simulation座標・PRNGを使わない。
 */
import type {
  ContactIntervalRecord,
  ContactNetworkEdge,
  ContactNetworkNode,
  SimulationState,
  StandingPartyContactNetwork,
} from "../simulation/types";

export type ContactNetworkWeightMode =
  | "totalCoPresenceTicks"
  | "contactIntervalCount"
  | "distinctClusterCount"
  | "binary";

export type ContactNetworkViewFilter = {
  /** 半開 `[fromTick, toTick)`。APIへ渡し、UI側で履歴を再集計しない */
  fromTick?: number;
  toTick?: number;
  /** 最小接触duration(tick)。APIの `minDurationTicks` へ */
  minDurationTicks?: number;
  /** true のとき active contact の辺のみ表示 */
  activeOnly?: boolean;
  /** 選択agentのego network(隣接のみ)。未選択時は無視 */
  egoNetwork?: boolean;
  /** ObserverJoinerを含む辺のみ */
  observerJoinerEdgesOnly?: boolean;
  /** 当該clusterでの接触intervalを持つ辺のみ */
  clusterId?: string;
  /** 表示weightの最小しきい値。binaryでは無視(有無のみ) */
  minWeight?: number;
  /** 接触0のisolated nodeを表示するか */
  showIsolated?: boolean;
  weightMode: ContactNetworkWeightMode;
};

export type ContactNetworkSelection =
  | { kind: "node"; agentId: string }
  | { kind: "edge"; edgeKey: string }
  | { kind: "interval"; contactIntervalId: string; edgeKey: string };

export type ContactNetworkLayoutPoint = { x: number; y: number };

export type ProjectedContactNetworkNode = ContactNetworkNode & {
  x: number;
  y: number;
  isolated: boolean;
};

export type ProjectedContactNetworkEdge = ContactNetworkEdge & {
  weight: number;
  strokeWidth: number;
};

export type ContactNetworkProjection = {
  asOfTick: number;
  fromTick: number;
  toTick: number;
  weightMode: ContactNetworkWeightMode;
  minWeight: number;
  nodes: ProjectedContactNetworkNode[];
  edges: ProjectedContactNetworkEdge[];
  /** keyboard/代替list用。ID順で安定 */
  nodeList: ProjectedContactNetworkNode[];
  edgeList: ProjectedContactNetworkEdge[];
  metrics: StandingPartyContactNetwork["metrics"];
  /** 表示用の最大weight(線幅スケール)。0のとき線幅は最小固定 */
  maxWeight: number;
};

export const DEFAULT_CONTACT_NETWORK_FILTER: ContactNetworkViewFilter = {
  fromTick: 0,
  minDurationTicks: 1,
  activeOnly: false,
  egoNetwork: false,
  observerJoinerEdgesOnly: false,
  showIsolated: true,
  weightMode: "totalCoPresenceTicks",
  minWeight: 0,
};

/** SVG viewBox の論理サイズ。layoutはこの座標系に固定する */
export const CONTACT_NETWORK_VIEW_WIDTH = 320;
export const CONTACT_NETWORK_VIEW_HEIGHT = 240;

export function edgeWeight(edge: ContactNetworkEdge, mode: ContactNetworkWeightMode): number {
  switch (mode) {
    case "totalCoPresenceTicks":
      return edge.totalCoPresenceTicks;
    case "contactIntervalCount":
      return edge.contactIntervalCount;
    case "distinctClusterCount":
      return edge.distinctClusterCount;
    case "binary":
      return 1;
  }
}

/**
 * 全agentを agentId 昇順で円周配置する。filterで可視集合が変わっても
 * 同じagentの座標は変わらない(再renderでの不要な跳躍を避ける)。
 */
export function layoutContactNetworkNodes(
  agentIds: readonly string[],
  width = CONTACT_NETWORK_VIEW_WIDTH,
  height = CONTACT_NETWORK_VIEW_HEIGHT,
): Map<string, ContactNetworkLayoutPoint> {
  const sorted = [...agentIds].sort((a, b) => a.localeCompare(b));
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.38;
  const positions = new Map<string, ContactNetworkLayoutPoint>();
  if (sorted.length === 0) return positions;
  if (sorted.length === 1) {
    positions.set(sorted[0]!, { x: cx, y: cy });
    return positions;
  }
  sorted.forEach((id, index) => {
    const angle = (2 * Math.PI * index) / sorted.length - Math.PI / 2;
    positions.set(id, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });
  return positions;
}

function strokeWidthForWeight(weight: number, maxWeight: number, mode: ContactNetworkWeightMode): number {
  if (mode === "binary") return 1.5;
  if (maxWeight <= 0 || weight <= 0) return 1;
  const t = weight / maxWeight;
  return 1 + t * 5;
}

/** edgeに属するcontact interval(cluster filter後も元networkから引ける) */
export function contactIntervalsForEdge(
  network: StandingPartyContactNetwork,
  edgeKey: string,
  clusterId?: string,
): ContactIntervalRecord[] {
  return network.contactIntervals.filter((interval) => {
    const a = interval.agentIdA < interval.agentIdB ? interval.agentIdA : interval.agentIdB;
    const b = interval.agentIdA < interval.agentIdB ? interval.agentIdB : interval.agentIdA;
    if (`${a}:${b}` !== edgeKey) return false;
    if (clusterId && interval.clusterId !== clusterId) return false;
    return true;
  });
}

export function findSelectedNode(
  projection: ContactNetworkProjection,
  selection: ContactNetworkSelection | undefined,
): ProjectedContactNetworkNode | undefined {
  if (selection?.kind !== "node") return undefined;
  return projection.nodes.find((n) => n.agentId === selection.agentId);
}

export function findSelectedEdge(
  projection: ContactNetworkProjection,
  selection: ContactNetworkSelection | undefined,
): ProjectedContactNetworkEdge | undefined {
  if (!selection) return undefined;
  const edgeKey = selection.kind === "edge" || selection.kind === "interval" ? selection.edgeKey : undefined;
  if (!edgeKey) return undefined;
  return projection.edges.find((e) => e.edgeKey === edgeKey);
}

export function findSelectedInterval(
  network: StandingPartyContactNetwork,
  selection: ContactNetworkSelection | undefined,
): ContactIntervalRecord | undefined {
  if (selection?.kind !== "interval") return undefined;
  return network.contactIntervals.find((i) => i.contactIntervalId === selection.contactIntervalId);
}

/**
 * 選択nodeの最強接触上位。定義は現在のweightModeの値降順、同値はedgeKey昇順。
 */
export function strongestContactsForNode(
  projection: ContactNetworkProjection,
  agentId: string,
  limit = 5,
): Array<{ edge: ProjectedContactNetworkEdge; otherAgentId: string }> {
  return projection.edges
    .filter((e) => e.agentIdA === agentId || e.agentIdB === agentId)
    .map((edge) => ({
      edge,
      otherAgentId: edge.agentIdA === agentId ? edge.agentIdB : edge.agentIdA,
    }))
    .sort(
      (a, b) =>
        b.edge.weight - a.edge.weight || a.edge.edgeKey.localeCompare(b.edge.edgeKey),
    )
    .slice(0, limit);
}

/**
 * #213 snapshot を表示用に絞り込む。入力 network / state は mutation しない。
 * cluster / ego / OJ は API に無いため投影側で辺を絞る(再集計はしない)。
 */
export function projectContactNetwork(
  state: SimulationState,
  network: StandingPartyContactNetwork,
  filter: ContactNetworkViewFilter,
  selectedAgentId?: string,
): ContactNetworkProjection {
  const weightMode = filter.weightMode;
  const minWeight = filter.minWeight ?? 0;
  const showIsolated = filter.showIsolated !== false;
  const positions = layoutContactNetworkNodes(state.agents.map((a) => a.id));

  const ojIds = new Set(
    state.agents.filter((a) => a.isObserverJoiner).map((a) => a.id),
  );

  let edges = network.edges.slice();

  if (filter.activeOnly) {
    edges = edges.filter((e) => e.isActive);
  }

  if (filter.clusterId) {
    const keys = new Set(
      network.contactIntervals
        .filter((i) => i.clusterId === filter.clusterId)
        .map((i) => {
          const a = i.agentIdA < i.agentIdB ? i.agentIdA : i.agentIdB;
          const b = i.agentIdA < i.agentIdB ? i.agentIdB : i.agentIdA;
          return `${a}:${b}`;
        }),
    );
    edges = edges.filter((e) => keys.has(e.edgeKey));
  }

  if (filter.observerJoinerEdgesOnly) {
    edges = edges.filter((e) => ojIds.has(e.agentIdA) || ojIds.has(e.agentIdB));
  }

  if (filter.egoNetwork && selectedAgentId) {
    edges = edges.filter(
      (e) => e.agentIdA === selectedAgentId || e.agentIdB === selectedAgentId,
    );
  }

  const weighted: ProjectedContactNetworkEdge[] = [];
  let maxWeight = 0;
  for (const edge of edges) {
    const weight = edgeWeight(edge, weightMode);
    // weight 0・分母0相当・binaryで接触なしは出さない(辺自体が接触あり)
    if (weightMode !== "binary" && weight <= 0) continue;
    if (weightMode !== "binary" && weight < minWeight) continue;
    if (weight > maxWeight) maxWeight = weight;
    weighted.push({
      ...edge,
      weight,
      strokeWidth: 1, // 後で max 確定後に再計算
    });
  }

  const projectedEdges = weighted
    .map((edge) => ({
      ...edge,
      strokeWidth: strokeWidthForWeight(edge.weight, maxWeight, weightMode),
    }))
    .sort((a, b) => a.edgeKey.localeCompare(b.edgeKey));

  const connectedIds = new Set<string>();
  for (const edge of projectedEdges) {
    connectedIds.add(edge.agentIdA);
    connectedIds.add(edge.agentIdB);
  }

  // ego network: 選択agent自身もnodeとして残す(辺0でも)
  if (filter.egoNetwork && selectedAgentId) {
    connectedIds.add(selectedAgentId);
  }

  const nodeById = new Map(network.nodes.map((n) => [n.agentId, n]));
  const projectedNodes: ProjectedContactNetworkNode[] = [];

  for (const agent of state.agents) {
    const inConnected = connectedIds.has(agent.id);
    const isolated = !inConnected;
    if (isolated && !showIsolated) continue;
    if (filter.egoNetwork && selectedAgentId) {
      // egoモードでは隣接+自分のみ(isolated表示ONでも他agentは出さない)
      if (!inConnected) continue;
    }
    if (filter.observerJoinerEdgesOnly && !inConnected) {
      // OJ辺のみのとき、辺に乗らないisolatedは出さない(OJ本人の孤立はego外)
      continue;
    }
    if (filter.clusterId && !inConnected) continue;
    if (filter.activeOnly && !inConnected) continue;

    const base: ContactNetworkNode = nodeById.get(agent.id) ?? {
      agentId: agent.id,
      label: agent.label,
      isObserverJoiner: agent.isObserverJoiner,
      currentState: agent.state,
      currentClusterId: agent.joinedGroupId,
      degree: 0,
      weightedDegree: 0,
      activeContactCount: 0,
      episodeCount: 0,
      comparisonAttributes:
        agent.cliqueId !== undefined ? { cliqueId: agent.cliqueId } : undefined,
    };
    const pos = positions.get(agent.id) ?? { x: CONTACT_NETWORK_VIEW_WIDTH / 2, y: CONTACT_NETWORK_VIEW_HEIGHT / 2 };
    projectedNodes.push({
      ...base,
      x: pos.x,
      y: pos.y,
      isolated,
    });
  }

  projectedNodes.sort((a, b) => a.agentId.localeCompare(b.agentId));

  return {
    asOfTick: network.asOfTick,
    fromTick: network.fromTick,
    toTick: network.toTick,
    weightMode,
    minWeight,
    nodes: projectedNodes,
    edges: projectedEdges,
    nodeList: projectedNodes,
    edgeList: projectedEdges,
    metrics: network.metrics,
    maxWeight,
  };
}
