/**
 * Issue #262 (Phase 7, standingParty): 料理台・ドリンク台の配置catalog。
 * 契約は `docs/standing-party-phase7-venue-anchors.md` §2・§9.1。
 *
 * `VenueAnchor` は会話clusterでも `GroupCandidate` でもない。`spatialRuntimeState` にも載せない。
 * 配置catalogとCanvas用コピーは #262。空腹・喉の渇きと訪問decisionの型は #263。
 * 目的移動・受け取りは #264。`enabled: false` のときは runtime 配列を作らない。
 */
import { distance, WORLD_HEIGHT, WORLD_WIDTH } from "./model";

export type VenueAnchorKind = "food" | "drink";

export type VenueAnchor = {
  id: string;
  kind: VenueAnchorKind;
  x: number;
  y: number;
  /** 到着と受け取り位置の半径。Canvasの当たり判定もこの値を正本にする */
  interactionRadius: number;
  /** receiving + consuming の同時人数上限。待ち行列ではない */
  capacity: number;
  /** receiving の滞在tick数 */
  serviceTicks: number;
  /** 表示用の短い名前。decisionは解析しない */
  label: string;
};

export type VenueAnchorConfig = {
  /** 既定 false。false なら anchors も encounter も実行時に読まない */
  enabled: boolean;
  /** 既定 false。#265 が true にするまで形成へ影響しない */
  encounterEnabled: boolean;
  anchors: VenueAnchor[];
  needs: {
    initialMin: number;
    initialMax: number;
    rateMin: number;
    rateMax: number;
    hungerGainPerTick: number;
    thirstGainPerTick: number;
    visitThreshold: number;
    needAfterRefill: number;
  };
  visit: {
    approachSpeed: number;
    consumeTicks: number;
    revisitCooldownTicks: number;
    failedVisitCooldownTicks: number;
    maxTravelTicks: number;
  };
  encounter: {
    windowTicks: number;
    radius: number;
    clusterClearance: number;
  };
};

/** #263: `VenueAnchorConfig.needs` の別名 */
export type VenueRefreshmentNeedConfig = VenueAnchorConfig["needs"];

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

/** Issue #264: 訪問を途中でやめた理由。待ち行列は作らず、同じtickで通常探索へ戻す */
export type VenueVisitAbandonReason = "anchorMissing" | "anchorAtCapacity" | "travelTimedOut" | "agentLeft";

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
  /**
   * Issue #265: 訪問を完了したtickとanchor。`encounterEnabled` のときだけ持つ。
   * 窓の外では通常の探索だけが働く。接触区間ではない。
   */
  encounterWindows?: Record<string, VenueEncounterWindow>;
  /**
   * Issue #265: 同じ組・同じphase・同じreasonの機会ログを繰り返さないための印。
   * シミュレーションの判断には使わない。
   */
  encounterSignals?: Record<string, true>;
};

/** Issue #265: 同じanchorで訪問を終えたあとの機会窓 */
export type VenueEncounterWindow = {
  anchorId: string;
  completedAtTick: number;
};

/** 機会を評価した時点の行動phase。取得前・取得後・訪問完了後 */
export type VenueEncounterPhase = "beforeObtain" | "afterObtain" | "postVisit";

/**
 * 機会ログの構造化理由。表示文言は解析しない。
 * `postVisitGreeting` だけが既存の会話形成/接近へ進む。
 */
export type VenueEncounterReason =
  | "serviceInProgress"
  | "postVisitGreeting"
  | "belowSocialThreshold"
  | "unavailable";

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
  /** Issue #264: 進行中訪問のphase。無ければ訪問していない */
  phase?: VenueVisitPhase;
  visitId?: string;
};

/** agentが到達できる会場範囲。`model.ts` の clamp `[5, W-5] × [5, H-5]` と揃える */
export const VENUE_ANCHOR_EDGE_MARGIN = 5;
export const VENUE_ANCHOR_MAX_INTERACTION_RADIUS = 80;
/** 任意の2台の中心がこれ未満なら拒否する */
export const VENUE_ANCHOR_MIN_CENTER_SEPARATION = 200;
/** `engine.ts` の `APPROACH_SPEED`。飲食の直進速度はこの値以下 */
export const VENUE_ANCHOR_MAX_APPROACH_SPEED = 14;

/**
 * 初期人口の抽選範囲(非cliqueがおおよそ x [80, 720)・y [78, 442))の外側、
 * 壁回避が効き始める 40px より内側。二点の距離は 200 以上。
 */
export const MVP_FOOD_ANCHOR: VenueAnchor = Object.freeze({
  id: "anchor:food-main",
  kind: "food",
  x: 72,
  y: 460,
  interactionRadius: 28,
  capacity: 3,
  serviceTicks: 4,
  label: "料理台",
});

