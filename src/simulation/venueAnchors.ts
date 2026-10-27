/**
 * Issue #263 (Phase 7, standingParty, roadmap #172): `docs/standing-party-phase7-venue-anchors.md`
 * (Issue #261 ADR)の型・検証・MVP配置。Canvas表示は #262、訪問の移動・取得は #264。
 *
 * 飲食欲求とdecisionは `stress` / 会話満足度 / 愛着 / `socialCirculationTendency` とは別概念で、
 * このファイルの型を介してだけ engine へ入る。anchorは `GroupCandidate` ではない。
 */
import { distance, WORLD_HEIGHT, WORLD_WIDTH } from "./model";

/** agentが到達できる座標の内側(engineのclampと同じ [5, W-5] × [5, H-5]) */
export const VENUE_AGENT_MARGIN = 5;
/** 任意の2anchorの中心距離の下限(ADR §2.2) */
export const VENUE_ANCHOR_MIN_SEPARATION = 200;
/** `interactionRadius` の上限(ADR §2.2) */
export const VENUE_ANCHOR_MAX_INTERACTION_RADIUS = 80;
/** 飲食の直進速度の上限。`APPROACH_SPEED`(14)と同じ値(ADR §7.1 / §9.1) */
export const VENUE_MAX_APPROACH_SPEED = 14;

export type VenueAnchorKind = "food" | "drink";

export type VenueAnchor = {
  id: string;
  kind: VenueAnchorKind;
  x: number;
  y: number;
  /** 到着と受け取り位置の半径 */
  interactionRadius: number;
  /** receiving + consuming の同時人数上限。待ち行列ではない */
  capacity: number;
  /** receiving の滞在tick数 */
  serviceTicks: number;
  /** 表示用の短い名前。decisionは解析しない */
  label: string;
};

export type VenueRefreshmentNeedConfig = {
  /** 初期hunger/thirstの下限(含む) */
  initialMin: number;
  /** 初期hunger/thirstの上限(含まない、`SeededRandom.range` の右端) */
  initialMax: number;
  rateMin: number;
  rateMax: number;
  hungerGainPerTick: number;
  thirstGainPerTick: number;
  visitThreshold: number;
  needAfterRefill: number;
};

export type VenueVisitConfig = {
  approachSpeed: number;
  consumeTicks: number;
  revisitCooldownTicks: number;
  /** 0を許す。成功時の `revisitCooldownTicks` とは別 */
  failedVisitCooldownTicks: number;
  maxTravelTicks: number;
};

export type VenueEncounterConfig = {
  windowTicks: number;
  radius: number;
  clusterClearance: number;
};

/**
 * `StandingPartyScenarioConfig` にだけ載せる(ADR §9.1)。`SimParams` には足さない。
 * `enabled: false`(既定)の実行経路はanchor配列もneedもeventも作らない。
 */
export type VenueAnchorConfig = {
  enabled: boolean;
  /** #265 が true にするまで形成へ影響しない。既定 false */
  encounterEnabled: boolean;
  anchors: VenueAnchor[];
  needs: VenueRefreshmentNeedConfig;
  visit: VenueVisitConfig;
  encounter: VenueEncounterConfig;
};

export const MVP_FOOD_ANCHOR: VenueAnchor = {
  id: "anchor:food-main",
  kind: "food",
  x: 72,
  y: 460,
  interactionRadius: 28,
  capacity: 3,
  serviceTicks: 4,
  label: "料理台",
};

export const MVP_DRINK_ANCHOR: VenueAnchor = {
  id: "anchor:drink-main",
  kind: "drink",
  x: 728,
  y: 60,
  interactionRadius: 28,
  capacity: 3,
  serviceTicks: 4,
  label: "ドリンク台",
};

export const MVP_VENUE_ANCHORS: readonly VenueAnchor[] = [MVP_FOOD_ANCHOR, MVP_DRINK_ANCHOR];

export const DEFAULT_VENUE_ANCHOR_CONFIG: VenueAnchorConfig = {
  enabled: false,
  encounterEnabled: false,
  anchors: [],
  needs: {
    initialMin: 0.05,
    initialMax: 0.35,
    rateMin: 0.85,
    rateMax: 1.15,
    hungerGainPerTick: 0.0032,
    thirstGainPerTick: 0.004,
    visitThreshold: 0.7,
    needAfterRefill: 0.15,
  },
  visit: {
    approachSpeed: 10,
    consumeTicks: 3,
    revisitCooldownTicks: 55,
    failedVisitCooldownTicks: 12,
    maxTravelTicks: 100,
  },
  encounter: { windowTicks: 8, radius: 48, clusterClearance: 20 },
};

