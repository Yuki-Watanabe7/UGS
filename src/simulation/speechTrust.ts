import type { Agent, AgentState } from "./types";
import type { SpeechEvent, SpeechExpressionLink, SpeechIntent } from "./speech";
import { DEFAULT_SPEECH_RANGE } from "./speech";
// SpeechReceptionEventは型のみの参照(実行時依存なし)。relationshipTrust/SpeechTrustResolverは
// 実行時依存だが、speechEffects.ts側は本ファイルをimportしないため循環参照にはならない。
import type { SpeechReceptionEvent, SpeechTrustResolver } from "./speechEffects";
import { relationshipTrust } from "./speechEffects";
import { clamp } from "./model";

/**
 * Phase 4(Issue #116): 発言の真実性評価と、受け手ごとの動的な信頼(trust)更新モデル。
 *
 * 2つの独立した記録・状態を扱う:
 *
 * 1. 話者側 — 真実性(`SpeechTruthfulnessRecord`): 発話時点の本心(`PrivateEvaluation`)と
 *    対外表現(`PublicExpression`)の一致度を、Issue #115の乖離スナップショット
 *    (`SpeechEvent.expression`、`SpeechExpressionLink`)だけから決定的に導出した記録。
 *    受け手には一切見えない(本心は他エージェントに認知されない)ため、下記のtrust更新の
 *    入力にはならない純粋な観察・追跡用データ。
 *
 * 2. 受け手側 — 動的trust(`SpeechTrustState`): pair単位(受け手→話者の方向つき)の信頼値。
 *    - 初期値は既存の静的`relationshipTrust`(`speechEffects.ts`)の値。値が更新されたpairのみ
 *      `SpeechTrustState`に保持され、未登場のpairは常に静的初期値として解決される
 *      (`createSpeechTrustResolver`)。
 *    - 更新は決定的(rng不使用)で、常に[0, 1]へclampされる。
 *    - 観測条件(固定): 受け手が (a) その発言を発話時点で認知していて(Phase 3の
 *      `SpeechReceptionEvent.heard === true`)、かつ (b) 話者が発言intentと一致/不一致な行動
 *      (状態遷移)をとったtickに、話者から知覚範囲(`SPEECH_TRUST_OBSERVATION_RANGE`、Phase 3の
 *      可聴判定と同じ「距離としきい値の比較」モデル)内にいる場合のみ更新される。
 *    - 更新は`SpeechTrustUpdateEvent`として構造化記録され、いつ(tick)・何を観測して
 *      (speechEventId・観測した状態遷移・一致/不一致)・どれだけ変化したか(previous/new/delta)を
 *      常に追跡できる。
 *
 * `existingTieStrength`・personality基礎値(`willingness`/`conformity`等)は一切変更しない
 * (trustは`SimulationState.speechTrust`という別スロットにのみ保持される)。
 *
 * Phase 3との接続: config ON時、`deriveSpeechInterpretations`(`speechEffects.ts`)は
 * `createSpeechTrustResolver`が返すresolver経由で動的trustをtrust係数として参照する。
 * OFF時(デフォルト)はresolverが渡されず、従来の静的`relationshipTrust`式が維持される。
 * trust更新の観測はPhase 3の認知記録(reception)を前提にするため、`SpeechEffectsConfig.enabled`が
 * falseの間は観測候補(hearer)が存在せず、trustは初期値のまま一切変化しない。
 *
 * 対応しない範囲(Issue #116): 整合性履歴の蓄積に基づく関係性(tie)変化(#117)、trustのUI表示
 * (#119)、intent→効果次元マッピングの変更。詳細は`docs/speech-trust-model.md`参照。
 */

/** Phase 4 trust更新の有効/無効を切り替える設定境界。既存configと同じ後方互換パターン */
export type SpeechTrustConfig = {
  /**
   * false(デフォルト)の場合、本ファイルの導出関数はすべて空配列/入力そのままを返し、
   * `deriveSpeechInterpretations`は従来の静的trust式を使う(既存挙動との完全な後方互換)。
   */
  enabled: boolean;
};

