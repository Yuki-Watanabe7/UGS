/**
 * Issue #247 (Phase 6, standingParty, roadmap #172): `docs/spatial-dynamics-phase6-model.md`
 * (Issue #246 ADR)の§2(cluster空間力学)に基づく、confirmed cluster間の斥力・wall avoidanceと、
 * それによるcluster center移動・joined member追従の純粋関数群。
 *
 * 本Issueのスコープは同ADR§12のP6-A(config/runtime state)+P6-B(cluster movement)のみ。
 * agent roaming/local crowding field(P6-C)、cluster候補選択の一般化(P6-D)、
 * `assertStandingPartyInvariants`への空間不変条件の統合(P6-E)、空間指標の実装(P6-F)は
 * いずれも対象外(issue #247「対象外」節、ADR§12の後続Issue)。
 *
 * 決定性: cluster movement(斥力・wall avoidance・velocity更新・member追従)はrngを一切消費しない
 * (ADR§2.5「cluster movementはrngを消費しない」)。同一入力からは常に同一出力になる純粋関数のみで
 * 構成し、`candidates`/`agents`をmutationしない(呼び出し側=engine.tsが返り値を使って更新する)。
 */
import type { Agent, GroupCandidate } from "./types";
import { clamp, distance, WORLD_WIDTH, WORLD_HEIGHT } from "./model";

// --- config -----------------------------------------------------------------------------------

export type SpatialDynamicsConfig = {
  /** Issue #247: standingParty全体でのspatial dynamicsの有効/無効。既定false(既存挙動を維持) */
  enabled: boolean;
  /** cluster間斥力そのものの有効/無効。`enabled: true`でもこれをfalseにすればwall avoidanceのみ働く */
  clusterRepulsionEnabled: boolean;
  /** これ以上離れたcluster対には斥力の寄与が厳密に0になる有限range(ADR§2.4) */
  repulsionRadius: number;
  /** これ未満の距離では線形減衰(ADR式)に加えて追加のより強い押し離しが働く、望ましい間隔 */
  preferredClusterSeparation: number;
  /** 斥力の強さの基準値 */
  repulsionStrength: number;
  /**
   * `repulsionRadius`の外側で寄与が0のままoscillationしないための余裕(ADR§2.4)。
   * 本実装の線形減衰式自体は連続(境界で自然に0へ収束する)なため、診断用途
   * (`isClusterOverlapping`等)の判定余白としてのみ使う。
   */
  hysteresisMargin: number;
  /** 前tickのvelocityをどれだけ持ち越すか(ADR§2.2)。[0,1) */
  damping: number;
  /** 1tickでcluster中心が動ける最大距離(ADR§2.2)。`APPROACH_SPEED`未満に保つ */
  maxClusterCenterSpeed: number;
  /** joined memberが中心の移動へ1tickで追従できる最大距離(ADR§2.6)。`maxClusterCenterSpeed`以下 */
  maxMemberFollowStep: number;
  /** 中心間距離がこれ未満のcluster対を「重複/過密」とみなす診断閾値(指標8.5相当) */
  overlapThreshold: number;
  /** wall avoidanceが効き始める、境界からの距離 */
  wallAvoidanceDistance: number;
  /** wall avoidanceの強さの基準値 */
  wallAvoidanceStrength: number;
  /** wall avoidance由来の寄与の上限(角で両軸が加算されても発散しないようclampする) */
  wallMaxContribution: number;
};

export const DEFAULT_SPATIAL_DYNAMICS_CONFIG: SpatialDynamicsConfig = {
  enabled: false,
  clusterRepulsionEnabled: true,
  repulsionRadius: 120,
  preferredClusterSeparation: 80,
  repulsionStrength: 1.4,
  hysteresisMargin: 0.1,
  damping: 0.6,
  maxClusterCenterSpeed: 2,
  maxMemberFollowStep: 2,
  overlapThreshold: 60,
  wallAvoidanceDistance: 40,
  wallAvoidanceStrength: 1.2,
  wallMaxContribution: 2,
};

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`spatialDynamics config: ${name} must be a finite number (got ${value})`);
  }
}

