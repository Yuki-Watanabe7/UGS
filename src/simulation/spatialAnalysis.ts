/**
 * Issue #251 (Phase 6 P6-F, standingParty, roadmap #172): `docs/spatial-dynamics-phase6-model.md`
 * (Issue #246 ADR)§8の空間指標を、`SimulationState`(`agents`/`groupCandidates`/`spatialRuntimeState`)から
 * read-onlyに導出する。`informationAnalysis.ts`(#234)と同じ方針で、`SimulationState`の更新・PRNG消費は
 * 一切行わず、表示・export・統計はこのmoduleの戻り値を共有する。
 *
 * 対象外(issue #251「対象外」節「spatial runtime ruleの追加・変更」): 本moduleは`SimulationState`へ
 * 新しいruntime historyを追加しない。そのため、ADR §8.6(distinct zones visited)・§8.7(roaming distance)・
 * cluster center path lengthのような「累積」指標は、過去tickの位置を保持するruntime拡張
 * (`engine.ts`側の変更、`spatialRuntimeState`拡張)を要し本Issueのスコープ外である。本moduleが提供する
 * 8.6/8.7相当は、そのため「今tick時点の瞬間的な移動量・混雑状態」の分布として代替する
 * (`instantRoamingSpeed`/`crowded`等、関数名・field名で累積ではないことを明示する)。真の累積履歴追跡は
 * 別Issueのスコープとする(`docs/standing-party-phase6-verification.md`参照)。
 *
 * 価値評価との非結合(issue受入条件「指標を人気・社交性・良し悪しとして評価しない」): 本moduleが返す
 * 値はすべて中立的な記述統計(件数・分布・rate)であり、ラベル付け・評価は呼び出し側(UI)でも行わない。
 */
import {
  computeCrowdingVector,
  computeSpatialOccupancyGridSnapshot,
  isCrowdingDensitySource,
  isPresentForOccupancy,
  isSameClusterMember,
  SPATIAL_OCCUPANCY_GRID_COLS,
  SPATIAL_OCCUPANCY_GRID_ROWS,
} from "./spatialOccupancy";
import {
  getClusterVelocity,
  isClusterOverlapping,
  nearestClusterDistance,
} from "./spatialDynamics";
import type { SpatialDynamicsConfig } from "./spatialDynamics";
import {
  computeAgentWallAvoidanceForce,
  computeRoamingVector,
  getRoamingState,
  roamingIntensity,
  roamingTicksRemaining,
} from "./roaming";
import { distance, WORLD_WIDTH, WORLD_HEIGHT } from "./model";
import { rateWithDenominator, summarizeDistribution } from "./standingPartyStatistics";
import type {
  Agent,
  AgentState,
  DistributionSummary,
  GroupCandidate,
  GroupCandidateStatus,
  RateWithDenominator,
  SimulationState,
} from "./types";

export const SPATIAL_DYNAMICS_ANALYSIS_SCHEMA_VERSION = "spatial-dynamics-analysis/1" as const;

/** #234の`InformationAnalysisFilter`と同じ方針。省略した項目は制限しない。 */
export type SpatialAnalysisFilter = {
  agentIds?: readonly string[];
  clusterIds?: readonly string[];
  observerJoinerMode?: "all" | "only" | "exclude";
};

/** ADR §8.1/§8.2/§8.3/§8.4/§8.5相当。すべて今tick時点のrun/tick snapshot。 */
export type StandingPartySpatialSnapshot = {
  tick: number;
  presentAgentCount: number;
  /** 8.1: 占有cell比率(計測専用grid、`spatialOccupancy.ts`と同一定義) */
  occupiedCells: RateWithDenominator;
  cellOccupancy: DistributionSummary;
  centroid?: { x: number; y: number };
  /** 8.2: 重心からの距離のRMS。在場agentが0人ならundefined(0で捏造しない) */
  radiusOfGyration?: number;
  activeClusterCount: number;
  /** 8.3: confirmed cluster間の最近接距離の分布(cluster数が2未満なら空分布) */
  clusterNearestNeighborDistance: DistributionSummary;
  /** 8.4: agentごとの`crowdSampleRadius`内・同clusterを除く他agent数(重み無し実数)の分布 */
  localDensity: DistributionSummary;
  /** 8.4関連: 計測専用gridのcellのうち、`crowdDensityThreshold`を超える人数のcellの比率 */
  overCrowdedCellRate: RateWithDenominator;
  /** 8.5: 中心間距離が`overlapThreshold`未満のconfirmed cluster対が存在する比率(cluster対単位) */
  clusterOverlapRate: RateWithDenominator;
};

