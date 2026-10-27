/**
 * Issue #263 (Phase 7, standingParty): 空腹・喉の渇きの初期化とtick増分、補充後の低下。
 *
 * `docs/standing-party-phase7-venue-anchors.md` §3。個体差の初期化だけが、主系列とは独立した
 * 派生streamを1agentにつき4回消費する。増分・補充・cooldownの書き込みはrngを使わない。
 * 愛着や会話満足度は掛けない。feature OFFのとき engine はこのモジュールを呼ばない。
 *
 * 訪問レコードの生成・メンバーシップ解除・移動は #264。ここはneedの数値だけを扱う。
 */
import { clamp } from "./model";
import { SeededRandom } from "./random";
import type { AgentRefreshmentNeed, VenueAnchorKind, VenueRefreshmentNeedConfig } from "./venueAnchors";

const GAIN_SKIP_STATES: ReadonlySet<string> = new Set(["left", "unassigned"]);

/** FNV-1a風。`createSpatialRandom` と同じ実装で、名前空間だけ `venueAnchors` に分ける */
function hashString(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 飲食need専用の派生rng。本体 `SeededRandom` は読まない。
 * 同一 `runSeed` / `stage` / `agentId` / `tick` なら常に同じ系列になる。
 */
export function createVenueRandom(runSeed: number, stage: string, agentId: string, tick: number): SeededRandom {
  return new SeededRandom(hashString(`${runSeed}:venueAnchors:${stage}:${agentId}:${tick}`));
}

/**
 * 1agentにつき次の4呼出しだけを、この順で行う(ADR §3.2)。
 * hunger, thirst, hungerRate, thirstRate。tick 0 の初期値には増分を足さない。
 */
export function createInitialRefreshmentNeed(
  runSeed: number,
  agentId: string,
  config: VenueRefreshmentNeedConfig,
): AgentRefreshmentNeed {
  const rng = createVenueRandom(runSeed, "needInit", agentId, 0);
  return {
    hunger: rng.range(config.initialMin, config.initialMax),
    thirst: rng.range(config.initialMin, config.initialMax),
    hungerRate: rng.range(config.rateMin, config.rateMax),
    thirstRate: rng.range(config.rateMin, config.rateMax),
  };
}

export function createInitialRefreshmentNeeds(
  agents: readonly { id: string }[],
  runSeed: number,
  config: VenueRefreshmentNeedConfig,
): Record<string, AgentRefreshmentNeed> {
  const needs: Record<string, AgentRefreshmentNeed> = {};
  for (const agent of agents) {
    needs[agent.id] = createInitialRefreshmentNeed(runSeed, agent.id, config);
  }
  return needs;
}

/** 1tick分の増分。joined や訪問中も含めて呼ぶ。left / unassigned には呼ばない */
export function advanceRefreshmentNeed(
  need: AgentRefreshmentNeed,
  config: Pick<VenueRefreshmentNeedConfig, "hungerGainPerTick" | "thirstGainPerTick">,
): AgentRefreshmentNeed {
  return {
    ...need,
    hunger: clamp(need.hunger + config.hungerGainPerTick * need.hungerRate, 0, 1),
    thirst: clamp(need.thirst + config.thirstGainPerTick * need.thirstRate, 0, 1),
  };
}

/**
 * 取得tickで、増分を適用したあとのneedに対してpurpose側だけを `needAfterRefill` へ代入する。
 * もう一方は増分後の値を保つ。二重代入しない。
 */
export function applyRefreshmentRefill(
  need: AgentRefreshmentNeed,
  purpose: VenueAnchorKind,
  needAfterRefill: number,
): AgentRefreshmentNeed {
  if (purpose === "food") return { ...need, hunger: needAfterRefill };
  return { ...need, thirst: needAfterRefill };
}

/**
 * 成功時は `revisitCooldownTicks`、失敗時は `failedVisitCooldownTicks` を足す。
 * もう一方のkindのcooldownは変えない。新しい訪問を開始できるのは `tick >= cooldownUntilTick`。
 */
export function applyVisitCooldown(
  need: AgentRefreshmentNeed,
  purpose: VenueAnchorKind,
  tick: number,
  durationTicks: number,
): AgentRefreshmentNeed {
  const until = tick + durationTicks;
  if (purpose === "food") return { ...need, foodCooldownUntilTick: until };
  return { ...need, drinkCooldownUntilTick: until };
}

export type RefreshmentNeedAgent = {
  id: string;
  state: string;
};

/**
 * 有効tickのneed更新。不足しているagentだけ初期化し、`left` / `unassigned` は増分しない。
 * 一覧から消えたidのneedは観察用に残す(再生成しない)。主系列rngは消費しない。
 */
export function stepRefreshmentNeeds(
  agents: readonly RefreshmentNeedAgent[],
  previous: Readonly<Record<string, AgentRefreshmentNeed>> | undefined,
  runSeed: number,
  config: VenueRefreshmentNeedConfig,
): Record<string, AgentRefreshmentNeed> {
  const needs: Record<string, AgentRefreshmentNeed> = {};
  for (const agent of agents) {
    const existing = previous?.[agent.id] ?? createInitialRefreshmentNeed(runSeed, agent.id, config);
    needs[agent.id] = GAIN_SKIP_STATES.has(agent.state) ? existing : advanceRefreshmentNeed(existing, config);
  }
  if (previous) {
    for (const [id, need] of Object.entries(previous)) {
      if (!(id in needs)) needs[id] = need;
    }
  }
  return needs;
}
