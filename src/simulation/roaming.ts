/**
 * Issue #248 (Phase 6, standingParty, roadmap #172): `docs/spatial-dynamics-phase6-model.md`
 * (Issue #246 ADR)の§3(persistent roaming)+§1.4(agent movement vectorの合成・agent wall avoidance)に
 * 基づく、target未確定(`state === "undecided"`)なagentのheading保持型movementの純粋関数群。
 *
 * 本Issueのスコープは同ADR§12のP6-C相当のうち roaming + agent wall avoidance のみ。local crowding
 * field(#249)、候補選択の一般化(#250)は対象外(issue #248「対象外」節)。cluster側の斥力・wall
 * avoidance・member追従は#247実装済みの`spatialDynamics.ts`が担う(責務分離、ADR§1.3)。
 *
 * 決定性: heading初期化・更新は主系列`SeededRandom`と独立した派生stream(`createSpatialRandom`)のみを
 * 消費する(ADR§9.3)。roaming vector・wall avoidance・vector合成そのものはrngを一切消費しない。
 */
import type { Agent } from "./types";
import { SeededRandom } from "./random";
import { clamp, distance, WORLD_WIDTH, WORLD_HEIGHT } from "./model";
import type { SpatialDynamicsConfig } from "./spatialDynamics";

// --- runtime state ------------------------------------------------------------------------------

/**
 * `SimulationState.spatialRuntimeState.roaming`(ADR§9.2)。agentごとに保持される一時的なheading。
 * `expiresAtTick`未満のtickではheadingを引き直さない(ADR§3.2「毎tick独立のランダムwalkは避ける」)。
 */
export type RoamingState = {
  headingRadians: number;
  expiresAtTick: number;
};

export type RoamingRuntimeState = Record<string, RoamingState>;

/** 診断selector(issue実装範囲7節): 指定agentの現在のroaming state。未追跡ならundefined */
export function getRoamingState(
  roaming: RoamingRuntimeState | undefined,
  agentId: string,
): RoamingState | undefined {
  return roaming?.[agentId];
}

/** 診断selector(issue実装範囲7節「roaming開始tick・残りtick」): このtick時点での残りhold tick数 */
export function roamingTicksRemaining(state: RoamingState, tick: number): number {
  return Math.max(0, state.expiresAtTick - tick);
}

// --- 決定的な派生rng -----------------------------------------------------------------------------

/** FNV-1a風の単純な文字列ハッシュ(`spatialDynamics.ts`/`schoolInterventionRuntime.ts`と同じ表現専用パターン) */
function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * roaming専用rngを、本体`SeededRandom`とは独立に導出する(ADR§9.3「roamingのrngは主系列と独立の
 * 派生stream」)。`createInterventionRandom`/`createInformationRandom`と同じ方式であり、この関数自体は
 * 本体`rng`を一切読み書きしない。同一`runSeed`・`agentId`・`tick`なら常に同じ乱数系列になるため、
 * agents配列の処理順に依存しない(ADR§6.3「agents配列順への依存を作らない」と同じ思想)。
 */
export function createSpatialRandom(runSeed: number, stage: string, agentId: string, tick: number): SeededRandom {
  return new SeededRandom(hashString(`${runSeed}:spatialDynamics:${stage}:${agentId}:${tick}`));
}

function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a > Math.PI) a -= twoPi;
  if (a < -Math.PI) a += twoPi;
  return a;
}

/**
 * ADR§3.2: headingは`[headingHoldTicksMin, headingHoldTicksMax]`の間維持し、期限が切れたtickでのみ
 * 前回headingからの摂動(`±headingNoiseRadians`)として更新する(全方位への再抽選はしない。軌跡を
 * 滑らかにするため)。初回(`previous === undefined`)のみ全方位から一様に抽選する。
 */
export function advanceRoamingHeading(
  previous: RoamingState | undefined,
  agentId: string,
  tick: number,
  runSeed: number,
  config: SpatialDynamicsConfig,
): RoamingState {
  if (previous !== undefined && tick < previous.expiresAtTick) return previous;

  const rng = createSpatialRandom(runSeed, "roaming", agentId, tick);
  const headingRadians =
    previous !== undefined
      ? normalizeAngle(
          previous.headingRadians + rng.range(-config.roamingHeadingNoiseRadians, config.roamingHeadingNoiseRadians),
        )
      : rng.range(-Math.PI, Math.PI);
  const holdTicks = rng.int(config.roamingHeadingHoldTicksMin, config.roamingHeadingHoldTicksMax);
  return { headingRadians, expiresAtTick: tick + Math.max(1, holdTicks) };
}