export type AgentRefreshmentNeed = {
  hunger: number;
  thirst: number;
  hungerRate: number;
  thirstRate: number;
  /** このtick以上で、foodの新しい訪問を開始してよい */
  foodCooldownUntilTick?: number;
  /** このtick以上で、drinkの新しい訪問を開始してよい */
  drinkCooldownUntilTick?: number;
};

export type VenueVisitPhase = "traveling" | "receiving" | "consuming";

export type PendingVenueVisit = {
  visitId: string;
  anchorId: string;
  purpose: VenueAnchorKind;
  startedAtTick: number;
  phase: VenueVisitPhase;
  phaseEnteredAtTick: number;
  decisionReason: "selectedFood" | "selectedDrink";
};

export type VenueVisitDecisionAction =
  | "continueSocialActivity"
  | "continueExploration"
  | "startFoodVisit"
  | "startDrinkVisit"
  | "keepCurrentVisit";

export type VenueVisitDecisionReason =
  | "featureDisabled"
  | "notEligibleState"
  | "pendingSocialTransition"
  | "activeVenueVisit"
  | "minimumDwell"
  | "belowThreshold"
  | "revisitCooldown"
  | "noAnchor"
  | "anchorsAtCapacity"
  | "selectedFood"
  | "selectedDrink";

export type VenueVisitDecision = {
  action: VenueVisitDecisionAction;
  reason: VenueVisitDecisionReason;
  anchorId?: string;
  hunger: number;
  thirst: number;
  dwellTicks?: number;
  distance?: number;
};

export type VenueRuntimeState = {
  needs: Record<string, AgentRefreshmentNeed>;
  /** 進行中の訪問。無ければキーを置かない。`done` は保存しない */
  visits: Record<string, PendingVenueVisit>;
  /** Inspector用。直近のdecision。シミュレーションの入力にしない */
  lastDecisions?: Record<string, VenueVisitDecision>;
};

/**
 * Inspectorが読む、agent 1人分のneedと直近decision。閾値式は再計算しない。
 * runtimeにneedが無いagentでは undefined(0で埋めない)。
 */
export type VenueAgentReadout = {
  hunger: number;
  thirst: number;
  hungerRate: number;
  thirstRate: number;
  foodCooldownUntilTick?: number;
  drinkCooldownUntilTick?: number;
  action?: VenueVisitDecisionAction;
  reason?: VenueVisitDecisionReason;
  anchorId?: string;
};

export function isVenueAnchorsActive(formationScenarioId: string | undefined, config: VenueAnchorConfig): boolean {
  return formationScenarioId === "standingParty" && config.enabled;
}

function fail(message: string): never {
  throw new Error(`venueAnchors: ${message}`);
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) fail(`${name} must be finite (got ${value})`);
}

function assertRangeInclusive(name: string, value: number, min: number, max: number): void {
  assertFinite(name, value);
  if (value < min || value > max) fail(`${name} must be within [${min}, ${max}] (got ${value})`);
}

function assertInteger(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) fail(`${name} must be an integer >= ${min} (got ${value})`);
}

function assertAnchor(anchor: VenueAnchor, index: number): void {
  const prefix = `anchors[${index}]`;
  if (anchor.id.length === 0) fail(`${prefix}.id must be non-empty`);
  if (anchor.kind !== "food" && anchor.kind !== "drink") fail(`${prefix}.kind must be "food" or "drink"`);
  assertFinite(`${prefix}.x`, anchor.x);
  assertFinite(`${prefix}.y`, anchor.y);
  const minX = VENUE_AGENT_MARGIN;
  const maxX = WORLD_WIDTH - VENUE_AGENT_MARGIN;
  const minY = VENUE_AGENT_MARGIN;
  const maxY = WORLD_HEIGHT - VENUE_AGENT_MARGIN;
  if (anchor.x < minX || anchor.x > maxX || anchor.y < minY || anchor.y > maxY) {
    fail(`${prefix} coordinates must be inside [${minX}, ${maxX}] × [${minY}, ${maxY}] (got ${anchor.x}, ${anchor.y})`);
  }
  assertFinite(`${prefix}.interactionRadius`, anchor.interactionRadius);
  if (anchor.interactionRadius <= 0 || anchor.interactionRadius > VENUE_ANCHOR_MAX_INTERACTION_RADIUS) {
    fail(
      `${prefix}.interactionRadius must be within (0, ${VENUE_ANCHOR_MAX_INTERACTION_RADIUS}] (got ${anchor.interactionRadius})`,
    );
  }
  assertInteger(`${prefix}.capacity`, anchor.capacity, 1);
  assertInteger(`${prefix}.serviceTicks`, anchor.serviceTicks, 1);
  if (anchor.label.length === 0) fail(`${prefix}.label must be non-empty`);
}