/** 未指定時に使う既定値。既存の呼び出し元を一切変更せずに済むよう無効化しておく */
export const DEFAULT_SPEECH_TRUST_CONFIG: SpeechTrustConfig = { enabled: false };

/** 部分指定を`DEFAULT_SPEECH_TRUST_CONFIG`で補完した`SpeechTrustConfig`を返す */
export function resolveSpeechTrustConfig(config?: Partial<SpeechTrustConfig>): SpeechTrustConfig {
  return { ...DEFAULT_SPEECH_TRUST_CONFIG, ...config };
}

/**
 * 話者側: 発言1件の真実性(発話時点の本心と対外表現の一致度)の記録。
 * Issue #115の乖離スナップショット(`SpeechExpressionLink`)を持つ発言についてのみ生成される
 * (スナップショットがない発言=socialExpression無効時の発言・介入由来の`lightObserverInvitation`は
 * 乖離情報が存在しないため評価対象外)。全フィールドが発話時点の値の複製であり、後から変化しない。
 */
export type SpeechTruthfulnessRecord = {
  id: string;
  speechEventId: string;
  tick: number;
  speakerId: string;
  /** 実際に発せられたintent(乖離調整後) */
  intent: SpeechIntent;
  /** 乖離調整前の基礎intent(`SpeechExpressionLink.baseIntent`の複製) */
  baseIntent: SpeechIntent;
  /** 発話時点の本心側スタンス(`SpeechExpressionLink.privateStance`の複製) */
  privateStance: SpeechExpressionLink["privateStance"];
  /** 発話時点の対外表現側スタンス(`SpeechExpressionLink.expressedStance`の複製) */
  expressedStance: SpeechExpressionLink["expressedStance"];
  /** 発話時点で本心と対外表現に乖離があったか(`SpeechExpressionLink.divergent`の複製) */
  divergent: boolean;
  /** 一致度(0〜1)。1=完全一致。導出規則は`truthfulnessOf`参照 */
  truthfulness: number;
};

/** 乖離あり(divergent)の発言の真実性上限。スタンス・intentに現れない次元(leaveInclination等)の乖離を反映する */
const DIVERGENT_TRUTHFULNESS_MAX = 0.75;

/**
 * 発話時点の乖離スナップショットから真実性(一致度、0〜1)を決定的に導出する。
 *
 * 規則(固定):
 * - 乖離なし(`divergent: false`)なら常に1(完全一致)。
 * - 乖離ありなら、スタンス一致度(同一=1、片方が"none"=0.5、positive対negative=0)と
 *   intent一致度(基礎intentのまま=1、乖離により置換された=0.5)の積を、
 *   `DIVERGENT_TRUTHFULNESS_MAX`(0.75)を上限として採用する。上限があるのは、スタンス・intentが
 *   一致していても乖離フラグが立つケース(leaveInclination次元のみの乖離、例: 印象管理による
 *   離脱傾向の緩和)を「完全に真実」とは区別するため。
 *
 * 代表例: 社交辞令の辞退(本心positive・表現none・declineのまま)= 0.5、
 * 遠慮による軟化(本心positive・表現none・invite→greet)= 0.25、
 * 印象管理のみの乖離(スタンス・intent一致)= 0.75。
 */
export function truthfulnessOf(intent: SpeechIntent, link: SpeechExpressionLink): number {
  if (!link.divergent) return 1;
  const stanceScore =
    link.privateStance === link.expressedStance
      ? 1
      : link.privateStance === "none" || link.expressedStance === "none"
        ? 0.5
        : 0;
  const intentScore = intent === link.baseIntent ? 1 : 0.5;
  return Math.min(stanceScore * intentScore, DIVERGENT_TRUTHFULNESS_MAX);
}

/**
 * このtickの発言(乖離調整後)から`SpeechTruthfulnessRecord`を導出する純粋関数。
 * `SimulationState`・rngのいずれも参照/変更しない。乖離スナップショット(`SpeechEvent.expression`)を
 * 持たない発言は評価対象にしない(乖離情報が存在しないため。socialExpression無効時は全発言が該当し、
 * 結果は常に空配列になる)。
 */