export const MVP_DRINK_ANCHOR: VenueAnchor = Object.freeze({
  id: "anchor:drink-main",
  kind: "drink",
  x: 728,
  y: 60,
  interactionRadius: 28,
  capacity: 3,
  serviceTicks: 4,
  label: "ドリンク台",
});

export const MVP_VENUE_ANCHORS: readonly VenueAnchor[] = Object.freeze([
  MVP_FOOD_ANCHOR,
  MVP_DRINK_ANCHOR,
]);

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

/**
 * 既定の立食パーティーへ載せる、まだ無効な配置catalog。
 * `enabled: false` の間は state へコピーせず、Canvasにも描かない。
 */
export function standingPartyVenueCatalogConfig(): VenueAnchorConfig {
  return {
    ...DEFAULT_VENUE_ANCHOR_CONFIG,
    anchors: MVP_VENUE_ANCHORS.map((anchor) => ({ ...anchor })),
  };
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`venueAnchors: ${name} must be a finite number (got ${value})`);
  }
}

function assertIntegerAtLeast(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`venueAnchors: ${name} must be an integer >= ${minimum} (got ${value})`);
  }
}

/**
 * domain layerの最終防衛線。`enabled` が false でも、配列に要素があるなら同じ検証を通す。
 * UIの入力チェックだけには依存しない。
 */
export function validateVenueAnchorConfig(config: VenueAnchorConfig): void {
  const { needs, visit, encounter } = config;
  assertFinite("needs.initialMin", needs.initialMin);
  assertFinite("needs.initialMax", needs.initialMax);
  if (needs.initialMin < 0 || needs.initialMin > 1 || needs.initialMax < 0 || needs.initialMax > 1) {
    throw new Error(
      `venueAnchors: needs.initialMin/initialMax must be within [0, 1] (got ${needs.initialMin}, ${needs.initialMax})`,
    );
  }
  if (needs.initialMin >= needs.initialMax) {
    throw new Error(
      `venueAnchors: needs.initialMin (${needs.initialMin}) must be < initialMax (${needs.initialMax})`,
    );
  }
  assertFinite("needs.rateMin", needs.rateMin);
  assertFinite("needs.rateMax", needs.rateMax);
  if (needs.rateMin <= 0 || needs.rateMax <= 0 || needs.rateMin >= needs.rateMax) {
    throw new Error(
      `venueAnchors: needs.rateMin/rateMax must be > 0 and rateMin < rateMax (got ${needs.rateMin}, ${needs.rateMax})`,
    );
  }
  assertFinite("needs.hungerGainPerTick", needs.hungerGainPerTick);
  assertFinite("needs.thirstGainPerTick", needs.thirstGainPerTick);
  if (needs.hungerGainPerTick < 0 || needs.thirstGainPerTick < 0) {
    throw new Error(
      `venueAnchors: need gains must be >= 0 (got hunger ${needs.hungerGainPerTick}, thirst ${needs.thirstGainPerTick})`,
    );
  }
  assertFinite("needs.visitThreshold", needs.visitThreshold);
  if (needs.visitThreshold <= 0 || needs.visitThreshold > 1) {
    throw new Error(`venueAnchors: needs.visitThreshold must be within (0, 1] (got ${needs.visitThreshold})`);
  }
  assertFinite("needs.needAfterRefill", needs.needAfterRefill);
  if (needs.needAfterRefill < 0 || needs.needAfterRefill >= 1 || needs.needAfterRefill >= needs.visitThreshold) {
    throw new Error(
      `venueAnchors: needs.needAfterRefill must be within [0, 1) and < visitThreshold (got ${needs.needAfterRefill}, threshold ${needs.visitThreshold})`,
    );
  }

  assertFinite("visit.approachSpeed", visit.approachSpeed);
  if (visit.approachSpeed <= 0 || visit.approachSpeed > VENUE_ANCHOR_MAX_APPROACH_SPEED) {
    throw new Error(
      `venueAnchors: visit.approachSpeed must be within (0, ${VENUE_ANCHOR_MAX_APPROACH_SPEED}] (got ${visit.approachSpeed})`,
    );
  }
  assertIntegerAtLeast("visit.consumeTicks", visit.consumeTicks, 1);
  assertIntegerAtLeast("visit.revisitCooldownTicks", visit.revisitCooldownTicks, 1);
  assertIntegerAtLeast("visit.failedVisitCooldownTicks", visit.failedVisitCooldownTicks, 0);
  assertIntegerAtLeast("visit.maxTravelTicks", visit.maxTravelTicks, 1);
  assertIntegerAtLeast("encounter.windowTicks", encounter.windowTicks, 0);
  assertFinite("encounter.radius", encounter.radius);
  assertFinite("encounter.clusterClearance", encounter.clusterClearance);
  if (encounter.radius < 0 || encounter.clusterClearance < 0) {
    throw new Error(
      `venueAnchors: encounter.radius and clusterClearance must be >= 0 (got ${encounter.radius}, ${encounter.clusterClearance})`,
    );
  }

  const ids = new Set<string>();
  const minX = VENUE_ANCHOR_EDGE_MARGIN;
  const maxX = WORLD_WIDTH - VENUE_ANCHOR_EDGE_MARGIN;
  const minY = VENUE_ANCHOR_EDGE_MARGIN;
  const maxY = WORLD_HEIGHT - VENUE_ANCHOR_EDGE_MARGIN;
  for (const anchor of config.anchors) {
    if (typeof anchor.id !== "string" || anchor.id.trim().length === 0) {
      throw new Error("venueAnchors: anchor id must be a non-empty string");
    }
    if (ids.has(anchor.id)) {
      throw new Error(`venueAnchors: duplicate anchor id ${anchor.id}`);
    }
    ids.add(anchor.id);
    if (anchor.kind !== "food" && anchor.kind !== "drink") {
      throw new Error(`venueAnchors: anchor ${anchor.id} kind must be food or drink (got ${String(anchor.kind)})`);
    }
    assertFinite(`anchor ${anchor.id} x`, anchor.x);
    assertFinite(`anchor ${anchor.id} y`, anchor.y);
    assertFinite(`anchor ${anchor.id} interactionRadius`, anchor.interactionRadius);
    if (anchor.x < minX || anchor.x > maxX || anchor.y < minY || anchor.y > maxY) {
      throw new Error(
        `venueAnchors: anchor ${anchor.id} coordinates must be within [${minX}, ${maxX}] x [${minY}, ${maxY}] (got ${anchor.x}, ${anchor.y})`,
      );
    }
    if (anchor.interactionRadius <= 0 || anchor.interactionRadius > VENUE_ANCHOR_MAX_INTERACTION_RADIUS) {
      throw new Error(
        `venueAnchors: anchor ${anchor.id} interactionRadius must be within (0, ${VENUE_ANCHOR_MAX_INTERACTION_RADIUS}] (got ${anchor.interactionRadius})`,
      );
    }
    assertIntegerAtLeast(`anchor ${anchor.id} capacity`, anchor.capacity, 1);
    assertIntegerAtLeast(`anchor ${anchor.id} serviceTicks`, anchor.serviceTicks, 1);
    if (typeof anchor.label !== "string" || anchor.label.trim().length === 0) {
      throw new Error(`venueAnchors: anchor ${anchor.id} label must be a non-empty string`);
    }
    if (visit.approachSpeed > anchor.interactionRadius) {
      throw new Error(
        `venueAnchors: visit.approachSpeed (${visit.approachSpeed}) must be <= anchor ${anchor.id} interactionRadius (${anchor.interactionRadius})`,
      );
    }
  }
  for (let i = 0; i < config.anchors.length; i++) {
    for (let j = i + 1; j < config.anchors.length; j++) {
      const a = config.anchors[i];
      const b = config.anchors[j];
      const separation = distance(a.x, a.y, b.x, b.y);
      if (separation < VENUE_ANCHOR_MIN_CENTER_SEPARATION) {
        throw new Error(
          `venueAnchors: anchors ${a.id} and ${b.id} must be at least ${VENUE_ANCHOR_MIN_CENTER_SEPARATION} apart (got ${separation})`,
        );
      }
    }
  }
}

