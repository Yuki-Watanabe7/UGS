/**
 * Issue #249 (Phase 6, standingParty, roadmap #172): `docs/spatial-dynamics-phase6-model.md`
 * (Issue #246 ADR)の§4(局所crowding field)+§8.1/§8.4(計測専用grid)に基づく、方向サンプリング方式の
 * local crowding avoidance vectorと、read-onlyな空間occupancy診断selectorの純粋関数群。
 *
 * 本ファイルの実装スコープはADR§12のP6-C後半(crowding field)。cluster間斥力・cluster movement(#247)、
 * roaming本体(#248)、候補選択の一般化(#250)は対象外。engine.tsへの結線は`undecided`のroaming step
 * (ADR §6.1 step 6)のみで、`applyAgentRoamingStep`(`roaming.ts`)の合成へcrowd vectorを1成分として
 * 追加する形にする(approaching/forming/joined/leavingへは適用しない、issue #249実装範囲5節)。
 *
 * 決定性: crowding field(§4.2)・occupancy grid(§8.1/§8.4)ともrngを一切消費しない(ADR §4.2「rngを
 * 一切消費しない」、§9.3)。`agents`/`candidates`の配列順に依存しない(方向ごとの重み付き総和は
 * 加算の順序に依存しない)。どちらの関数も入力をmutationしない。
 */
import type { Agent, DistributionSummary, GroupCandidate, RateWithDenominator } from "./types";
import { WORLD_WIDTH, WORLD_HEIGHT } from "./model";
import { rateWithDenominator, summarizeDistribution } from "./standingPartyStatistics";
import type { SpatialDynamicsConfig } from "./spatialDynamics";

// --- local crowding field (ADR §4) -----------------------------------------------------------

/**
 * crowding avoidanceの出力(issue #249実装範囲3節の候補型そのもの)。`vectorX`/`vectorY`は
 * agent movement合成(ADR §1.4)へ加算する成分そのもの(既に`crowdMaxContribution`でclamp済み)。
 * `localDensity`/`crowded`は診断・テスト用の中間値であり、movement計算には`vectorX`/`vectorY`のみを使う。
 */
export type CrowdingAvoidanceResult = {
  vectorX: number;
  vectorY: number;
  magnitude: number;
  localDensity: number;
  crowded: boolean;
};

const ZERO_CROWDING_RESULT: CrowdingAvoidanceResult = {
  vectorX: 0,
  vectorY: 0,
  magnitude: 0,
  localDensity: 0,
  crowded: false,
};

/**
 * 密度計算に数える対象(issue #249「density source」節): undecided/approaching/forming/joined。
 * `leaving`/`left`/`unassigned`はここに含めないことで自然に除外される(allowlist方式)。
 * Issue #251: `spatialAnalysis.ts`の局所密度分布(read-only診断)が同じallowlistを再利用できるよう
 * exportする(`clusterSearchSelection.ts`が同じ定義を独立に再実装しているのと同じ事情だが、
 * こちらは循環importが無いため素直に共有する)。
 */
export function isCrowdingDensitySource(agent: Agent): boolean {
  return (
    agent.state === "undecided" ||
    agent.state === "approaching" ||
    agent.state === "forming" ||
    agent.state === "joined"
  );
}

/**
 * ADR §4.3: 自分自身、および(selfが`joined`/`approaching`等で`joinedGroupId`を持つ場合の)同じclusterの
 * memberは密度に数えない。selfが`joinedGroupId`を持たない(undecided等)場合はこの条件は発火しない。
 */
export function isSameClusterMember(self: Agent, other: Agent): boolean {
  return self.joinedGroupId !== undefined && other.joinedGroupId === self.joinedGroupId;
}

function normalizeAngleDiff(diff: number): number {
  const twoPi = Math.PI * 2;
  let a = diff % twoPi;
  if (a > Math.PI) a -= twoPi;
  if (a < -Math.PI) a += twoPi;
  return a;
}

/**
 * 局所crowding field(ADR §4.2): agent周囲を`crowdSampleDirections`方向へ扇形サンプリングし、
 * 距離重み付き密度が最も高い方向の逆側へ押す。§4.3の除外規則(自分自身/同clusterのmember/leaving・left)
 * に従い、他clusterのmember・undecided/approaching・重み付きcluster中心(`crowdClusterCenterWeight`)を
 * 密度source として数える。
 *
 * 密度がすべての方向で同じ(左右対称含む)なら、方向ごとの押し出し成分が打ち消し合い決定的に0になる。
 * `localDensity`(全方向合計)が`crowdDensityThreshold`以下なら寄与は0、超過分に応じて滑らかに増える
 * (issue #249実装範囲3節)。結果vectorは`crowdMaxContribution`で頭打ちにする。
 */