export type AgentSpatialSnapshot = {
  agentId: string;
  label?: string;
  isObserverJoiner: boolean;
  state: AgentState;
  x: number;
  y: number;
  roamingActive: boolean;
  roamingHeadingRadians?: number;
  roamingTicksRemaining?: number;
  roamingIntensity?: number;
  /** 今tickのroaming移動量(速度)。累積距離ではない(モジュール冒頭コメント参照) */
  instantRoamingSpeed?: number;
  /** `crowdSampleRadius`内・同clusterを除く他agent数(重み無し実数) */
  localDensity: number;
  crowded: boolean;
  crowdingVectorMagnitude: number;
  /** agent側wall avoidance(境界回避)vectorの大きさ。境界から離れていれば0 */
  wallAvoidanceMagnitude: number;
  nearestClusterId?: string;
  nearestClusterDistance?: number;
};

export type ClusterSpatialSnapshot = {
  clusterId: string;
  status: GroupCandidateStatus;
  x: number;
  y: number;
  velocity?: { vx: number; vy: number };
  /** 今tickのcluster中心速度の大きさ。累積移動距離ではない */
  speed?: number;
  memberCount: number;
  nearestClusterId?: string;
  nearestClusterDistance?: number;
  overlapping: boolean;
  nearWall: boolean;
};

export type StandingPartySpatialAnalysis = {
  schemaVersion: typeof SPATIAL_DYNAMICS_ANALYSIS_SCHEMA_VERSION;
  tick: number;
  spatialDynamicsEnabled: boolean;
  filter: SpatialAnalysisFilter;
  config: SpatialDynamicsConfig;
  snapshot: StandingPartySpatialSnapshot;
  agents: AgentSpatialSnapshot[];
  clusters: ClusterSpatialSnapshot[];
};

function asSet(values: readonly string[] | undefined): Set<string> | undefined {
  return values && values.length > 0 ? new Set(values) : undefined;
}

function passesAgentFilter(agent: Agent, filter: SpatialAnalysisFilter): boolean {
  const agentIds = asSet(filter.agentIds);
  if (agentIds && !agentIds.has(agent.id)) return false;
  if (filter.observerJoinerMode === "only" && !agent.isObserverJoiner) return false;
  if (filter.observerJoinerMode === "exclude" && agent.isObserverJoiner) return false;
  return true;
}

function passesClusterFilter(cluster: GroupCandidate, filter: SpatialAnalysisFilter): boolean {
  const clusterIds = asSet(filter.clusterIds);
  return !clusterIds || clusterIds.has(cluster.id);
}

/**
 * ADR §8.4「各agentのcrowdSampleRadius内の他agent数の分布」: `computeCrowdingVector`の方向重み付き
 * pushとは異なる、単純な実数カウント(同clusterのmemberは§4.3と同じ理由で除外)。
 */
function countNearbyAgents(agent: Agent, agents: readonly Agent[], radius: number): number {
  let count = 0;
  for (const other of agents) {
    if (other.id === agent.id) continue;
    if (!isCrowdingDensitySource(other)) continue;
    if (isSameClusterMember(agent, other)) continue;
    if (distance(agent.x, agent.y, other.x, other.y) < radius) count += 1;
  }
  return count;
}

function isNearWall(point: { x: number; y: number }, margin: number): boolean {
  return (
    point.x < margin || WORLD_WIDTH - point.x < margin || point.y < margin || WORLD_HEIGHT - point.y < margin
  );
}

/**
 * `state`(+ `standingPartyConfig.spatialDynamics`)を一度だけ読み取り、表示・export・統計で共有する
 * 空間分析snapshotを作る。純粋関数でrngを消費せず、`state`をmutationしない。
 * `formationScenarioId !== "standingParty"`でも呼び出せるが、`groupCandidates`/`spatialRuntimeState`が
 * 空であれば自然に空のsnapshotを返す(明示的なガードは呼び出し側の責務)。
 */
