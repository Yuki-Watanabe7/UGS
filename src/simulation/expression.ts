import type { Agent, SimulationState } from "./types";
import { nearestCandidate } from "./engine";
import { getExpressionVariantCount } from "./expressionTemplates";

/**
 * 観察用表現イベントの種別。
 * "thought": エージェント本人にも他エージェントにも認知されない、観察者だけに見える「心の声」。
 * "speech": 将来のPhase 2(発言モデル)向けに型だけ予約している。Phase 1では絶対に生成しない
 * (生成箇所は`deriveExpressionEvents`のみであり、そこでは"thought"しか作らない)。
 */
export type ExpressionEventKind = "thought" | "speech";

/** 表現イベントが表す、その瞬間のエージェントの意図・心情の分類 */
export type ExpressionIntent =
  | "consideringJoining"
  | "approachingGroup"
  | "joinedGroup"
  | "givingUpWaiting"
  | "leftEvent"
  | "noticedInvitation"
  | "stressRising"
  | "consideringLeaving"
  | "hesitating"
  | "watching";

/** 表現イベントが発生した構造的な理由。表示文言テンプレートの選択キーとして使う想定 */
export type ExpressionReason =
  | "initiativeFormedCore"
  | "cliqueFormedCore"
  | "approachedFormingGroup"
  | "approachedConfirmedGroup"
  | "arrivedAtFormingGroup"
  | "arrivedAtConfirmedGroup"
  | "ambiguityStressExceeded"
  | "reachedScreenEdge"
  | "receivedLightInvitation"
  | "stressCrossedRisingThreshold"
  | "stressNearLeaveThreshold"
  | "nearbyGroupUnapproached"
  | "noJoinableGroupNearby";

/**
 * 観察専用の構造化表現イベント。SimulationCanvas上で一時的に表示する「心の声」の元データ。
 *
 * `LogEntry`との責務差:
 * - `LogEntry`: 検証可能な出来事の時系列記録(集計・監査対象。`SimulationState.log`に蓄積され続ける)。
 * - `ExpressionEvent`: 観察者(UIを見ているユーザー)にのみ見える一時的な演出データ。
 *   シミュレーション上の発言ではなく他エージェントに認知されず、状態遷移や乱数列に影響しない。
 *   表示後は`recommendedTtlTicks`に従って消えることを想定した使い捨てデータであり、
 *   `SimulationState`には保持しない(保持責務は表示管理側の別issueで扱う)。
 */
export type ExpressionEvent = {
  id: string;
  tick: number;
  agentId: string;
  kind: ExpressionEventKind;
  intent: ExpressionIntent;
  reason: ExpressionReason;
  /** 表示文言そのものではなく、テンプレート参照キー。実際の文言解決はUI側の責務 */
  textKey: string;
  /** 表示優先度。値が大きいほど優先して表示する(同時多発時の取捨選択用) */
  priority: number;
  /** 推奨表示寿命(tick数)。実際の重なり制御・消去タイミングは表示管理側の責務 */
  recommendedTtlTicks: number;
};

/**
 * `deriveExpressionEvents`が文言バリエーションを決定的に選ぶための入力。
 * 本体の`SeededRandom`とは完全に独立しており、本体の乱数列を一切消費しない。
 */
export type ExpressionDerivationContext = {
  seed: number;
};

const DEFAULT_PRIORITY = 1;
const OBSERVER_PRIORITY = 2;
const DEFAULT_TTL_TICKS = 12;
const OBSERVER_TTL_TICKS = 16;

// undecided状態が続く間、stressがleaveThresholdに対してこの比率を初めて超えたら
// 「まだ疲れてきた」心の声を一度だけ出す(以後stressが下がって再度超えない限り出さない)
const STRESS_RISING_RATIO = 0.5;
// 同様に、この比率を初めて超えたら「そろそろ潮時」の警告を一度だけ出す。
// 1.0を超えると実際にleaving状態へ遷移し、別のgivingUpWaiting(ambiguityStressExceeded)が出る
const LEAVE_WARNING_RATIO = 0.85;
// hesitating/watching(状態遷移を伴わない、継続的な状況に基づく心の声)を
// 同一agentについて毎tick出さないための周期。agentIdごとの位相をずらして一斉発火を避ける
const WATCHING_COOLDOWN_TICKS = 8;

/**
 * 文字列から決定的な非負ハッシュ値を作る、表示専用の純粋関数。
 * 本体PRNG(`SeededRandom`)を消費しない。
 */