export function computeCrowdingVector(
  agent: Agent,
  agents: readonly Agent[],
  candidates: readonly GroupCandidate[],
  config: SpatialDynamicsConfig,
): CrowdingAvoidanceResult {
  if (!config.crowdingEnabled) return ZERO_CROWDING_RESULT;

  const directionCount = config.crowdSampleDirections;
  const densityByDirection = new Array<number>(directionCount).fill(0);

  const accumulate = (dx: number, dy: number, weight: number): void => {
    const d = Math.hypot(dx, dy);
    if (d <= 1e-9 || d >= config.crowdSampleRadius) return;
    const wDistance = 1 - d / config.crowdSampleRadius;
    const pointAngle = Math.atan2(dy, dx);
    for (let k = 0; k < directionCount; k++) {
      const dirAngle = (2 * Math.PI * k) / directionCount;
      const wAngle = Math.max(0, Math.cos(normalizeAngleDiff(pointAngle - dirAngle)));
      if (wAngle <= 0) continue;
      densityByDirection[k] += wDistance * wAngle * weight;
    }
  };

  for (const other of agents) {
    if (other.id === agent.id) continue;
    if (!isCrowdingDensitySource(other)) continue;
    if (isSameClusterMember(agent, other)) continue;
    accumulate(other.x - agent.x, other.y - agent.y, 1);
  }
  for (const cluster of candidates) {
    if (cluster.status !== "confirmed") continue;
    if (agent.joinedGroupId !== undefined && cluster.id === agent.joinedGroupId) continue;
    accumulate(cluster.x - agent.x, cluster.y - agent.y, config.crowdClusterCenterWeight);
  }

  let localDensity = 0;
  let pushX = 0;
  let pushY = 0;
  for (let k = 0; k < directionCount; k++) {
    const density = densityByDirection[k];
    if (density <= 0) continue;
    localDensity += density;
    const dirAngle = (2 * Math.PI * k) / directionCount;
    pushX -= density * Math.cos(dirAngle);
    pushY -= density * Math.sin(dirAngle);
  }

  if (localDensity <= 1e-9) return { ...ZERO_CROWDING_RESULT };

  const crowded = localDensity > config.crowdDensityThreshold;
  // threshold以下では寄与0、超過分(excess)の割合だけpush方向を保ったままscaleする
  // (`push`の向きは既に対称なら0になっているため、この係数は左右対称ケースの結果を変えない)。
  const excess = Math.max(0, localDensity - config.crowdDensityThreshold);
  const scale = (excess / localDensity) * config.crowdRepulsionStrength;
  let vectorX = pushX * scale;
  let vectorY = pushY * scale;

  let magnitude = Math.hypot(vectorX, vectorY);
  if (magnitude > config.crowdMaxContribution && magnitude > 0) {
    const capScale = config.crowdMaxContribution / magnitude;
    vectorX *= capScale;
    vectorY *= capScale;
    magnitude = config.crowdMaxContribution;
  }

  return { vectorX, vectorY, magnitude, localDensity, crowded };
}

// --- spatial occupancy diagnostics(計測専用grid、ADR §8.1/§8.4) -------------------------------

/**
 * 計測専用grid(ADR §8.1「この gridは計測専用であり、§4のcrowding fieldはこのgridを使わない」)。
 * §4のcrowding fieldとは完全に独立しており、Canvas描画のgridも参照しない(要件4)。
 */
export const SPATIAL_OCCUPANCY_GRID_COLS = 8;
export const SPATIAL_OCCUPANCY_GRID_ROWS = 5;

export type SpatialOccupancyGridSnapshot = {
  gridCols: number;
  gridRows: number;
  /** 指標8.1相当: このtickに1人以上いるcellの比率 */
  occupiedCells: RateWithDenominator;
  /** 指標8.4相当: cellごとの在場人数の分布(min/max/median/p90等) */
  cellOccupancy: DistributionSummary;
};

/**
 * occupancy計測に数えるagent(issue #249「left/unassigned/cleanup済みentityは含めない」)。
 * Issue #251: `spatialAnalysis.ts`のcentroid/radius of gyration計算が同じ定義を再利用するためexport。
 */
export function isPresentForOccupancy(agent: Agent): boolean {
  return agent.state !== "left" && agent.state !== "unassigned";
}

function clampCellIndex(index: number, count: number): number {
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

/**
 * 診断selector(issue #249実装範囲6節): 現在のagent座標から、毎tickの全cell情報をSimulationState.logへ
 * 保存せずオンデマンドで導出する軽量snapshot。`SimulationState`をmutationしない(read-only)。
 */
export function computeSpatialOccupancyGridSnapshot(
  agents: readonly Agent[],
  gridCols: number = SPATIAL_OCCUPANCY_GRID_COLS,
  gridRows: number = SPATIAL_OCCUPANCY_GRID_ROWS,
): SpatialOccupancyGridSnapshot {
  const cellCounts = new Array<number>(gridCols * gridRows).fill(0);
  for (const agent of agents) {
    if (!isPresentForOccupancy(agent)) continue;
    const col = clampCellIndex(Math.floor((agent.x / WORLD_WIDTH) * gridCols), gridCols);
    const row = clampCellIndex(Math.floor((agent.y / WORLD_HEIGHT) * gridRows), gridRows);
    cellCounts[row * gridCols + col] += 1;
  }
  const occupied = cellCounts.reduce((count, c) => count + (c > 0 ? 1 : 0), 0);
  return {
    gridCols,
    gridRows,
    occupiedCells: rateWithDenominator(occupied, cellCounts.length),
    cellOccupancy: summarizeDistribution(cellCounts),
  };
}
