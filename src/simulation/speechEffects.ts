import type { Agent } from "./types";
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
 *   1件生成される「聞こえたか」の記録。Issue #94により、`SpeechEvent`の発言時点位置(`originX`/`originY`)
 *   と受け手候補の位置から実際に距離を計算し、`audibility`(=range*strength)としきい値比較して判定する
 *   (旧: `target`/`audience`のみで判定する二値モデル。詳細は`docs/speech-reception-distance-model.md`)。
 * - `SpeechInterpretationEvent`(本ファイル): `SpeechReceptionEvent`1件につき、受け手がどの入力要因で
 *   どう解釈したか(`valence`)の記録。`heard: false`の受信(聞こえなかった)は解釈対象にならない。
 * - `SpeechEffectEvent`(本ファイル): `SpeechInterpretationEvent`1件につき、どの状態次元へ・どの強度/期間で
 *   作用しうるかを構造化して保持する記録。**実際にAgentの状態(stress等)へ適用する処理はPhase 4以降の
 *   スコープであり、本ファイルの`deriveSpeechEffects`は記録を生成するだけで、いかなるAgent/SimulationState
 *   も参照・変更しない。**
 *
 * 3段階(reception -> interpretation -> effect)は`speechEventId`で、interpretation/effectは
 * さらに`receptionEventId`/`interpretationEventId`で前段と一意に関連付けられる。全段が`receiverId`も
 * 保持するため、「誰にとっての記録か」はどの段からでも直接参照できる。
 *
 * このissue(Phase 3.1, #94)の対応しない範囲:
 * - 聞いた後の意味解釈そのもの(`deriveSpeechInterpretations`の対応表は変更しない。`heard`による
 *   フィルタリングのみ追加する)
 * - 遮蔽物・方向・騒音場の物理モデル(距離としきい値比較のみ。障害物や音の伝わり方は考慮しない)
 * - 確率的な聞き漏らし(`heard`は距離としきい値から一意に決まる決定的な判定であり、rngは使わない)
 * - 心理状態や行動選択への効果(認知判定はAgent.stress等を一切変更しない)
 * - UI表示(Inspector等の表示層は引き続き`SpeechEvent`の`target`/`audience`ベースの簡略化を使う。
 *   `docs/speech-reception-distance-model.md`参照)
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

/** `heard`がtrue/falseになった理由。距離としきい値の比較のみを扱う(遮蔽物等は対応しない範囲) */
export type SpeechReceptionReason = "withinRange" | "outOfRange";

/**
 * 認知判定の対象候補として`deriveSpeechReceptions`が必要とする最小限のAgent情報。
 * `Agent`型全体を要求せず、位置(`x`/`y`)と生存状態(`state`)だけに絞ることで、
 * このファイルが認知判定に無関係なAgentのフィールド(willingness等)に依存しないようにする。
 */
export type SpeechReceiverCandidate = Pick<Agent, "id" | "x" | "y" | "state">;

/**
 * 「誰が認知対象になり、聞こえたか」の記録。1件の`SpeechEvent`につき、認知対象になった
 * 受け手ごとに1件生成される。`heard`は発言時点の話者位置(`SpeechEvent.originX`/`originY`)から
 * 受け手までの距離(`distance`)と、しきい値(`threshold`、`SpeechEvent.audibility`と同値)の
 * 比較で決定的に決まる(Issue #94)。
 */
export type SpeechReceptionEvent = {
  id: string;
  speechEventId: string;
  /** 発言(=認知)が発生したtick。`SpeechEvent.tick`と同一 */
  tick: number;
  receiverId: string;
  relation: SpeechReceptionRelation;
  /** 発言時点の話者位置(`SpeechEvent.originX`/`originY`)から受け手までの距離 */
  distance: number;
  /** 判定に使ったしきい値(= `SpeechEvent.audibility`)。遡って再計算せずに済むよう複製して保持する */
  threshold: number;
  heard: boolean;
  reason: SpeechReceptionReason;
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

/** 話者自身、およびleft状態のagentは認知対象の候補から除外する(存在しないagentは呼び出し側の配列に含まれ得ない) */
function isEligibleReceiver(candidate: SpeechReceiverCandidate, speakerId: string): boolean {
  return candidate.id !== speakerId && candidate.state !== "left";
}

function buildReception(
  speech: SpeechEvent,
  receiver: SpeechReceiverCandidate,
  relation: SpeechReceptionRelation,
): SpeechReceptionEvent {
  const dist = Math.hypot(speech.originX - receiver.x, speech.originY - receiver.y);
  const heard = dist <= speech.audibility;
  return {
    id: `reception-${speech.id}-${receiver.id}`,
    speechEventId: speech.id,
    tick: speech.tick,
    receiverId: receiver.id,
    relation,
    distance: dist,
    threshold: speech.audibility,
    heard,
    reason: heard ? "withinRange" : "outOfRange",
  };
}

/**
 * `speechEvents`(このtickまでに生成された発言)から、認知対象になった受け手ごとに
 * `SpeechReceptionEvent`を導出する純粋関数。`SimulationState`・rngのいずれも参照/変更しない
 * (`candidates`として渡された位置スナップショットのみを参照する)。
 *
 * 到達判定の規則(Issue #94):
 * - 話者自身、および`state === "left"`のagentは候補から除外する。
 * - `target`が設定されている場合、対象がこの除外後の候補に含まれていなければ(自己宛て/left/
 *   不在)`SpeechReceptionEvent`は一切生成しない。含まれていれば、targetは「候補を特定する情報」
 *   に過ぎず、実際に聞こえたかどうか(`heard`)は`SpeechEvent.originX`/`originY`から対象までの
 *   距離をしきい値(`audibility`)と比較して別途決定する。
 * - `audience === "nearby"`の場合、除外後の候補全員について、距離としきい値の比較で`heard`を
 *   個別に決定した`SpeechReceptionEvent`を生成する(圏外の候補も`heard: false`として記録され、
 *   `speechLog`側から「なぜ聞こえなかったか」を遡って追跡できる)。
 *
 * 発言後にagentが移動しても結果が変わらないのは、`speech.originX`/`originY`が発言生成時点で
 * 固定されたスナップショットであり、かつ`candidates`もこの関数が呼ばれた時点(=そのtickの処理内)
 * の位置を渡す一度限りの評価だからである(結果は`SimulationState.speechReceptionLog`に永続化され、
 * 再計算されることはない)。
 *
 * 同一`speechEvents`・同一`candidates`に対して常に同じ順序・内容の配列を返す(`candidates`の
 * 並び順をそのまま使うため、呼び出し側で安定した順序を渡すこと)。
 */
export function deriveSpeechReceptions(
  speechEvents: SpeechEvent[],
  candidates: SpeechReceiverCandidate[],
  config: SpeechEffectsConfig,
): SpeechReceptionEvent[] {
  if (!config.enabled) return [];

  const events: SpeechReceptionEvent[] = [];
  for (const speech of speechEvents) {
    const eligible = candidates.filter((candidate) => isEligibleReceiver(candidate, speech.speakerId));

    if (speech.target !== undefined) {
      const target = eligible.find((candidate) => candidate.id === speech.target);
      if (!target) continue;
      events.push(buildReception(speech, target, "target"));
      continue;
    }

    if (speech.audience === "nearby") {
      for (const receiver of eligible) {
        events.push(buildReception(speech, receiver, "audience"));
      }
    }
  }
  return events;
}

/**
 * `receptions`から、対応する`SpeechEvent`の`intent`だけを入力要因とする固定の解釈対応表で
 * `SpeechInterpretationEvent`を導出する純粋関数。受け手の性格・既存関係性は一切参照しない
 * (対応しない範囲)。`SimulationState`・rngのいずれも参照/変更しない。
 *
 * `heard: false`の受信(圏外で聞こえなかった)は解釈対象にしない(Issue #94: `deriveSpeechReceptions`が
 * 距離に基づき`heard`を判定するようになったことに伴う、聞いていないものは解釈しないという整合性維持)。
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
    if (!reception.heard) continue;
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