function assertPositive(name: string, value: number): void {
  assertFinite(name, value);
  if (value <= 0) {
    throw new Error(`spatialDynamics config: ${name} must be > 0 (got ${value})`);
  }
}

function assertNonNegative(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0) {
    throw new Error(`spatialDynamics config: ${name} must be >= 0 (got ${value})`);
  }
}

function assertRange01(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0 || value > 1) {
    throw new Error(`spatialDynamics config: ${name} must be within [0, 1] (got ${value})`);
  }
}

/**
 * NaN/Infinity・範囲外・不正な大小関係を明示的に拒否する(既存の`validateAlternativeClusterInterestConfig`
 * 等と同じ方針。UI側の入力検証に頼らず、domain layerを最終防衛線にする)。
 */
export function validateSpatialDynamicsConfig(config: SpatialDynamicsConfig): void {
  assertPositive("repulsionRadius", config.repulsionRadius);
  assertPositive("preferredClusterSeparation", config.preferredClusterSeparation);
  if (config.preferredClusterSeparation > config.repulsionRadius) {
    throw new Error(
      `spatialDynamics config: preferredClusterSeparation (${config.preferredClusterSeparation}) must be <= repulsionRadius (${config.repulsionRadius})`,
    );
  }
  assertNonNegative("repulsionStrength", config.repulsionStrength);
  assertRange01("hysteresisMargin", config.hysteresisMargin);
  if (config.damping < 0 || config.damping >= 1) {
    throw new Error(`spatialDynamics config: damping must be within [0, 1) (got ${config.damping})`);
  }
  assertPositive("maxClusterCenterSpeed", config.maxClusterCenterSpeed);
  assertPositive("maxMemberFollowStep", config.maxMemberFollowStep);
  if (config.maxMemberFollowStep > config.maxClusterCenterSpeed) {
    throw new Error(
      `spatialDynamics config: maxMemberFollowStep (${config.maxMemberFollowStep}) must be <= maxClusterCenterSpeed (${config.maxClusterCenterSpeed})`,
    );
  }
  assertPositive("overlapThreshold", config.overlapThreshold);
  assertPositive("wallAvoidanceDistance", config.wallAvoidanceDistance);
  assertNonNegative("wallAvoidanceStrength", config.wallAvoidanceStrength);
  assertPositive("wallMaxContribution", config.wallMaxContribution);
}

validateSpatialDynamicsConfig(DEFAULT_SPATIAL_DYNAMICS_CONFIG);

// --- runtime state ------------------------------------------------------------------------------

export type ClusterVelocity = { vx: number; vy: number };

/**
 * `SimulationState.spatialRuntimeState`(ADR§9.2)。`interventionRuntimeState`(#156)と同じ
 * 「tick間のfall backパターン」に従い、呼び出し側が毎tick渡し忘れても直前の値を引き継ぐ。
 * disabled中は`undefined`のまま(既存の記録shapeで「空」と「未使用」を区別する方針を踏襲)。
 */
export type SpatialRuntimeState = {
  clusterVelocity: Record<string, ClusterVelocity>;
};

export function createInitialSpatialRuntimeState(): SpatialRuntimeState {
  return { clusterVelocity: {} };
}

const ZERO_VELOCITY: ClusterVelocity = { vx: 0, vy: 0 };

/** 診断selector(issue #247 実装範囲7節): 指定clusterの現在velocity。未追跡なら静止(0,0)として返す */
export function getClusterVelocity(
  runtimeState: SpatialRuntimeState | undefined,
  clusterId: string,
): ClusterVelocity {
  return runtimeState?.clusterVelocity[clusterId] ?? ZERO_VELOCITY;
}

