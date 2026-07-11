import type { SpeechEvent, SpeechIntent, SpeechReason } from "./speech";

/**
 * Phase 3: `SpeechEvent`(発言そのもの)から介入効果に至るまでの因果イベントモデル。
 *
 * `speech.ts`のコメントにある責務差を踏まえた、このファイル固有の責務差:
 * - `ExpressionEvent`(`expression.ts`): 観察者にのみ見える非介入の演出データ。誰にも認知されない。
 * - `SpeechEvent`(`speech.ts`): 実際に発せられ他エージェントが認知しうる発言そのもの。
 *   誰が聞いたか・どう解釈したか・何に作用するかは一切持たない(Phase 2のスコープ)。
 * - `LogEntry`(`types.ts`): 人間可読な出来事の記録・集計用。意思決定の入力にはならない。
 * - `SpeechReceptionEvent`(本ファイル): `SpeechEvent`1件につき、認知対象になった受け手ごとに
 *   1件生成される「聞こえたか」の記録。
 * - `SpeechInterpretationEvent`(本ファイル): `SpeechReceptionEvent`1件につき、受け手がどの入力要因で
 *   どう解釈したか(`valence`)の記録。
 * - `SpeechEffectEvent`(本ファイル): `SpeechInterpretationEvent`1件につき、どの状態次元へ・どの強度/期間で
 *   作用しうるかを構造化して保持する記録。**実際にAgentの状態(stress等)へ適用する処理はPhase 4以降の
 *   スコープであり、本ファイルの`deriveSpeechEffects`は記録を生成するだけで、いかなるAgent/SimulationState
 *   も参照・変更しない。**
 *
 * 3段階(reception -> interpretation -> effect)は`speechEventId`で、interpretation/effectは
 * さらに`receptionEventId`/`interpretationEventId`で前段と一意に関連付けられる。全段が`receiverId`も
 * 保持するため、「誰にとっての記録か」はどの段からでも直接参照できる。
 *
 * このissue(Phase 3, #93)の対応しない範囲:
 * - 距離に基づく具体的な認知判定(`deriveSpeechReceptions`は`SpeechEvent`の`target`/`audience`という
 *   Phase 2までの二値的な到達モデルをそのまま使う。座標・範囲は一切見ない)
 * - 性格・関係性に基づく解釈式(`deriveSpeechInterpretations`は発言の`intent`のみを入力要因とする
 *   固定の対応表で解釈する。受け手の性格パラメータは参照しない)
 * - stressや参加判断への効果適用(`deriveSpeechEffects`が生成する`outputValue`/`durationTicks`は
 *   構造化された「作用しうる値」の記録に留まり、実際にAgent.stress等を変更する処理は存在しない)
 */

/** Phase 3効果の生成有無を切り替える設定境界。既存の`SimParams`/`InterventionRuntimeOptions`とは独立 */
export type SpeechEffectsConfig = {
  /**
   * false(デフォルト)の場合、`deriveSpeechReceptions`/`deriveSpeechInterpretations`/
   * `deriveSpeechEffects`はいずれも空配列を返す。既存の設定・挙動との後方互換のためのデフォルト値。
   */
  enabled: boolean;
};

/** 未指定時に使う既定値。既存の呼び出し元(engine.ts以前からの利用箇所)を一切変更せずに済むよう無効化しておく */
export const DEFAULT_SPEECH_EFFECTS_CONFIG: SpeechEffectsConfig = { enabled: false };

/** 部分指定を`DEFAULT_SPEECH_EFFECTS_CONFIG`で補完した`SpeechEffectsConfig`を返す */
export function resolveSpeechEffectsConfig(config?: Partial<SpeechEffectsConfig>): SpeechEffectsConfig {
  return { ...DEFAULT_SPEECH_EFFECTS_CONFIG, ...config };
}

/** `SpeechEvent`のtarget/audienceのどちらの経路で認知対象になったか */
export type SpeechReceptionRelation = "target" | "audience";

/**
 * 「誰が認知対象になり、聞こえたか」の記録。1件の`SpeechEvent`につき、認知対象になった
 * 受け手ごとに1件生成される。`heard`は常にtrue(距離based の聞き逃し判定はPhase 3の対応しない
 * 範囲であり、フィールドとして予約してあるのみ)。
 */
export type SpeechReceptionEvent = {
  id: string;
  speechEventId: string;
  /** 発言(=認知)が発生したtick。`SpeechEvent.tick`と同一 */
  tick: number;
  receiverId: string;
  relation: SpeechReceptionRelation;
  heard: boolean;
};

/** `deriveSpeechInterpretations`が発言からどう解釈するかの結果分類。固定の対応表由来(受け手の性格には依存しない) */
export type SpeechInterpretationValence = "positive" | "neutral";

/**
 * 「受け手がどの要因でどう解釈したか」の記録。`inputFactors`は解釈に使った入力要因を明示的に保持し、
 * `valence`が解釈結果。Phase 3では`intent`のみを入力要因とする(性格・関係性は対応しない範囲)。
 */
export type SpeechInterpretationEvent = {
  id: string;
  speechEventId: string;
  receptionEventId: string;
  tick: number;
  receiverId: string;
  inputFactors: { intent: SpeechIntent };
  valence: SpeechInterpretationValence;
};

/** 効果が作用しうる状態次元。Phase 3時点ではstress方向の効果のみを構造として持つ(実適用はしない) */
export type SpeechEffectDimension = "stress";