/**
 * domain layerの検証。`enabled` が false でも、配列に要素があるなら同じ検証を通す。
 * UIの入力チェックだけには依存しない。
 */
export function validateVenueAnchorConfig(config: VenueAnchorConfig): void {
  if (typeof config.enabled !== "boolean") fail("enabled must be boolean");
  if (typeof config.encounterEnabled !== "boolean") fail("encounterEnabled must be boolean");
  if (!Array.isArray(config.anchors)) fail("anchors must be an array");

  const needs = config.needs;
  assertRangeInclusive("needs.initialMin", needs.initialMin, 0, 1);
  assertRangeInclusive("needs.initialMax", needs.initialMax, 0, 1);
  if (needs.initialMin >= needs.initialMax) {
    fail(`needs.initialMin (${needs.initialMin}) must be < needs.initialMax (${needs.initialMax})`);
  }
  assertFinite("needs.rateMin", needs.rateMin);
  assertFinite("needs.rateMax", needs.rateMax);
  if (needs.rateMin <= 0 || needs.rateMax <= 0 || needs.rateMin >= needs.rateMax) {
    fail(`needs.rateMin (${needs.rateMin}) must be > 0 and < needs.rateMax (${needs.rateMax})`);
  }
  assertFinite("needs.hungerGainPerTick", needs.hungerGainPerTick);
  assertFinite("needs.thirstGainPerTick", needs.thirstGainPerTick);
  if (needs.hungerGainPerTick < 0 || needs.thirstGainPerTick < 0) {
    fail("needs.hungerGainPerTick and needs.thirstGainPerTick must be >= 0");
  }
  assertFinite("needs.visitThreshold", needs.visitThreshold);
  if (needs.visitThreshold <= 0 || needs.visitThreshold > 1) {
    fail(`needs.visitThreshold must be within (0, 1] (got ${needs.visitThreshold})`);
  }
  assertRangeInclusive("needs.needAfterRefill", needs.needAfterRefill, 0, 1);
  if (needs.needAfterRefill >= 1 || needs.needAfterRefill >= needs.visitThreshold) {
    fail(
      `needs.needAfterRefill (${needs.needAfterRefill}) must be < 1 and < needs.visitThreshold (${needs.visitThreshold})`,
    );
  }

  const visit = config.visit;
  assertFinite("visit.approachSpeed", visit.approachSpeed);
  if (visit.approachSpeed <= 0 || visit.approachSpeed > VENUE_MAX_APPROACH_SPEED) {
    fail(`visit.approachSpeed must be within (0, ${VENUE_MAX_APPROACH_SPEED}] (got ${visit.approachSpeed})`);
  }
  assertInteger("visit.consumeTicks", visit.consumeTicks, 1);
  assertInteger("visit.revisitCooldownTicks", visit.revisitCooldownTicks, 1);
  assertInteger("visit.failedVisitCooldownTicks", visit.failedVisitCooldownTicks, 0);
  assertInteger("visit.maxTravelTicks", visit.maxTravelTicks, 1);

  const encounter = config.encounter;
  assertInteger("encounter.windowTicks", encounter.windowTicks, 0);
  assertFinite("encounter.radius", encounter.radius);
  assertFinite("encounter.clusterClearance", encounter.clusterClearance);
  if (encounter.radius < 0 || encounter.clusterClearance < 0) {
    fail("encounter.radius and encounter.clusterClearance must be >= 0");
  }

  const seen = new Set<string>();
  config.anchors.forEach((anchor, index) => {
    assertAnchor(anchor, index);
    if (seen.has(anchor.id)) fail(`anchors[${index}].id duplicates ${anchor.id}`);
    seen.add(anchor.id);
    if (visit.approachSpeed > anchor.interactionRadius) {
      fail(
        `visit.approachSpeed (${visit.approachSpeed}) must be <= anchors[${index}].interactionRadius (${anchor.interactionRadius})`,
      );
    }
  });
  for (let i = 0; i < config.anchors.length; i++) {
    for (let j = i + 1; j < config.anchors.length; j++) {
      const a = config.anchors[i];
      const b = config.anchors[j];
      const separation = distance(a.x, a.y, b.x, b.y);
      if (separation < VENUE_ANCHOR_MIN_SEPARATION) {
        fail(`anchors ${a.id} and ${b.id} are ${separation} apart; minimum is ${VENUE_ANCHOR_MIN_SEPARATION}`);
      }
    }
  }
}

validateVenueAnchorConfig(DEFAULT_VENUE_ANCHOR_CONFIG);