export function deriveSpeechTruthfulness(
  speechEvents: SpeechEvent[],
  config: SpeechTrustConfig,
): SpeechTruthfulnessRecord[] {
  if (!config.enabled) return [];

  const records: SpeechTruthfulnessRecord[] = [];
  for (const speech of speechEvents) {
    const link = speech.expression;
    if (!link) continue;
    records.push({
      id: `truthfulness-${speech.id}`,
      speechEventId: speech.id,
      tick: speech.tick,
      speakerId: speech.speakerId,
      intent: speech.intent,
      baseIntent: link.baseIntent,
      privateStance: link.privateStance,
      expressedStance: link.expressedStance,
      divergent: link.divergent,
      truthfulness: truthfulnessOf(speech.intent, link),
    });
  }
  return records;
}

/**
 * pair単位(受け手→話者の方向つき)の動的trust値。キーは`speechTrustPairKey(observerId, speakerId)`。
 * 更新が一度でも発生したpairのみ保持し、未登場のpairは静的`relationshipTrust`が初期値として
 * 解決される(`createSpeechTrustResolver`参照)。
 */
export type SpeechTrustState = Record<string, number>;

/** `SpeechTrustState`のキー。方向つき(observer→speakerとspeaker→observerは別pair) */
export function speechTrustPairKey(observerId: string, speakerId: string): string {
  return `${observerId}->${speakerId}`;
}

/**
 * `deriveSpeechInterpretations`(`speechEffects.ts`)へ渡すtrust解決関数を作る。
 * 動的値が登録済みのpairはその値を、未登場のpairは静的`relationshipTrust`
 * (=動的trustの初期値)を返すため、更新が一度も起きていないpairの解釈結果は
 * 静的式(config OFF時)と完全に一致する。
 */
export function createSpeechTrustResolver(trust: SpeechTrustState, existingTieStrength: number): SpeechTrustResolver {
  return (receiverId, speakerId, sameClique) =>
    trust[speechTrustPairKey(receiverId, speakerId)] ?? relationshipTrust(sameClique, existingTieStrength);
}

/**
 * 未観測の発言コミットメント: 「この発言のintentに対して、話者がその後どう行動するか」を
 * まだ観測していない発言1件分の進行状態。話者が決定的な状態遷移(`classifyTrustObservation`が
 * 一致/不一致を返す遷移)をとったtickに解決され、取り除かれる。
 * `hearerIds`は発話時点で認知した(`heard: true`)受け手のスナップショットで、
 * trust更新の観測資格を持つのはこの受け手のみ(聞いていない発言との一致/不一致は観測できない)。
 */
export type SpeechTrustCommitment = {
  speechEventId: string;
  /** 発言が発生したtick */
  tick: number;
  speakerId: string;
  intent: SpeechIntent;
  hearerIds: string[];
};

/** 観測結果: 発言intentとその後の話者の行動が一致したか */
export type SpeechTrustObservation = "consistent" | "inconsistent";

/**
 * 受け手1人分のtrust更新の構造化記録。「いつ(tick)・何を観測して(speechEventId・観測した
 * 状態遷移・一致/不一致)・どれだけ変化したか(previousTrust/newTrust/delta)」を追跡できる。
 */
export type SpeechTrustUpdateEvent = {
  id: string;
  /** 観測(話者の行動)が発生したtick */
  tick: number;
  observerId: string;
  speakerId: string;
  /** 観測対象になった発言 */
  speechEventId: string;
  intent: SpeechIntent;
  /** 観測された話者の状態遷移(遷移前) */
  observedFromState: AgentState;
  /** 観測された話者の状態遷移(遷移後)。`classifyTrustObservation`の判定対象 */
  observedToState: AgentState;
  observation: SpeechTrustObservation;
  /** 観測時点の受け手→話者の距離(観測条件`SPEECH_TRUST_OBSERVATION_RANGE`との比較に使った実測値) */
  distance: number;
  previousTrust: number;
  newTrust: number;
  /** newTrust - previousTrust(clamp適用後の実際の変化量) */
  delta: number;
};

