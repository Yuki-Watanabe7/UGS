import type { ExpressionEvent, ExpressionIntent } from "./expression";

/**
 * `ExpressionEvent`をCanvas上のアクティブな吹き出しへ変換・管理する純粋な状態機械。
 * React/DOMに一切依存せず、`useActiveExpressions`フックから薄くラップして呼ばれる想定
 * (engine.tsとApp.tsxの関係と同じ分離方針)。
 *
 * 方針(Issue #65「対応範囲」に対応):
 * - 表示寿命はtick基準。`recommendedTtlTicks`が短すぎても`minDisplayTicks`で下駄を履かせ、
 *   高速再生時に一瞬で消えることを防ぐ。Pause中は`applyExpressionEvents`自体が
 *   呼ばれない(呼び出し側がtick変化時のみ呼ぶ)ため、実時間だけで消えることはない。
 * - 1エージェント1吹き出し。表示中よりevent.priorityが高い新イベントは即座に割り込む。
 *   同等以下の優先度は、最低表示tick数を満たすまで割り込ませず、1件だけキューして
 *   現在の表示が終わり次第出す(キューは常に最大1件、同等以上の優先度でのみ上書きする
 *   ことで、古い低優先度イベントが直前にキューされた重要イベントを追い出さないようにする)。
 * - Canvas全体の同時表示数が`maxConcurrent`に達している状態で新規agentの表示枠が必要になった場合、
 *   アクティブな中で最も弱い(優先度が低い/同点ならobserverJoinerでない/同点ならeventTickが古い)
 *   ものより新イベントが強ければ追い出し、そうでなければ表示せず破棄する(履歴はstate.logに残る)。
 */

export type ExpressionBubbleCandidate = {
  agentId: string;
  text: string;
  isObserverJoiner: boolean;
  /** 表示対象の絞り込み(「重要イベントのみ」等)のため、表示管理層より上に素通しする分類情報 */
  intent: ExpressionIntent;
  priority: number;
  eventTick: number;
  ttlTicks: number;
};

export type ActiveExpressionBubble = ExpressionBubbleCandidate & {
  /** このtickに達したら（tick >= expiresAtTick）表示を終える */
  expiresAtTick: number;
};

export type ActiveExpressionsState = {
  active: Map<string, ActiveExpressionBubble>;
  pending: Map<string, ExpressionBubbleCandidate>;
};

export const MAX_CONCURRENT_BUBBLES = 4;
export const MIN_DISPLAY_TICKS = 6;

export function createActiveExpressionsState(): ActiveExpressionsState {
  return { active: new Map(), pending: new Map() };
}

/** `ExpressionEvent`と、解決済みの表示文言・observerJoiner判定から候補データを組み立てる */
export function toExpressionBubbleCandidate(
  event: ExpressionEvent,
  text: string,
  isObserverJoiner: boolean,
): ExpressionBubbleCandidate {
  return {
    agentId: event.agentId,
    text,
    isObserverJoiner,
    intent: event.intent,
    priority: event.priority,
    eventTick: event.tick,
    ttlTicks: event.recommendedTtlTicks,
  };
}

export type ApplyExpressionEventsOptions = {
  maxConcurrent?: number;
  minDisplayTicks?: number;
};

/**
 * `tick`時点でのExpressionEvent候補群を、既存のアクティブ吹き出し集合へ反映した新しい状態を返す。
 * `state`は書き換えない(常に新しいMapを持つ新オブジェクトを返す)。
 * `candidates`は同一tick内で同一agentIdが複数含まれてもよい(呼び出し順ではなくpriority降順で
 * 内部処理するため、結果は入力順に依存しない)。
 */
export function applyExpressionEvents(
  state: ActiveExpressionsState,
  candidates: ExpressionBubbleCandidate[],
  tick: number,
  options: ApplyExpressionEventsOptions = {},
): ActiveExpressionsState {
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_BUBBLES;
  const minDisplayTicks = options.minDisplayTicks ?? MIN_DISPLAY_TICKS;

  const active = new Map(state.active);
  const pending = new Map(state.pending);

  expireAndPromote(active, pending, tick, minDisplayTicks);

  const ordered = [...candidates].sort((a, b) => b.priority - a.priority);
  for (const candidate of ordered) {
    admitAgentEvent(active, pending, candidate, tick, maxConcurrent, minDisplayTicks);
  }

  return { active, pending };
}