/**
 * cluster cleanup(候補配列からの除去、または`confirmed`以外への遷移)に追従して、対応する
 * velocity entryを必ず削除する(ADR§2.3「dissolving開始後は新たな斥力移動を停止」+
 * §9.2「消滅したclusterのvelocityは対応するentityの除去と同じtickに削除する」)。
 */
export function pruneSpatialRuntimeState(
  runtimeState: SpatialRuntimeState,
  candidates: readonly GroupCandidate[],
): SpatialRuntimeState {
  const activeIds = new Set(candidates.filter((c) => c.status === "confirmed").map((c) => c.id));
  const clusterVelocity: Record<string, ClusterVelocity> = {};
  for (const [id, velocity] of Object.entries(runtimeState.clusterVelocity)) {
    if (activeIds.has(id)) clusterVelocity[id] = velocity;
  }
  return { clusterVelocity };
}

// --- 決定的な完全重複時fallback -----------------------------------------------------------------

/** FNV-1a風の単純な文字列ハッシュ(`schoolInterventionRuntime.ts`/`model.ts`と同じ表現専用パターン) */
function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * cluster中心が完全重複(距離0近傍)した場合の、rng非消費・決定的な分離方向(ADR§2.4)。
 * `id`の辞書順で正規化した組から角度を1つ導出し、順序を入れ替えて呼べば厳密に逆向きになる
 * ことを保証する(pairwise力の作用・反作用の整合性、issue実装範囲2節)。
 */
export function deterministicSeparationDirection(idA: string, idB: string): { ux: number; uy: number } {
  const lo = idA < idB ? idA : idB;
  const hi = idA < idB ? idB : idA;
  const angle = ((hashString(`${lo}:${hi}`) % 3600) / 3600) * 2 * Math.PI;
  const resolvedAngle = idA === lo ? angle : angle + Math.PI;
  return { ux: Math.cos(resolvedAngle), uy: Math.sin(resolvedAngle) };
}

// --- pairwise repulsion ---------------------------------------------------------------------

const ZERO_FORCE = { fx: 0, fy: 0 };

/**
 * clusterBが及ぼす、clusterAに対する斥力(ADR§2.4)。距離が`repulsionRadius`以上なら厳密に0。
 * `preferredClusterSeparation`未満では追加のより強い押し離し項を加える(issue実装範囲2節)。
 * 距離0近傍でも`deterministicSeparationDirection`によりNaN/Infinityを発生させない。
 */
export function computeClusterRepulsionForce(
  a: GroupCandidate,
  b: GroupCandidate,
  config: SpatialDynamicsConfig,
): { fx: number; fy: number } {
  const d = distance(a.x, a.y, b.x, b.y);
  if (d >= config.repulsionRadius) return ZERO_FORCE;

  const EPSILON = 1e-6;
  let ux: number;
  let uy: number;
  if (d > EPSILON) {
    ux = (a.x - b.x) / d;
    uy = (a.y - b.y) / d;
  } else {
    const dir = deterministicSeparationDirection(a.id, b.id);
    ux = dir.ux;
    uy = dir.uy;
  }

  const outerMagnitude = config.repulsionStrength * (1 - d / config.repulsionRadius);
  const innerMagnitude =
    d < config.preferredClusterSeparation
      ? config.repulsionStrength * (1 - d / config.preferredClusterSeparation)
      : 0;
  const magnitude = outerMagnitude + innerMagnitude;
  return { fx: ux * magnitude, fy: uy * magnitude };
}

/** 診断selector: clusterに最も近い他clusterまでの距離。他にactive clusterがなければundefined */
export function nearestClusterDistance(
  cluster: GroupCandidate,
  others: readonly GroupCandidate[],
): number | undefined {
  let nearest: number | undefined;
  for (const other of others) {
    if (other.id === cluster.id) continue;
    const d = distance(cluster.x, cluster.y, other.x, other.y);
    if (nearest === undefined || d < nearest) nearest = d;
  }
  return nearest;
}