function hashString(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * `seed + tick + agentId + reason`から決定的にテンプレートのバリエーションを選ぶ。
 * 完了条件「同じseed・tick・agent・判断理由では同じ表現が選ばれる」に対応するため、
 * ハッシュキーは(intentではなく)reasonを使う。バリエーション数はテンプレート側の
 * 実際の配列長(`expressionTemplates.ts`、observerJoinerかどうかで異なりうる)に従う。
 */
function pickTextVariant(
  context: ExpressionDerivationContext,
  tick: number,
  agent: Agent,
  reason: ExpressionReason,
): number {
  const key = `${context.seed}:${tick}:${agent.id}:${reason}`;
  const variantCount = getExpressionVariantCount(reason, agent.isObserverJoiner);
  return hashString(key) % variantCount;
}

/** agentごとに位相をずらした、決定的な(乱数を使わない)cooldownスケジュール判定 */
function isOnWatchingCooldownSchedule(agentId: string, tick: number): boolean {
  const phase = hashString(agentId) % WATCHING_COOLDOWN_TICKS;
  return tick % WATCHING_COOLDOWN_TICKS === phase;
}

function buildEvent(
  context: ExpressionDerivationContext,
  tick: number,
  agent: Agent,
  intent: ExpressionIntent,
  reason: ExpressionReason,
): ExpressionEvent {
  const variant = pickTextVariant(context, tick, agent, reason);
  return {
    id: `expr-${tick}-${agent.id}-${intent}`,
    tick,
    agentId: agent.id,
    kind: "thought",
    intent,
    reason,
    textKey: `thought.${reason}.v${variant}`,
    priority: agent.isObserverJoiner ? OBSERVER_PRIORITY : DEFAULT_PRIORITY,
    recommendedTtlTicks: agent.isObserverJoiner ? OBSERVER_TTL_TICKS : DEFAULT_TTL_TICKS,
  };
}

function deriveStateTransitionEvent(
  context: ExpressionDerivationContext,
  previousAgent: Agent,
  agent: Agent,
  nextState: SimulationState,
): ExpressionEvent | undefined {
  if (previousAgent.state === "undecided" && agent.state === "forming") {
    const reason: ExpressionReason = agent.initiative >= 0.5 ? "initiativeFormedCore" : "cliqueFormedCore";
    return buildEvent(context, nextState.tick, agent, "consideringJoining", reason);
  }

  if (previousAgent.state === "undecided" && agent.state === "approaching") {
    const candidate = nextState.groupCandidates.find((c) => c.id === agent.joinedGroupId);
    const reason: ExpressionReason =
      candidate?.status === "confirmed" ? "approachedConfirmedGroup" : "approachedFormingGroup";
    return buildEvent(context, nextState.tick, agent, "approachingGroup", reason);
  }

  if ((previousAgent.state === "approaching" || previousAgent.state === "forming") && agent.state === "joined") {
    const candidate = nextState.groupCandidates.find((c) => c.id === agent.joinedGroupId);
    const reason: ExpressionReason =
      candidate?.status === "confirmed" ? "arrivedAtConfirmedGroup" : "arrivedAtFormingGroup";
    return buildEvent(context, nextState.tick, agent, "joinedGroup", reason);
  }

  if (previousAgent.state === "undecided" && agent.state === "leaving") {
    return buildEvent(context, nextState.tick, agent, "givingUpWaiting", "ambiguityStressExceeded");
  }

  if (previousAgent.state === "leaving" && agent.state === "left") {
    return buildEvent(context, nextState.tick, agent, "leftEvent", "reachedScreenEdge");
  }

  return undefined;
}

/**
 * 状態遷移を伴わない、undecidedが継続している間の心の声を導出する。
 * `deriveStateTransitionEvent`とは独立した抑制ルールを持つ:
 * - stress関連(stressRising/consideringLeaving)は「閾値を初めて跨いだ時のみ」
 *   (`previousAgent`との比較によって、同じ局面での連続発生を防ぐ)
 * - hesitating/watchingは状態遷移もstress閾値超過も伴わない持続的な状況のため、
 *   agentIdから決定的に導いた位相でtickごとのcooldownをかける(毎tick出し続けない)
 */
function deriveContinuousConditionEvents(
  context: ExpressionDerivationContext,
  previousAgent: Agent,
  agent: Agent,
  nextState: SimulationState,
): ExpressionEvent[] {
  if (previousAgent.state !== "undecided" || agent.state !== "undecided") return [];

  const events: ExpressionEvent[] = [];

  const previousRatio = previousAgent.stress / previousAgent.leaveThreshold;
  const ratio = agent.stress / agent.leaveThreshold;
  if (previousRatio < STRESS_RISING_RATIO && ratio >= STRESS_RISING_RATIO) {
    events.push(buildEvent(context, nextState.tick, agent, "stressRising", "stressCrossedRisingThreshold"));
  }
  if (previousRatio < LEAVE_WARNING_RATIO && ratio >= LEAVE_WARNING_RATIO) {
    events.push(buildEvent(context, nextState.tick, agent, "consideringLeaving", "stressNearLeaveThreshold"));
  }

  if (isOnWatchingCooldownSchedule(agent.id, nextState.tick)) {
    const nearby = nearestCandidate(agent, nextState.groupCandidates);
    events.push(
      nearby
        ? buildEvent(context, nextState.tick, agent, "hesitating", "nearbyGroupUnapproached")
        : buildEvent(context, nextState.tick, agent, "watching", "noJoinableGroupNearby"),
    );
  }

  return events;
}

/**
 * 直前/直後のシミュレーション状態を比較し、観察用表現イベントを導出する純粋関数。
 *
 * 設計上の境界(重要):
 * - `previousState`/`nextState`を一切mutationしない。
 * - 戻り値の`ExpressionEvent[]`はどこにも保持されず、engine側の次tick計算にも
 *   一切参照されない(このファイルは`engine.ts`からimportされない)。
 * - 本体の`SeededRandom`インスタンスを受け取らない/消費しない。文言バリエーションは
 *   `ExpressionDerivationContext.seed`から決定的に導出する(`pickTextVariant`参照)。
 */
export function deriveExpressionEvents(
  previousState: SimulationState,
  nextState: SimulationState,
  context: ExpressionDerivationContext,
): ExpressionEvent[] {
  const events: ExpressionEvent[] = [];
  const previousById = new Map(previousState.agents.map((a) => [a.id, a]));

  for (const agent of nextState.agents) {
    const previousAgent = previousById.get(agent.id);
    if (!previousAgent) continue;

    if (previousAgent.state !== agent.state) {
      const event = deriveStateTransitionEvent(context, previousAgent, agent, nextState);
      if (event) events.push(event);
    }

    events.push(...deriveContinuousConditionEvents(context, previousAgent, agent, nextState));

    if (previousAgent.invitedAtTick === undefined && agent.invitedAtTick !== undefined) {
      events.push(buildEvent(context, nextState.tick, agent, "noticedInvitation", "receivedLightInvitation"));
    }
  }

  return events;
}