function expireAndPromote(
  active: Map<string, ActiveExpressionBubble>,
  pending: Map<string, ExpressionBubbleCandidate>,
  tick: number,
  minDisplayTicks: number,
): void {
  for (const [agentId, bubble] of active) {
    const queued = pending.get(agentId);
    const ttlExpired = tick >= bubble.expiresAtTick;
    // ttlには達していなくても、最低表示時間はもう満たしていて、かつ次が控えているなら
    // そこで打ち切って繰り上げる(「最低表示時間を満たすまでは割り込ませない」の裏返し)
    const minDisplaySatisfiedWithQueueWaiting = queued !== undefined && tick >= bubble.eventTick + minDisplayTicks;
    if (!ttlExpired && !minDisplaySatisfiedWithQueueWaiting) continue;

    active.delete(agentId);
    if (queued) {
      pending.delete(agentId);
      active.set(agentId, activate(queued, tick, minDisplayTicks));
    }
  }
}

function activate(
  candidate: ExpressionBubbleCandidate,
  tick: number,
  minDisplayTicks: number,
): ActiveExpressionBubble {
  return { ...candidate, expiresAtTick: tick + Math.max(candidate.ttlTicks, minDisplayTicks) };
}

function admitAgentEvent(
  active: Map<string, ActiveExpressionBubble>,
  pending: Map<string, ExpressionBubbleCandidate>,
  candidate: ExpressionBubbleCandidate,
  tick: number,
  maxConcurrent: number,
  minDisplayTicks: number,
): void {
  const current = active.get(candidate.agentId);

  if (!current) {
    admitNewAgent(active, candidate, tick, maxConcurrent, minDisplayTicks);
    return;
  }

  const minTicksSatisfied = tick >= current.eventTick + minDisplayTicks;
  if (candidate.priority > current.priority || minTicksSatisfied) {
    active.set(candidate.agentId, activate(candidate, tick, minDisplayTicks));
    pending.delete(candidate.agentId);
    return;
  }

  // 現在の吹き出しが最低表示時間内、かつ新イベントの優先度が同等以下 → 割り込ませずキューする。
  // 既にキューされているものより優先度が低い場合は上書きしない(古い低優先度イベントが
  // 直前にキューされた重要イベントを追い出さないようにするため)。
  const queued = pending.get(candidate.agentId);
  if (!queued || candidate.priority >= queued.priority) {
    pending.set(candidate.agentId, candidate);
  }
}

function admitNewAgent(
  active: Map<string, ActiveExpressionBubble>,
  candidate: ExpressionBubbleCandidate,
  tick: number,
  maxConcurrent: number,
  minDisplayTicks: number,
): void {
  if (active.size < maxConcurrent) {
    active.set(candidate.agentId, activate(candidate, tick, minDisplayTicks));
    return;
  }

  const weakest = findWeakestBubble(active);
  if (weakest && candidateOutranks(candidate, weakest[1])) {
    active.delete(weakest[0]);
    active.set(candidate.agentId, activate(candidate, tick, minDisplayTicks));
  }
  // それ以外は表示せず破棄する。状態ログ(state.log)には引き続き記録されるため、
  // 吹き出しに出せなくても発生自体の情報は失われない。
}

function findWeakestBubble(
  active: Map<string, ActiveExpressionBubble>,
): [string, ActiveExpressionBubble] | undefined {
  let weakest: [string, ActiveExpressionBubble] | undefined;
  for (const entry of active) {
    if (!weakest || isWeaker(entry[1], weakest[1])) {
      weakest = entry;
    }
  }
  return weakest;
}

/** aがbより「弱い」(上限超過時に先に追い出すべき)かどうか。priority > observerJoiner > 新しさの順で判定 */
function isWeaker(a: ActiveExpressionBubble, b: ActiveExpressionBubble): boolean {
  if (a.priority !== b.priority) return a.priority < b.priority;
  if (a.isObserverJoiner !== b.isObserverJoiner) return !a.isObserverJoiner;
  return a.eventTick < b.eventTick;
}

/** 新規候補が既存の最弱アクティブ吹き出しを追い出すだけの強さを持つかどうか */
function candidateOutranks(candidate: ExpressionBubbleCandidate, bubble: ActiveExpressionBubble): boolean {
  if (candidate.priority !== bubble.priority) return candidate.priority > bubble.priority;
  if (candidate.isObserverJoiner !== bubble.isObserverJoiner) return candidate.isObserverJoiner;
  return candidate.eventTick >= bubble.eventTick;
}