/** 診断selector(issue実装範囲7節「crowded/separated判定」): 指標8.5相当のoverlap判定 */
export function isClusterOverlapping(
  cluster: GroupCandidate,
  others: readonly GroupCandidate[],
  config: SpatialDynamicsConfig,
): boolean {
  const nearest = nearestClusterDistance(cluster, others);
  return nearest !== undefined && nearest < config.overlapThreshold;
}

// --- wall avoidance --------------------------------------------------------------------------

/**
 * cluster中心のwall avoidance(ADR§1.4/§2.2)。境界から`wallAvoidanceDistance`以内にいるとき
 * 会場内側へ線形の寄与を与える。角(2辺が同時に近い)では両軸の寄与が加算され対角方向へ押し返される。
 * `wallMaxContribution`で寄与の大きさを頭打ちにする(発散しない)。
 */
export function computeWallAvoidanceForce(
  cluster: GroupCandidate,
  config: SpatialDynamicsConfig,
): { fx: number; fy: number } {
  const margin = config.wallAvoidanceDistance;
  let fx = 0;
  let fy = 0;

  const distLeft = cluster.x;
  if (distLeft < margin) fx += config.wallAvoidanceStrength * (1 - distLeft / margin);
  const distRight = WORLD_WIDTH - cluster.x;
  if (distRight < margin) fx -= config.wallAvoidanceStrength * (1 - distRight / margin);
  const distTop = cluster.y;
  if (distTop < margin) fy += config.wallAvoidanceStrength * (1 - distTop / margin);
  const distBottom = WORLD_HEIGHT - cluster.y;
  if (distBottom < margin) fy -= config.wallAvoidanceStrength * (1 - distBottom / margin);

  const magnitude = Math.hypot(fx, fy);
  if (magnitude > config.wallMaxContribution && magnitude > 0) {
    const scale = config.wallMaxContribution / magnitude;
    fx *= scale;
    fy *= scale;
  }
  return { fx, fy };
}

// --- velocity / center movement -----------------------------------------------------------------

/** ADR§2.2: `velocity(t) = clamp(damping * velocity(t-1) + force, maxClusterCenterSpeed)` */
export function advanceClusterVelocity(
  previous: ClusterVelocity | undefined,
  force: { fx: number; fy: number },
  config: SpatialDynamicsConfig,
): ClusterVelocity {
  const vx = (previous?.vx ?? 0) * config.damping + force.fx;
  const vy = (previous?.vy ?? 0) * config.damping + force.fy;
  const speed = Math.hypot(vx, vy);
  if (speed > config.maxClusterCenterSpeed && speed > 0) {
    const scale = config.maxClusterCenterSpeed / speed;
    return { vx: vx * scale, vy: vy * scale };
  }
  return { vx, vy };
}

// step 4(forming候補の中心微調整)と同じclamp範囲(ADR§1.1「この2つの境界定義を変更しない」)
const CLUSTER_CENTER_MARGIN = 20;

/** cluster中心をvelocity分だけ動かし、world境界内へclampする(ADR§2.2、SP-3/SP-5相当) */
export function moveClusterCenter(cluster: GroupCandidate, velocity: ClusterVelocity): void {
  cluster.x = clamp(cluster.x + velocity.vx, CLUSTER_CENTER_MARGIN, WORLD_WIDTH - CLUSTER_CENTER_MARGIN);
  cluster.y = clamp(cluster.y + velocity.vy, CLUSTER_CENTER_MARGIN, WORLD_HEIGHT - CLUSTER_CENTER_MARGIN);
}

// --- joined member follow -------------------------------------------------------------------

/**
 * ADR§2.6: 中心の移動分をmemberへteleportさせず、相対配置を保った理想位置へ
 * `maxMemberFollowStep`を上限に近づける。`joined`かつ、このtickに実際に動いた(=`centersBefore`に
 * 記録がある)activeなclusterのmemberのみ対象(forming候補へjoined中のagentは対象外)。
 */
