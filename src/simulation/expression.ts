import type { Agent, SimulationState } from "./types";

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
  | "noticedInvitation";

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
  | "receivedLightInvitation";

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
const TEXT_VARIANT_COUNT = 3;

/**
 * `seed + tick + agentId + intent`から決定的にバリエーションを選ぶ。
 * 本体PRNG(`SeededRandom`)を消費しない、表示専用の純粋な文字列ハッシュ。
 */
function pickTextVariant(context: ExpressionDerivationContext, tick: number, agent: Agent, intent: ExpressionIntent): number {
  const key = `${context.seed}:${tick}:${agent.id}:${intent}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % TEXT_VARIANT_COUNT;
}

function buildEvent(
  context: ExpressionDerivationContext,
  tick: number,
  agent: Agent,
  intent: ExpressionIntent,
  reason: ExpressionReason,
): ExpressionEvent {
  const variant = pickTextVariant(context, tick, agent, intent);
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

    if (previousAgent.invitedAtTick === undefined && agent.invitedAtTick !== undefined) {
      events.push(buildEvent(context, nextState.tick, agent, "noticedInvitation", "receivedLightInvitation"));
    }
  }

  return events;
}