/**
 * 「どの状態次元へ、どの強度・期間で作用するか」を構造化して保持する記録。
 * `occurredTick`(発言・認知・解釈が発生したtick)と`appliedTick`(効果が適用されるべきtick)を
 * 分けて持つのは、Phase 3時点では両者が常に同一tickであっても、将来「解釈から少し遅れて効果が
 * 現れる」ような遅延効果を導入する余地を型として残しておくため。
 */
export type SpeechEffectEvent = {
  id: string;
  speechEventId: string;
  interpretationEventId: string;
  receiverId: string;
  reason: SpeechReason;
  occurredTick: number;
  appliedTick: number;
  dimension: SpeechEffectDimension;
  outputValue: number;
  durationTicks: number;
};

/** intentのみに基づく固定の解釈対応表(性格・関係性には依存しない) */
const INTENT_VALENCE: Record<SpeechIntent, SpeechInterpretationValence> = {
  invite: "positive",
  welcome: "positive",
  greet: "positive",
  decline: "neutral",
};

/** valenceのみに基づく固定の効果量対応表(受け手の性格には依存しない、構造化された記録用の値) */
const VALENCE_STRESS_EFFECT: Record<SpeechInterpretationValence, { outputValue: number; durationTicks: number }> = {
  positive: { outputValue: -0.05, durationTicks: 5 },
  neutral: { outputValue: 0, durationTicks: 0 },
};

/**
 * `speechEvents`(このtickまでに生成された発言)から、認知対象になった受け手ごとに
 * `SpeechReceptionEvent`を導出する純粋関数。`SimulationState`・他エージェントの実座標・rngの
 * いずれも参照/変更しない。
 *
 * 到達判定はPhase 2までと同じ二値モデルをそのまま使う: `target`が設定されていればその1人のみ、
 * `audience === "nearby"`なら`receiverIds`のうち話者本人を除く全員を対象とする
 * (`types.ts`の`SpeechRelation`コメントに記載の簡略化と同一。距離based の判定はここでは行わない)。
 *
 * 同一`speechEvents`・同一`receiverIds`に対して常に同じ順序・内容の配列を返す(receiverIdsの
 * 並び順をそのまま使うため、呼び出し側で安定した順序を渡すこと)。
 */
export function deriveSpeechReceptions(
  speechEvents: SpeechEvent[],
  receiverIds: string[],
  config: SpeechEffectsConfig,
): SpeechReceptionEvent[] {
  if (!config.enabled) return [];

  const events: SpeechReceptionEvent[] = [];
  for (const speech of speechEvents) {
    if (speech.target !== undefined) {
      events.push({
        id: `reception-${speech.id}-${speech.target}`,
        speechEventId: speech.id,
        tick: speech.tick,
        receiverId: speech.target,
        relation: "target",
        heard: true,
      });
      continue;
    }
    if (speech.audience === "nearby") {
      for (const receiverId of receiverIds) {
        if (receiverId === speech.speakerId) continue;
        events.push({
          id: `reception-${speech.id}-${receiverId}`,
          speechEventId: speech.id,
          tick: speech.tick,
          receiverId,
          relation: "audience",
          heard: true,
        });
      }
    }
  }
  return events;
}

/**
 * `receptions`から、対応する`SpeechEvent`の`intent`だけを入力要因とする固定の解釈対応表で
 * `SpeechInterpretationEvent`を導出する純粋関数。受け手の性格・既存関係性は一切参照しない
 * (対応しない範囲)。`SimulationState`・rngのいずれも参照/変更しない。
 */
export function deriveSpeechInterpretations(
  receptions: SpeechReceptionEvent[],
  speechEvents: SpeechEvent[],
  config: SpeechEffectsConfig,
): SpeechInterpretationEvent[] {
  if (!config.enabled) return [];

  const speechById = new Map(speechEvents.map((speech) => [speech.id, speech]));
  const events: SpeechInterpretationEvent[] = [];
  for (const reception of receptions) {
    const speech = speechById.get(reception.speechEventId);
    if (!speech) continue;
    events.push({
      id: `interpretation-${reception.id}`,
      speechEventId: reception.speechEventId,
      receptionEventId: reception.id,
      tick: reception.tick,
      receiverId: reception.receiverId,
      inputFactors: { intent: speech.intent },
      valence: INTENT_VALENCE[speech.intent],
    });
  }
  return events;
}

/**
 * `interpretations`から、`valence`だけに基づく固定の効果量対応表で`SpeechEffectEvent`を導出する
 * 純粋関数。生成するのは「どの状態次元へ、どの強度・期間で作用しうるか」という構造化された記録のみで、
 * Agent.stress等へ実際に適用する処理はここには存在しない(対応しない範囲、Phase 4以降で扱う)。
 * `SimulationState`・rngのいずれも参照/変更しない。
 */
export function deriveSpeechEffects(
  interpretations: SpeechInterpretationEvent[],
  speechEvents: SpeechEvent[],
  config: SpeechEffectsConfig,
): SpeechEffectEvent[] {
  if (!config.enabled) return [];

  const speechById = new Map(speechEvents.map((speech) => [speech.id, speech]));
  const events: SpeechEffectEvent[] = [];
  for (const interpretation of interpretations) {
    const speech = speechById.get(interpretation.speechEventId);
    if (!speech) continue;
    const { outputValue, durationTicks } = VALENCE_STRESS_EFFECT[interpretation.valence];
    events.push({
      id: `effect-${interpretation.id}`,
      speechEventId: interpretation.speechEventId,
      interpretationEventId: interpretation.id,
      receiverId: interpretation.receiverId,
      reason: speech.reason,
      occurredTick: interpretation.tick,
      appliedTick: interpretation.tick,
      dimension: "stress",
      outputValue,
      durationTicks,
    });
  }
  return events;
}
