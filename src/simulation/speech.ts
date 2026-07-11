/**
 * `SpeechEvent`が意味する発言の分類。「その発言が何を伝えるものか」を表す。
 * 現時点で発言生成箇所(engine.ts)が扱うのは、誰かを誘う発言のみ。
 */
export type SpeechIntent = "invite";

/**
 * 発言が発生した構造的な理由。`SpeechEvent.textKey`のテンプレート参照キーにも使う。
 * - "initiativeFormedCore" / "cliqueFormedCore": 核形成時に founder が周囲を誘う発言
 *   (`ExpressionReason`の同名値と対応する状況だが、こちらは実際にエージェントが発した発言を表す)。
 * - "lightObserverInvitation": `light-observer-invitation`介入で、observerJoinerに軽く声をかける発言。
 */
export type SpeechReason = "initiativeFormedCore" | "cliqueFormedCore" | "lightObserverInvitation";

/** 発言が届く範囲。特定の1人ではなく周囲へ向けた発言の場合に設定される(`target`とは排他) */
export type SpeechAudience = "nearby";

/**
 * エージェントが実際に行う「発言」を表す第一級のシミュレーションイベント。
 *
 * Phase 1の`ExpressionEvent`(`expression.ts`)との責務差:
 * - `ExpressionEvent`: 観察者にのみ見える非介入の演出データ。`SimulationState`には保持されず、
 *   他エージェントに認知されない「心の声」。状態遷移や乱数列に一切影響しない。
 * - `SpeechEvent`: シミュレーション上で実際に発せられ、他エージェントが認知しうる発言。
 *   `SimulationState.speechLog`に記録として蓄積される第一級イベント。
 *
 * Phase 2時点のスコープ(重要): 発言イベントを生成・記録・表示できる基盤を作るところまでを担う。
 * この発言を「聞いた」他エージェントのstress/attractiveness/参加・離脱判断を変化させる介入効果は
 * 一切持たない(それらはPhase 3で扱う)。`createSpeechEvent`はこの境界を越えず、`SimulationState`や
 * 他エージェントを一切参照・変更しない純粋な生成関数として保つこと。
 */
export type SpeechEvent = {
  id: string;
  tick: number;
  speakerId: string;
  intent: SpeechIntent;
  reason: SpeechReason;
  /** 発言の名宛先。特定の1人に向けた発言(observerJoinerへの声かけ等)の場合のみ設定される。`audience`とは排他 */
  target?: string;
  /** 発言が届く範囲。周囲全体に向けた発言の場合のみ設定される。`target`とは排他 */
  audience?: SpeechAudience;
  /** 表示文言そのものではなく、テンプレート参照キー。実際の文言解決はUI側の責務(`speechTemplates.ts`) */
  textKey: string;
};

export type CreateSpeechEventInput = {
  tick: number;
  speakerId: string;
  intent: SpeechIntent;
  reason: SpeechReason;
  target?: string;
  audience?: SpeechAudience;
};

/**
 * `SpeechEvent`を組み立てる唯一の生成口(発言生成境界)。engine.tsはこの関数を通してのみ
 * SpeechEventを作り、`id`/`textKey`の組み立てルールをここに集約することで生成箇所ごとの
 * 表記ゆれを防ぐ。`SimulationState`・`SeededRandom`のいずれも受け取らない純粋関数。
 */
export function createSpeechEvent(input: CreateSpeechEventInput): SpeechEvent {
  return {
    id: `speech-${input.tick}-${input.speakerId}-${input.reason}`,
    tick: input.tick,
    speakerId: input.speakerId,
    intent: input.intent,
    reason: input.reason,
    target: input.target,
    audience: input.audience,
    textKey: `speech.${input.reason}`,
  };
}