/**
 * 行動観測の知覚範囲。Phase 3の可聴/認知判定(`deriveSpeechReceptions`)と同じ
 * 「距離としきい値の比較」モデルを使い、しきい値には発言の基礎到達距離`DEFAULT_SPEECH_RANGE`(200)を
 * そのまま流用する(「声が届く範囲=様子が見える範囲」という対応を`EXPRESSION_AUDIBLE_RANGE`
 * (socialExpression.ts)と一貫させる)。
 */
export const SPEECH_TRUST_OBSERVATION_RANGE = DEFAULT_SPEECH_RANGE;

/** 一致観測1回あたりのtrust上昇量 */
export const TRUST_CONSISTENT_DELTA = 0.05;
/** 不一致観測1回あたりのtrust低下量(信頼は壊れるときの方が大きく動く非対称) */
export const TRUST_INCONSISTENT_DELTA = -0.2;

/**
 * intentごとの、話者のその後の行動(状態遷移先)との一致/不一致の固定判定表。
 * undefined = どちらとも決まらない遷移(コミットメントは未観測のまま保留される)。
 *
 * - invite/welcome/greet(参加方向の発言): "joined"への遷移=一致、"leaving"への遷移=不一致
 *   (例: 輪へ誘っておきながら自分は帰り始めた founder)。
 * - decline(離脱表明): "left"への遷移=一致、"approaching"/"joined"への遷移=不一致
 *   (Issue #116の例「decline発言後に輪へjoinした」。現行engineではleavingからの復帰経路が
 *   存在しないため実際には発生しないが、判定表としては将来の遷移追加に備えて固定しておく)。
 */
export function classifyTrustObservation(intent: SpeechIntent, toState: AgentState): SpeechTrustObservation | undefined {
  if (intent === "decline") {
    if (toState === "left") return "consistent";
    if (toState === "approaching" || toState === "joined") return "inconsistent";
    return undefined;
  }
  if (toState === "joined") return "consistent";
  if (toState === "leaving") return "inconsistent";
  return undefined;
}

/** `deriveSpeechTrustUpdates`の戻り値。すべて新しいオブジェクト/配列(入力はmutationしない) */
export type SpeechTrustStepResult = {
  /** このtickに発生したtrust更新の記録(発生しなければ空配列) */
  updates: SpeechTrustUpdateEvent[];
  /** 更新適用後の動的trust状態 */
  trust: SpeechTrustState;
  /** 解決済み(観測完了)を取り除いた残りのコミットメント */
  commitments: SpeechTrustCommitment[];
};

/**
 * 未観測コミットメントを、このtickの話者の状態遷移(`previousAgents`→`nextAgents`)と突き合わせ、
 * trust更新を導出する純粋関数。rngを一切使わず、同一入力に対して常に同一の結果を返す
 * (同一seed・同一設定でtrustの時系列が再現される根拠)。
 *
 * 処理規則(固定):
 * - コミットメントは登録順(=発言の生成順)に処理する。同一observerに同一tickで複数の更新が
 *   発生する場合(同じ話者の複数の発言が同じ遷移で解決される等)も、この順で逐次適用される。
 * - 話者の状態が変わっていない、または`classifyTrustObservation`がundefinedを返す遷移では
 *   コミットメントを保留のまま残す。
 * - 一致/不一致が確定した遷移では、`hearerIds`のうち観測条件を満たす受け手
 *   (現存し、"left"でなく、観測tickの話者位置から`SPEECH_TRUST_OBSERVATION_RANGE`以内)全員の
 *   trustを更新し、コミットメントを取り除く(1発言につき観測は1回限り。範囲外だった受け手は
 *   その観測機会を失うだけで、後から遡って更新されることはない)。
 * - 話者が`previousAgents`/`nextAgents`に見つからない場合(防御的、通常は起こらない)は
 *   観測不能としてコミットメントを取り除く。
 */