validateVenueAnchorConfig(DEFAULT_VENUE_ANCHOR_CONFIG);
validateVenueAnchorConfig({
  ...DEFAULT_VENUE_ANCHOR_CONFIG,
  enabled: true,
  anchors: MVP_VENUE_ANCHORS.map((anchor) => ({ ...anchor })),
});

/**
 * 詳細設定のオン/オフ。オンでcatalogが空なら初期MVPを入れる。オフでも配置配列は残す。
 * 座標オブジェクトは都度コピーし、定数 `MVP_VENUE_ANCHORS` を共有しない。
 */
export function venueAnchorConfigWithEnabled(config: VenueAnchorConfig, enabled: boolean): VenueAnchorConfig {
  const anchors =
    enabled && config.anchors.length === 0
      ? MVP_VENUE_ANCHORS.map((anchor) => ({ ...anchor }))
      : config.anchors.map((anchor) => ({ ...anchor }));
  return { ...config, enabled, anchors };
}

/**
 * standingPartyかつ `enabled` のときだけ、config上のcatalogをrun state用にコピーする。
 * 座標はconfigの値をそのまま使う。無効時・他scenarioでは `undefined`(配列を作らない)。
 */
export function venueAnchorsForRun(
  formationScenarioId: string | undefined,
  config: VenueAnchorConfig | undefined,
): VenueAnchor[] | undefined {
  if (formationScenarioId !== "standingParty" || !config?.enabled) return undefined;
  return config.anchors.map((anchor) => ({ ...anchor }));
}