export function applyMemberFollow(
  agents: Agent[],
  activeClusters: readonly GroupCandidate[],
  centersBefore: ReadonlyMap<string, { x: number; y: number }>,
  config: SpatialDynamicsConfig,
): void {
  const clusterById = new Map(activeClusters.map((c) => [c.id, c] as const));
  for (const agent of agents) {
    if (agent.state !== "joined" || agent.joinedGroupId === undefined) continue;
    const clusterAfter = clusterById.get(agent.joinedGroupId);
    const before = centersBefore.get(agent.joinedGroupId);
    if (!clusterAfter || !before) continue;

    const offsetX = agent.x - before.x;
    const offsetY = agent.y - before.y;
    const desiredX = clusterAfter.x + offsetX;
    const desiredY = clusterAfter.y + offsetY;
    const dx = desiredX - agent.x;
    const dy = desiredY - agent.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 1e-9) continue;

    const step = Math.min(dist, config.maxMemberFollowStep);
    agent.x = clamp(agent.x + (dx / dist) * step, 5, WORLD_WIDTH - 5);
    agent.y = clamp(agent.y + (dy / dist) * step, 5, WORLD_HEIGHT - 5);
  }
}

// --- 統合エントリポイント ----------------------------------------------------------------------

export type ClusterSpatialDynamicsResult = {
  clusterVelocity: Record<string, ClusterVelocity>;
};

/**
 * engine.tsのtick順序(ADR§6.1 S1〜S4)から1回だけ呼ばれる統合関数。
 * - S1: `candidates`はこのtick開始時点のスナップショット(呼び出し前の状態)として扱う
 * - S2: confirmed cluster間の斥力(id昇順へ安定ソートしてから計算するため、`candidates`配列の
 *   元の順序に結果が依存しない、issue実装範囲2節「candidates配列順で結果が変わらない」)
 * - S3: damping付きvelocityで中心を移動(rng非消費)
 * - S4: joined memberの追従補正
 *
 * `candidates`/`agents`はこの関数の呼び出しによりin-place更新される(呼び出し側が`.map(c => ({...c}))`
 * 等で既にコピー済みの配列を渡す、既存`stepSimulation`の慣習に従う)。
 */
export function applyClusterSpatialDynamics(
  candidates: GroupCandidate[],
  agents: Agent[],
  config: SpatialDynamicsConfig,
  previousVelocity: Record<string, ClusterVelocity>,
): ClusterSpatialDynamicsResult {
  const activeClusters = candidates
    .filter((c) => c.status === "confirmed")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const forces = new Map<string, { fx: number; fy: number }>();
  for (const cluster of activeClusters) forces.set(cluster.id, { fx: 0, fy: 0 });

  if (config.clusterRepulsionEnabled) {
    for (let i = 0; i < activeClusters.length; i++) {
      for (let j = i + 1; j < activeClusters.length; j++) {
        const a = activeClusters[i];
        const b = activeClusters[j];
        const pair = computeClusterRepulsionForce(a, b, config);
        if (pair.fx === 0 && pair.fy === 0) continue;
        const fa = forces.get(a.id)!;
        fa.fx += pair.fx;
        fa.fy += pair.fy;
        const fb = forces.get(b.id)!;
        fb.fx -= pair.fx;
        fb.fy -= pair.fy;
      }
    }
  }

  const centersBefore = new Map(activeClusters.map((c) => [c.id, { x: c.x, y: c.y }] as const));
  const nextVelocity: Record<string, ClusterVelocity> = {};
  for (const cluster of activeClusters) {
    const wall = computeWallAvoidanceForce(cluster, config);
    const repulsion = forces.get(cluster.id)!;
    const totalForce = { fx: repulsion.fx + wall.fx, fy: repulsion.fy + wall.fy };
    const velocity = advanceClusterVelocity(previousVelocity[cluster.id], totalForce, config);
    nextVelocity[cluster.id] = velocity;
    moveClusterCenter(cluster, velocity);
  }

  applyMemberFollow(agents, activeClusters, centersBefore, config);

  return { clusterVelocity: nextVelocity };
}