export function deriveSpeechTrustUpdates(
  commitments: SpeechTrustCommitment[],
  previousAgents: Agent[],
  nextAgents: Agent[],
  trust: SpeechTrustState,
  existingTieStrength: number,
  tick: number,
  config: SpeechTrustConfig,
): SpeechTrustStepResult {
  if (!config.enabled) return { updates: [], trust: { ...trust }, commitments: [...commitments] };

  const previousById = new Map(previousAgents.map((agent) => [agent.id, agent]));
  const nextById = new Map(nextAgents.map((agent) => [agent.id, agent]));

  const updates: SpeechTrustUpdateEvent[] = [];
  const nextTrust: SpeechTrustState = { ...trust };
  const remaining: SpeechTrustCommitment[] = [];

  for (const commitment of commitments) {
    const speakerBefore = previousById.get(commitment.speakerId);
    const speakerAfter = nextById.get(commitment.speakerId);
    if (!speakerBefore || !speakerAfter) continue;

    if (speakerBefore.state === speakerAfter.state) {
      remaining.push(commitment);
      continue;
    }
    const observation = classifyTrustObservation(commitment.intent, speakerAfter.state);
    if (!observation) {
      remaining.push(commitment);
      continue;
    }

    for (const hearerId of commitment.hearerIds) {
      const observer = nextById.get(hearerId);
      if (!observer || observer.state === "left" || observer.id === commitment.speakerId) continue;
      const dist = Math.hypot(observer.x - speakerAfter.x, observer.y - speakerAfter.y);
      if (dist > SPEECH_TRUST_OBSERVATION_RANGE) continue;

      const sameClique = observer.cliqueId !== undefined && observer.cliqueId === speakerAfter.cliqueId;
      const key = speechTrustPairKey(observer.id, commitment.speakerId);
      const previousTrust = nextTrust[key] ?? relationshipTrust(sameClique, existingTieStrength);
      const delta = observation === "consistent" ? TRUST_CONSISTENT_DELTA : TRUST_INCONSISTENT_DELTA;
      const newTrust = clamp(previousTrust + delta, 0, 1);
      nextTrust[key] = newTrust;

      updates.push({
        id: `trust-${tick}-${observer.id}-${commitment.speechEventId}`,
        tick,
        observerId: observer.id,
        speakerId: commitment.speakerId,
        speechEventId: commitment.speechEventId,
        intent: commitment.intent,
        observedFromState: speakerBefore.state,
        observedToState: speakerAfter.state,
        observation,
        distance: dist,
        previousTrust,
        newTrust,
        delta: newTrust - previousTrust,
      });
    }
  }

  return { updates, trust: nextTrust, commitments: remaining };
}

/**
 * このtickの発言(乖離調整後)と認知結果から、新しいコミットメントを既存の残りへ追記する純粋関数。
 * 発話時点で認知した受け手(`heard: true`)が1人もいない発言は、trust更新の観測者が存在しえないため
 * コミットメントを作らない。発言とその発言自体を生んだ状態遷移(例: leaving遷移とdecline発言)が
 * 同一tickで自己解決しないよう、登録はそのtickの`deriveSpeechTrustUpdates`の後に行うこと
 * (engine.ts側でこの順序を固定している)。
 */
export function registerSpeechTrustCommitments(
  commitments: SpeechTrustCommitment[],
  speechEvents: SpeechEvent[],
  receptions: SpeechReceptionEvent[],
  config: SpeechTrustConfig,
): SpeechTrustCommitment[] {
  if (!config.enabled) return [...commitments];

  const next = [...commitments];
  for (const speech of speechEvents) {
    const hearerIds = receptions
      .filter((reception) => reception.speechEventId === speech.id && reception.heard)
      .map((reception) => reception.receiverId);
    if (hearerIds.length === 0) continue;
    next.push({
      speechEventId: speech.id,
      tick: speech.tick,
      speakerId: speech.speakerId,
      intent: speech.intent,
      hearerIds,
    });
  }
  return next;
}