export function buildStandingPartySpatialAnalysis(
  state: SimulationState,
  config: SpatialDynamicsConfig,
  filter: SpatialAnalysisFilter = {},
): StandingPartySpatialAnalysis {
  const spatialDynamicsEnabled =
    state.formationScenarioId === "standingParty" && config.enabled;

  const agents = state.agents.filter((agent) => passesAgentFilter(agent, filter));
  const presentAgents = agents.filter(isPresentForOccupancy);
  const activeClusters = state.groupCandidates
    .filter((c) => c.status === "confirmed")
    .filter((c) => passesClusterFilter(c, filter))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const occupancyGrid = computeSpatialOccupancyGridSnapshot(presentAgents);

  let centroid: { x: number; y: number } | undefined;
  let radiusOfGyration: number | undefined;
  if (presentAgents.length > 0) {
    const sumX = presentAgents.reduce((sum, a) => sum + a.x, 0);
    const sumY = presentAgents.reduce((sum, a) => sum + a.y, 0);
    centroid = { x: sumX / presentAgents.length, y: sumY / presentAgents.length };
    const meanSquaredDistance =
      presentAgents.reduce((sum, a) => sum + distance(a.x, a.y, centroid!.x, centroid!.y) ** 2, 0) /
      presentAgents.length;
    radiusOfGyration = Math.sqrt(meanSquaredDistance);
  }

  const nearestDistances: number[] = [];
  let overlappingPairCount = 0;
  let totalPairCount = 0;
  for (let i = 0; i < activeClusters.length; i++) {
    const nearest = nearestClusterDistance(activeClusters[i], activeClusters);
    if (nearest !== undefined) nearestDistances.push(nearest);
    for (let j = i + 1; j < activeClusters.length; j++) {
      totalPairCount += 1;
      if (distance(activeClusters[i].x, activeClusters[i].y, activeClusters[j].x, activeClusters[j].y) < config.overlapThreshold) {
        overlappingPairCount += 1;
      }
    }
  }

  const localDensityByAgentId = new Map<string, number>();
  for (const agent of presentAgents) {
    localDensityByAgentId.set(agent.id, countNearbyAgents(agent, state.agents, config.crowdSampleRadius));
  }

  const overCrowdedCellCount = countOverCrowdedCells(presentAgents, config);

  const snapshot: StandingPartySpatialSnapshot = {
    tick: state.tick,
    presentAgentCount: presentAgents.length,
    occupiedCells: occupancyGrid.occupiedCells,
    cellOccupancy: occupancyGrid.cellOccupancy,
    centroid,
    radiusOfGyration,
    activeClusterCount: activeClusters.length,
    clusterNearestNeighborDistance: summarizeDistribution(nearestDistances),
    localDensity: summarizeDistribution([...localDensityByAgentId.values()]),
    overCrowdedCellRate: rateWithDenominator(
      overCrowdedCellCount,
      occupancyGrid.gridCols * occupancyGrid.gridRows,
    ),
    clusterOverlapRate: rateWithDenominator(overlappingPairCount, totalPairCount),
  };

  const agentSnapshots: AgentSpatialSnapshot[] = agents
    .map((agent): AgentSpatialSnapshot => {
      const roaming = getRoamingState(state.spatialRuntimeState?.roaming, agent.id);
      const roamingActive = spatialDynamicsEnabled && config.roamingEnabled && agent.state === "undecided" && roaming !== undefined;
      const crowding = computeCrowdingVector(agent, state.agents, state.groupCandidates, config);
      // ADR §3.4: pendingClusterTransition保持中はroaming寄与が0になる(engine.ts step 6と同じ計算)。
      const effectiveIntensity = agent.pendingClusterTransition ? 0 : roamingIntensity(agent, config);
      const roamingVector =
        roamingActive && roaming ? computeRoamingVector(roaming.headingRadians, effectiveIntensity, config) : undefined;
      const wallForce = computeAgentWallAvoidanceForce(agent, config);
      let nearestId: string | undefined;
      let nearestDistanceValue: number | undefined;
      for (const cluster of activeClusters) {
        const d = distance(agent.x, agent.y, cluster.x, cluster.y);
        if (nearestDistanceValue === undefined || d < nearestDistanceValue) {
          nearestDistanceValue = d;
          nearestId = cluster.id;
        }
      }
      return {
        agentId: agent.id,
        label: agent.label,
        isObserverJoiner: agent.isObserverJoiner,
        state: agent.state,
        x: agent.x,
        y: agent.y,
        roamingActive,
        roamingHeadingRadians: roaming?.headingRadians,
        roamingTicksRemaining: roaming ? roamingTicksRemaining(roaming, state.tick) : undefined,
        roamingIntensity: roamingActive ? effectiveIntensity : undefined,
        instantRoamingSpeed: roamingVector ? Math.hypot(roamingVector.dx, roamingVector.dy) : undefined,
        localDensity: localDensityByAgentId.get(agent.id) ?? countNearbyAgents(agent, state.agents, config.crowdSampleRadius),
        crowded: crowding.crowded,
        crowdingVectorMagnitude: crowding.magnitude,
        wallAvoidanceMagnitude: Math.hypot(wallForce.fx, wallForce.fy),
        nearestClusterId: nearestId,
        nearestClusterDistance: nearestDistanceValue,
      };
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));

  const clusterSnapshots: ClusterSpatialSnapshot[] = activeClusters.map((cluster): ClusterSpatialSnapshot => {
    const velocity = state.spatialRuntimeState ? getClusterVelocity(state.spatialRuntimeState, cluster.id) : undefined;
    const nearest = nearestClusterDistance(cluster, activeClusters);
    let nearestId: string | undefined;
    if (nearest !== undefined) {
      const found = activeClusters.find(
        (other) => other.id !== cluster.id && distance(cluster.x, cluster.y, other.x, other.y) === nearest,
      );
      nearestId = found?.id;
    }
    return {
      clusterId: cluster.id,
      status: cluster.status,
      x: cluster.x,
      y: cluster.y,
      velocity,
      speed: velocity ? Math.hypot(velocity.vx, velocity.vy) : undefined,
      memberCount: cluster.memberIds.length,
      nearestClusterId: nearestId,
      nearestClusterDistance: nearest,
      overlapping: isClusterOverlapping(cluster, activeClusters, config),
      nearWall: isNearWall(cluster, config.wallAvoidanceDistance),
    };
  });

  return {
    schemaVersion: SPATIAL_DYNAMICS_ANALYSIS_SCHEMA_VERSION,
    tick: state.tick,
    spatialDynamicsEnabled,
    filter,
    config,
    snapshot,
    agents: agentSnapshots,
    clusters: clusterSnapshots,
  };
}