// --- roaming強度 ---------------------------------------------------------------------------------

/**
 * ADR§3.3: `socialCirculationTendency`(#188、離脱しやすさの意味は変更しない)を読み取り専用の
 * 補助係数として再利用する。未設定(テストが直接`Agent`を構築する場合等)は既存慣習どおり`0.5`へ
 * フォールバックする。`circulationRoamingWeight = 0`ならroamingは全agent一様(`roamingIntensityBase`)になる。
 */
export function roamingIntensity(agent: Agent, config: SpatialDynamicsConfig): number {
  const tendency = agent.socialCirculationTendency ?? 0.5;
  return clamp(config.roamingIntensityBase + config.roamingCirculationWeight * tendency, 0, 1);
}

// --- agent wall avoidance -------------------------------------------------------------------------

/**
 * agent側のwall avoidance(ADR§1.4)。cluster側(`spatialDynamics.ts`の`computeWallAvoidanceForce`)と
 * 同じ「境界手前から内向きに滑らかに強くなる線形寄与」だが、agent専用のconfig値
 * (`agentWallAvoidanceDistance`/`agentWallAvoidanceStrength`/`agentWallMaxContribution`)を使う
 * (cluster movement=maxClusterCenterSpeedとagent roaming=roamingSpeedでは速度スケールが異なるため、
 * wall avoidanceの強さも独立に調整できるようにする)。角では両軸の寄与が加算され対角方向へ押し返される。
 */
export function computeAgentWallAvoidanceForce(
  point: { x: number; y: number },
  config: SpatialDynamicsConfig,
): { fx: number; fy: number } {
  const margin = config.agentWallAvoidanceDistance;
  let fx = 0;
  let fy = 0;

  const distLeft = point.x;
  if (distLeft < margin) fx += config.agentWallAvoidanceStrength * (1 - distLeft / margin);
  const distRight = WORLD_WIDTH - point.x;
  if (distRight < margin) fx -= config.agentWallAvoidanceStrength * (1 - distRight / margin);
  const distTop = point.y;
  if (distTop < margin) fy += config.agentWallAvoidanceStrength * (1 - distTop / margin);
  const distBottom = WORLD_HEIGHT - point.y;
  if (distBottom < margin) fy -= config.agentWallAvoidanceStrength * (1 - distBottom / margin);

  const magnitude = Math.hypot(fx, fy);
  if (magnitude > config.agentWallMaxContribution && magnitude > 0) {
    const scale = config.agentWallMaxContribution / magnitude;
    fx *= scale;
    fy *= scale;
  }
  return { fx, fy };
}

// --- vector合成・座標更新 -------------------------------------------------------------------------

/** ADR§1.4手順1: headingとintensityから、roamingSpeedで頭打ちにしたroaming vectorを計算する */
export function computeRoamingVector(
  headingRadians: number,
  intensity: number,
  config: SpatialDynamicsConfig,
): { dx: number; dy: number } {
  const speed = config.roamingSpeed * clamp(intensity, 0, 1);
  return { dx: Math.cos(headingRadians) * speed, dy: Math.sin(headingRadians) * speed };
}

/**
 * ADR§1.4の合成順序(成分ごとにclamp → 加算 → 合成vectorを速度上限でclamp → 座標をworld境界へclamp)に
 * 従い、1体のundecided agentを1tick分動かす。`intensity`を`0`にすればroaming寄与だけが消え、
 * wall avoidanceは引き続き適用される(ADR§3.4「pendingClusterTransitionを持つ間はroaming寄与を0にする」)。
 */
export function applyAgentRoamingStep(
  agent: Agent,
  heading: RoamingState,
  intensity: number,
  config: SpatialDynamicsConfig,
): void {
  const roam = computeRoamingVector(heading.headingRadians, intensity, config);
  const wall = computeAgentWallAvoidanceForce(agent, config);

  let dx = roam.dx + wall.fx;
  let dy = roam.dy + wall.fy;
  const speed = Math.hypot(dx, dy);
  if (speed > config.maxAgentSpeed && speed > 0) {
    const scale = config.maxAgentSpeed / speed;
    dx *= scale;
    dy *= scale;
  }

  agent.x = clamp(agent.x + dx, 5, WORLD_WIDTH - 5);
  agent.y = clamp(agent.y + dy, 5, WORLD_HEIGHT - 5);
}

/** 診断selector(issue実装範囲7節「cumulative roaming distance」の前段): 1tickの実際の移動距離 */
export function movementDistance(before: { x: number; y: number }, after: { x: number; y: number }): number {
  return distance(before.x, before.y, after.x, after.y);
}
