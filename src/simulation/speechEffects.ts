import type { Agent, AgentState } from "./types";
import type { SpeechEvent, SpeechIntent, SpeechReason } from "./speech";
import { clamp } from "./model";

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
 * - `SpeechInterpretationEvent`(本ファイル): `SpeechReceptionEvent`1件につき、受け手の性格
 *   (`conformity`/`influenceAvoidance`)・話者との関係(同一clique/`existingTieStrength`から導出する
 *   基礎信頼)・現在の`stress`/`state`・target/nearbyの別・`SpeechEvent.strength`を要因として、
 *   決定的な数値モデルでどう解釈したか(`valence`/`intensity`)を`factors`の内訳付きで記録する(Issue #95)。
 *   `heard: false`の受信(聞こえなかった)は解釈対象にならない。
 *   **これは実在の人間の受け止め方を断定的に分類・予測するモデルではなく、シミュレーション内の
 *   決定的な数値ルールに過ぎない。** 可変の「信頼学習」(発言を重ねるほど信頼が変化する等)や
 *   本心と建前の不一致、発言の真実性判定は対応しない範囲。
 * - `SpeechEffectEvent`(本ファイル): `SpeechInterpretationEvent`1件につき、どの状態次元へ・どの強度/期間で
 *   作用しうるかを構造化して保持する記録。**実際にAgentの状態(stress等)へ適用する処理はPhase 4以降の
 *   スコープであり、本ファイルの`deriveSpeechEffects`は記録を生成するだけで、いかなるAgent/SimulationState
 *   も参照・変更しない。**
 *
 * 3段階(reception -> interpretation -> effect)は`speechEventId`で、interpretation/effectは
 * さらに`receptionEventId`/`interpretationEventId`で前段と一意に関連付けられる。全段が`receiverId`も
 * 保持するため、「誰にとっての記録か」はどの段からでも直接参照できる。
 *
 * Phase 3.1(#94)の対応しない範囲(認知判定`deriveSpeechReceptions`側):
 * - 遮蔽物・方向・騒音場の物理モデル(距離としきい値比較のみ。障害物や音の伝わり方は考慮しない)
 * - 確率的な聞き漏らし(`heard`は距離としきい値から一意に決まる決定的な判定であり、rngは使わない)
 * - 心理状態や行動選択への効果(認知判定はAgent.stress等を一切変更しない)
 * - UI表示(Inspector等の表示層は引き続き`SpeechEvent`の`target`/`audience`ベースの簡略化を使う。
 *   `docs/speech-reception-distance-model.md`参照)
 *
 * Issue #95(受け手別の解釈モデル、`deriveSpeechInterpretations`)の対応しない範囲:
 * - 時間とともに変化する信頼・評判(常に現在の関係性から一意に導出する固定値のみを使う)
 * - 発言の真実性判定・本心と建前の不一致・LLMによる文章解釈
 * - 解釈結果をAgent.stress等の状態変数へ実際に適用する処理、複数発言の集約、UI表示
 *   (`deriveSpeechEffects`が生成する記録は引き続き構造化された記録に留まる。詳細は
 *   `docs/speech-interpretation-model.md`参照)
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

/**
 * `deriveSpeechInterpretations`が導く解釈の作用方向。intentごとの基礎方向
 * (invite/welcome/greetは正、declineは負)を出発点に、受け手の性格・関係性・状態で強度が変わる
 * (Issue #95)。最終`intensity`が`NEUTRAL_INTENSITY_THRESHOLD`未満まで弱まった場合は、
 * 基礎方向によらず"neutral"として扱う(「ほぼ何も感じなかった」を方向なしとして丸める)。
 */
export type SpeechInterpretationValence = "positive" | "neutral" | "negative";

/**
 * `deriveSpeechInterpretations`が解釈強度を構成する各要因を説明可能にするための内訳1件分。
 * `rawValue`は正規化前の生値(性格パラメータやstress、`SpeechEvent.strength`等)、
 * `normalizedValue`は0〜1(内容によりそれ以上)へ丸めた値、`contribution`はこの要因が最終
 * `intensity`の乗算計算に実際に寄与した係数(0以上。方向の符号は`SpeechInterpretationEvent.valence`側で表現する)。
 */
export type SpeechInterpretationFactor = {
  key:
    | "intentBase"
    | "conformity"
    | "influenceAvoidance"
    | "relationshipTrust"
    | "receiverStress"
    | "receiverState"
    | "receptionRelation"
    | "strength";
  rawValue: number;
  normalizedValue: number;
  contribution: number;
};

/**
 * `SpeechReceptionEvent`1件につき、受け手がどの要因でどう解釈したかの記録(Issue #95)。
 * `factors`が入力値・正規化値・寄与の内訳、`intensity`(0〜1)が最終解釈強度、`valence`が作用方向。
 *
 * **重要: これは実在の人間の受け止め方を断定的に分類・予測するモデルではない。** 性格パラメータ
 * (`conformity`/`influenceAvoidance`)・関係性(`existingTieStrength`・同一clique)・`stress`/`state`から
 * 決定的に導かれる、シミュレーション内の数値ルールに過ぎず、現実の人間の解釈を代表・断定するものではない。
 */
export type SpeechInterpretationEvent = {
  id: string;
  speechEventId: string;
  receptionEventId: string;
  tick: number;
  receiverId: string;
  intent: SpeechIntent;
  /** 発言がtarget宛てだったかnearby(周囲)向けだったか。`SpeechReceptionEvent.relation`と同値 */
  relation: SpeechReceptionRelation;
  valence: SpeechInterpretationValence;
  /** 最終的な解釈強度(0〜1にclamp済み) */
  intensity: number;
  /** intensityを構成した各要因の内訳。`intentBase`から`strength`まで固定順で保持する */
  factors: SpeechInterpretationFactor[];
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

/**
 * `deriveSpeechInterpretations`が必要とする最小限のAgent情報。位置・生存状態だけに絞った
 * `SpeechReceiverCandidate`とは異なり、解釈の入力要因になる性格パラメータ・関係性・現在状態を持つ。
 * 話者自身の`cliqueId`(同一clique判定用)を引くためにも同じ配列に含めて渡す。
 */
export type SpeechInterpreterCandidate = Pick<
  Agent,
  "id" | "conformity" | "influenceAvoidance" | "cliqueId" | "stress" | "state"
>;

/**
 * intentごとの基礎的な意味と作用方向(Issue #95の受入条件)。invite/welcomeは接近可能性・安心感を
 * 上げる方向、greetは周囲の社会的手がかりを補強する方向(同じく正方向だが控えめ)、declineは対象の輪の
 * 魅力度を下げ曖昧さ/stressを上げうる方向。ここでの`magnitude`は他要因による減衰前の上限値であり、
 * 実際の`intensity`は下記の各係数(0〜1程度)を乗算して決まる。
 */
const INTENT_BASE: Record<SpeechIntent, { direction: 1 | -1; magnitude: number }> = {
  invite: { direction: 1, magnitude: 0.6 },
  welcome: { direction: 1, magnitude: 0.6 },
  greet: { direction: 1, magnitude: 0.35 },
  decline: { direction: -1, magnitude: 0.5 },
};

/** 最終intensityがこの値未満まで弱まった場合、方向の符号によらず"neutral"として丸める */
const NEUTRAL_INTENSITY_THRESHOLD = 0.05;

/** conformityが高い受け手ほど、場の空気(発言が示す方向)をより強く受け止める */
function conformityFactor(conformity: number): number {
  return clamp(0.5 + 0.5 * clamp(conformity, 0, 1), 0, 1);
}

/**
 * influenceAvoidanceが高い受け手ほど、発言の効果を弱く受け止める。名指し(target)されるほど
 * 「自分に矛先が向いた」ことへの抵抗が強く働くため、nearby(周囲向け)より減衰が大きい
 */
function influenceAvoidanceFactor(influenceAvoidance: number, relation: SpeechReceptionRelation): number {
  const weight = relation === "target" ? 0.6 : 0.25;
  return clamp(1 - clamp(influenceAvoidance, 0, 1) * weight, 0, 1);
}

/**
 * 話者への基礎信頼スコア。現在の関係性(同一clique/`existingTieStrength`)から決定的に導出する固定値
 * (可変の信頼学習は対応しない範囲)。同一cliqueなら既存関係性が強いほど信頼が上がり、そうでなければ
 * 既存関係性が強い場ほど部外者への基礎信頼が下がる(`engine.ts`の`attractiveness`が使う
 * outsiderPenaltyと同じ非対称性)。
 */
function relationshipTrust(sameClique: boolean, existingTieStrength: number): number {
  const tie = clamp(existingTieStrength, 0, 1);
  const trust = sameClique ? 0.5 + 0.5 * tie : 0.5 - 0.4 * tie;
  return clamp(trust, 0, 1);
}

/**
 * 現在のstressが高いほど、正方向の発言(invite/welcome/greet)は素直に受け止めにくくなり、
 * 負方向の発言(decline)はより強く受け止めてしまう
 */
function stressFactor(stress: number, direction: 1 | -1): number {
  const clampedStress = clamp(stress, 0, 1);
  return direction > 0 ? clamp(1 - clampedStress * 0.4, 0, 1) : clamp(1 + clampedStress * 0.5, 0, 1.5);
}

/** 受け手の現在stateによる関連度。既に何らかの決着へ進んでいるほど、発言の効果は薄れる */
const STATE_RELEVANCE: Record<AgentState, number> = {
  undecided: 1,
  forming: 0.7,
  approaching: 0.6,
  joined: 0.3,
  leaving: 0.5,
  left: 0,
};

/** 名指し(target)された発言は、周囲向け(nearby)の発言より強く受け止められる */
function relationFactor(relation: SpeechReceptionRelation): number {
  return relation === "target" ? 1 : 0.7;
}

/** `SpeechEvent.strength`をそのまま倍率として使う。異常値(NaN/負値/極端な値)を防ぐためclampする */
function strengthFactor(strength: number): number {
  if (!Number.isFinite(strength)) return 1;
  return clamp(strength, 0, 2);
}

/** valence(作用方向)のみに基づく固定の効果量対応表(受け手の性格には依存しない、構造化された記録用の値) */
const VALENCE_STRESS_EFFECT: Record<SpeechInterpretationValence, { outputValue: number; durationTicks: number }> = {
  positive: { outputValue: -0.05, durationTicks: 5 },
  neutral: { outputValue: 0, durationTicks: 0 },
  negative: { outputValue: 0.08, durationTicks: 6 },
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
 * `receptions`から、受け手別の`SpeechInterpretationEvent`を導出する純粋関数(Issue #95)。
 * intentごとの基礎的な意味と作用方向(`INTENT_BASE`)を出発点に、受け手の性格
 * (`conformity`/`influenceAvoidance`)・話者との関係(同一clique/`existingTieStrength`から導出する
 * 基礎信頼)・現在の`stress`/`state`・target/nearbyの別・`SpeechEvent.strength`を乗算的な係数として
 * 反映し、決定的に`valence`/`intensity`/`factors`を計算する。`SimulationState`・rngのいずれも
 * 参照/変更しない。可変の「信頼学習」は導入せず、`existingTieStrength`は呼び出し時点の固定値として使う。
 *
 * `heard: false`の受信(圏外で聞こえなかった)は解釈対象にしない(Issue #94: `deriveSpeechReceptions`が
 * 距離に基づき`heard`を判定するようになったことに伴う、聞いていないものは解釈しないという整合性維持)。
 * 話者または受け手が`participants`に見つからない場合(防御的、通常は起こらない)も対象にしない。
 *
 * すべての中間値・最終値は有限範囲へclampされ、NaN/Infinityが混入しても`strengthFactor`等の
 * ガードにより出力は常に有限のまま(順序依存も持たない純粋な計算)。
 */
export function deriveSpeechInterpretations(
  receptions: SpeechReceptionEvent[],
  speechEvents: SpeechEvent[],
  participants: SpeechInterpreterCandidate[],
  existingTieStrength: number,
  config: SpeechEffectsConfig,
): SpeechInterpretationEvent[] {
  if (!config.enabled) return [];

  const speechById = new Map(speechEvents.map((speech) => [speech.id, speech]));
  const participantById = new Map(participants.map((participant) => [participant.id, participant]));

  const events: SpeechInterpretationEvent[] = [];
  for (const reception of receptions) {
    if (!reception.heard) continue;
    const speech = speechById.get(reception.speechEventId);
    if (!speech) continue;
    const receiver = participantById.get(reception.receiverId);
    if (!receiver) continue;
    const speaker = participantById.get(speech.speakerId);

    const base = INTENT_BASE[speech.intent];
    const sameClique =
      speaker !== undefined && receiver.cliqueId !== undefined && receiver.cliqueId === speaker.cliqueId;

    const cFactor = conformityFactor(receiver.conformity);
    const iFactor = influenceAvoidanceFactor(receiver.influenceAvoidance, reception.relation);
    const trust = relationshipTrust(sameClique, existingTieStrength);
    const sFactor = stressFactor(receiver.stress, base.direction);
    const stateFactor = STATE_RELEVANCE[receiver.state];
    const relFactor = relationFactor(reception.relation);
    const strFactor = strengthFactor(speech.strength);

    const rawMagnitude = base.magnitude * cFactor * iFactor * trust * sFactor * stateFactor * relFactor * strFactor;
    const intensity = clamp(rawMagnitude, 0, 1);
    const valence: SpeechInterpretationValence =
      intensity < NEUTRAL_INTENSITY_THRESHOLD ? "neutral" : base.direction > 0 ? "positive" : "negative";

    const factors: SpeechInterpretationFactor[] = [
      { key: "intentBase", rawValue: base.direction, normalizedValue: base.magnitude, contribution: base.magnitude },
      { key: "conformity", rawValue: receiver.conformity, normalizedValue: clamp(receiver.conformity, 0, 1), contribution: cFactor },
      {
        key: "influenceAvoidance",
        rawValue: receiver.influenceAvoidance,
        normalizedValue: clamp(receiver.influenceAvoidance, 0, 1),
        contribution: iFactor,
      },
      {
        key: "relationshipTrust",
        rawValue: existingTieStrength,
        normalizedValue: sameClique ? 1 : 0,
        contribution: trust,
      },
      { key: "receiverStress", rawValue: receiver.stress, normalizedValue: clamp(receiver.stress, 0, 1), contribution: sFactor },
      { key: "receiverState", rawValue: stateFactor, normalizedValue: stateFactor, contribution: stateFactor },
      { key: "receptionRelation", rawValue: relFactor, normalizedValue: relFactor, contribution: relFactor },
      { key: "strength", rawValue: speech.strength, normalizedValue: strFactor, contribution: strFactor },
    ];

    events.push({
      id: `interpretation-${reception.id}`,
      speechEventId: reception.speechEventId,
      receptionEventId: reception.id,
      tick: reception.tick,
      receiverId: reception.receiverId,
      intent: speech.intent,
      relation: reception.relation,
      valence,
      intensity,
      factors,
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