/**
 * 計測専用grid(`spatialOccupancy.ts`と同一定義)のcellのうち、在場人数が`crowdDensityThreshold`を
 * 超えるcell数(issue実装範囲8節参照)。`config.crowdDensityThreshold`はcrowding field(§4)と同じ値を
 * cellの粗さで再解釈しただけであり、新規config項目は増やさない(#250と同じ方針)。
 */
function countOverCrowdedCells(agents: readonly Agent[], config: SpatialDynamicsConfig): number {
  const gridCols = SPATIAL_OCCUPANCY_GRID_COLS;
  const gridRows = SPATIAL_OCCUPANCY_GRID_ROWS;
  const cellCounts = new Array<number>(gridCols * gridRows).fill(0);
  for (const agent of agents) {
    const col = Math.min(gridCols - 1, Math.max(0, Math.floor((agent.x / WORLD_WIDTH) * gridCols)));
    const row = Math.min(gridRows - 1, Math.max(0, Math.floor((agent.y / WORLD_HEIGHT) * gridRows)));
    cellCounts[row * gridCols + col] += 1;
  }
  return cellCounts.reduce((count, c) => count + (c > config.crowdDensityThreshold ? 1 : 0), 0);
}

/** export/UIが分析の非介入性を回帰テストするための小さなguard(`informationAnalysis.ts`と同じ方針)。 */
export function assertSpatialAnalysisDoesNotMutateState(state: SimulationState, run: () => unknown): void {
  const before = JSON.stringify(state);
  run();
  if (JSON.stringify(state) !== before) throw new Error("spatialAnalysis mutated SimulationState");
}
