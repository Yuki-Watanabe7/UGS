import type { SpeechEvent, SpeechIntent } from "./speech";

/**
 * `SpeechEvent`をCanvas上のアクティブな発言吹き出しへ変換・管理する純粋な状態機械。
 * React/DOMに一切依存しない(`activeExpressions.ts`と同じ分離方針)。
 *
 * `activeExpressions.ts`(心の声)と設計・アルゴリズムは意図的に揃えている(Issue #82
 * 「既存の吹き出し寿命・競合・混雑制御をSpeechEventへ適用または拡張する」)が、
 * 心の声と発言は責務が異なるモデルであるため、ファイル・状態は独立させ混在させない
 * (`speech.ts`が`deriveExpressionEvents`と`deriveSpeechEvents`を分けているのと同じ方針)。
 *
 * - 表示寿命はtick基準。SpeechEventはttlを持たないため、observerJoinerが話者かどうかで
 *   `DEFAULT_SPEECH_TTL_TICKS`/`OBSERVER_SPEECH_TTL_TICKS`のいずれかを割り当てる。
 * - 1エージェント(話者)1吹き出し。同一tickに同一話者の発言が複数生成されても
 *   (例: 同時に複数人が同じ核へforming遷移し、founderが連続して勧誘発言する場合)、
 *   優先度降順→(同点は)入力順で1件だけ即時採用し、残りはpendingへ1件だけキューする
 *   (`applyExpressionEvents`と同じ「同点以上のみ上書き」ルールにより決定的)。
 */

export type SpeechBubbleCandidate = {
  agentId: string;
  /** 宛先の補助表現(target/audienceがある場合の「→Bさんへ」等)を含む、表示用に組み立て済みのテキスト */
  text: string;
  isObserverJoiner: boolean;
  intent: SpeechIntent;
  priority: number;
  eventTick: number;
  ttlTicks: number;
};

export type ActiveSpeechBubble = SpeechBubbleCandidate & {
  /** このtickに達したら(tick >= expiresAtTick)表示を終える */
  expiresAtTick: number;
};

export type ActiveSpeechBubblesState = {
  active: Map<string, ActiveSpeechBubble>;
  pending: Map<string, SpeechBubbleCandidate>;
};

export const MAX_CONCURRENT_SPEECH_BUBBLES = 4;
export const MIN_SPEECH_DISPLAY_TICKS = 6;
export const DEFAULT_SPEECH_TTL_TICKS = 12;
export const OBSERVER_SPEECH_TTL_TICKS = 16;

const DEFAULT_SPEECH_PRIORITY = 1;
const OBSERVER_SPEECH_PRIORITY = 2;

export function createActiveSpeechBubblesState(): ActiveSpeechBubblesState {
  return { active: new Map(), pending: new Map() };
}

/** `SpeechEvent`と、解決済みの表示文言(宛先補助表現込み)・observerJoiner判定から候補データを組み立てる */
export function toSpeechBubbleCandidate(
  event: SpeechEvent,
  text: string,
  isObserverJoiner: boolean,
): SpeechBubbleCandidate {
  return {
    agentId: event.speakerId,
    text,
    isObserverJoiner,
    intent: event.intent,
    priority: isObserverJoiner ? OBSERVER_SPEECH_PRIORITY : DEFAULT_SPEECH_PRIORITY,
    eventTick: event.tick,
    ttlTicks: isObserverJoiner ? OBSERVER_SPEECH_TTL_TICKS : DEFAULT_SPEECH_TTL_TICKS,
  };
}

export type ApplySpeechBubbleEventsOptions = {
  maxConcurrent?: number;
  minDisplayTicks?: number;
};

/**
 * `tick`時点でのSpeechBubbleCandidate候補群を、既存のアクティブ吹き出し集合へ反映した新しい状態を返す。
 * `state`は書き換えない(常に新しいMapを持つ新オブジェクトを返す)。
 */
export function applySpeechBubbleEvents(
  state: ActiveSpeechBubblesState,
  candidates: SpeechBubbleCandidate[],
  tick: number,
  options: ApplySpeechBubbleEventsOptions = {},
): ActiveSpeechBubblesState {
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_SPEECH_BUBBLES;
  const minDisplayTicks = options.minDisplayTicks ?? MIN_SPEECH_DISPLAY_TICKS;

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
  active: Map<string, ActiveSpeechBubble>,
  pending: Map<string, SpeechBubbleCandidate>,
  tick: number,
  minDisplayTicks: number,
): void {
  for (const [agentId, bubble] of active) {
    const queued = pending.get(agentId);
    const ttlExpired = tick >= bubble.expiresAtTick;
    const minDisplaySatisfiedWithQueueWaiting = queued !== undefined && tick >= bubble.eventTick + minDisplayTicks;
    if (!ttlExpired && !minDisplaySatisfiedWithQueueWaiting) continue;

    active.delete(agentId);
    if (queued) {
      pending.delete(agentId);
      active.set(agentId, activate(queued, tick, minDisplayTicks));
    }
  }
}

function activate(candidate: SpeechBubbleCandidate, tick: number, minDisplayTicks: number): ActiveSpeechBubble {
  return { ...candidate, expiresAtTick: tick + Math.max(candidate.ttlTicks, minDisplayTicks) };
}

function admitAgentEvent(
  active: Map<string, ActiveSpeechBubble>,
  pending: Map<string, SpeechBubbleCandidate>,
  candidate: SpeechBubbleCandidate,
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

  const queued = pending.get(candidate.agentId);
  if (!queued || candidate.priority >= queued.priority) {
    pending.set(candidate.agentId, candidate);
  }
}

function admitNewAgent(
  active: Map<string, ActiveSpeechBubble>,
  candidate: SpeechBubbleCandidate,
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
  // それ以外は表示せず破棄する。SimulationState.speechLogには引き続き記録されるため、
  // 吹き出しに出せなくても発言自体の情報は失われない。
}

function findWeakestBubble(active: Map<string, ActiveSpeechBubble>): [string, ActiveSpeechBubble] | undefined {
  let weakest: [string, ActiveSpeechBubble] | undefined;
  for (const entry of active) {
    if (!weakest || isWeaker(entry[1], weakest[1])) {
      weakest = entry;
    }
  }
  return weakest;
}

/** aがbより「弱い」(上限超過時に先に追い出すべき)かどうか。priority > observerJoiner > 新しさの順で判定 */
function isWeaker(a: ActiveSpeechBubble, b: ActiveSpeechBubble): boolean {
  if (a.priority !== b.priority) return a.priority < b.priority;
  if (a.isObserverJoiner !== b.isObserverJoiner) return !a.isObserverJoiner;
  return a.eventTick < b.eventTick;
}

/** 新規候補が既存の最弱アクティブ吹き出しを追い出すだけの強さを持つかどうか */
function candidateOutranks(candidate: SpeechBubbleCandidate, bubble: ActiveSpeechBubble): boolean {
  if (candidate.priority !== bubble.priority) return candidate.priority > bubble.priority;
  if (candidate.isObserverJoiner !== bubble.isObserverJoiner) return candidate.isObserverJoiner;
  return candidate.eventTick >= bubble.eventTick;
}
