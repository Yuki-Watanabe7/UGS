import type { Agent, AgentState } from "./types";
import type { SpeechEvent, SpeechIntent } from "./speech";
import { DEFAULT_SPEECH_RANGE } from "./speech";
// SpeechReceptionEventは型のみ、classifyTrustObservationはintent→行動の整合性判定の単一の
// 情報源として#116から再利用する(関係性tie補正でも「発言intentと話者の行動の一致/不一致」の
// 判定表は同一。純粋関数の再利用でありconfig依存はない。依存方向はrelationshipTie -> speechTrustの一方向)。
import type { SpeechReceptionEvent, SpeechTrustResolver } from "./speechEffects";
import { classifyTrustObservation } from "./speechTrust";
import { clamp } from "./model";

/**
 * Phase 4(Issue #117): 過去の発言と行動の整合性の**積み重ね**が、pair間の関係性(親密さ・距離感)
 * そのものを変えるモデル。#116のtrust更新が単発観測に対する解釈係数の変化だったのに対し、こちらは
 * 発言intentとその後の話者の実際の行動(`AgentState`遷移)の一致/不一致を**整合性履歴**として
 * 蓄積し、その履歴から決定的に導く関係性補正値(tie補正)を持つ。
 *
 * 反映先(固定、2箇所):
 * 1. `attractiveness()`(engine.ts)の同clique bonus / outsider penalty ―― 観測者が輪の構成員に対して
 *    積み上げた整合性履歴に応じて、その輪の魅力度が上下する(`aggregateGroupTieCorrection`で
 *    構成員pairの補正を集約し、正なら魅力度増・負なら減の**加算方式**で反映)。
 * 2. 解釈モデル(`deriveSpeechInterpretations`、speechEffects.ts)の関係性係数`relFactor` ――
 *    受け手→話者pairの補正を`relFactor`へ**加算**する(`createTieCorrectionResolver`経由)。
 *
 * 反映方式は両箇所とも**加算**に固定する(乗算は使わない)。補正値は常に
 * `[-MAX_TIE_CORRECTION, MAX_TIE_CORRECTION]`へclampされ、tick単位で決定的に計算される。
 * 時間減衰は導入せず、履歴保持件数の上限(`TIE_HISTORY_LIMIT`、古いものから破棄)が「忘却」を担う。
 *
 * 決定性・境界:
 * - 本ファイルの関数はすべて純粋関数。`SimulationState`をmutationせず、rngを受け取らない/消費しない
 *   (有効/無効・補正の有無でPRNG消費列は変わらない。同一seed・同一設定で整合性履歴・補正・状態系列が
 *   完全に再現される)。
 * - `existingTieStrength`基礎値・`cliqueId`・personality基礎値は一切変更しない(補正は`tieHistory`
 *   という別スロットにのみ保持され、`attractiveness`/`relFactor`へ一時的な加算として反映される)。
 * - 観測条件は#116と同一の「発話時点で認知(heard: true)し、話者の決定的な遷移を知覚範囲内で観測」に、
 *   さらに「発話から`TIE_OBSERVATION_WINDOW`(N)tick以内」という時間窓を加える(窓内に決定的な遷移が
 *   なければ観測されないまま失効する)。
 * - config OFF(デフォルト)では全導出が空/入力そのままを返し、補正は常に0で従来の計算式と完全一致する。
 * - trust更新(#116)の観測と同様、この観測もPhase 3の認知記録(reception)を前提とするため、
 *   `SpeechEffectsConfig.enabled`がfalseの間はhearerが存在せず、tie ONでも観測・補正は一切発生しない。
 *
 * 対応しない範囲(Issue #117): cliqueの再編成(`cliqueId`変更・移籍)、関係性変化のUI表示(#119)、
 * 新しい行動ルールの追加。詳細は`docs/relationship-tie-model.md`参照。
 */

/** Phase 4 tie補正の有効/無効を切り替える設定境界。既存configと同じ後方互換パターン */
export type RelationshipTieConfig = {
  /**
   * false(デフォルト)の場合、本ファイルの導出関数はすべて空配列/入力そのままを返し、
   * tie補正は常に0(`attractiveness`/`relFactor`は従来式のまま)。既存挙動との完全な後方互換。
   */
  enabled: boolean;
};

/** 未指定時に使う既定値。既存の呼び出し元を一切変更せずに済むよう無効化しておく */
export const DEFAULT_RELATIONSHIP_TIE_CONFIG: RelationshipTieConfig = { enabled: false };

/** 部分指定を`DEFAULT_RELATIONSHIP_TIE_CONFIG`で補完した`RelationshipTieConfig`を返す */
export function resolveRelationshipTieConfig(config?: Partial<RelationshipTieConfig>): RelationshipTieConfig {
  return { ...DEFAULT_RELATIONSHIP_TIE_CONFIG, ...config };
}

/**
 * 発話から話者の決定的な行動を観測できる時間窓(N tick)。この窓内に決定的な遷移
 * (`classifyTrustObservation`が一致/不一致を返す遷移)が起きなければ、その発言は整合性履歴に
 * 記録されないまま失効する(発言の「言いっぱなし」も観測不能として履歴に残さない)。
 */
export const TIE_OBSERVATION_WINDOW = 12;

/** pairごとに保持する整合性観測の上限件数。これを超えると古いものから破棄する(件数上限が忘却を担う) */
export const TIE_HISTORY_LIMIT = 8;

/** 行動観測の知覚範囲。#116(`SPEECH_TRUST_OBSERVATION_RANGE`)と同じ距離モデル・同じ値 */
export const TIE_OBSERVATION_RANGE = DEFAULT_SPEECH_RANGE;

/** 整合性観測1件あたりの補正への寄与。一致は小さく上げ、不一致は大きく下げる非対称(信頼は壊れやすい) */
export const TIE_CONSISTENT_WEIGHT = 0.04;
export const TIE_INCONSISTENT_WEIGHT = -0.1;

/** tie補正値の絶対値上限。履歴由来の補正・輪への集約補正・relFactorへの加算すべてこの範囲へclampする */
export const MAX_TIE_CORRECTION = 0.2;

/** 観測結果: 発言intentとその後の話者の行動が一致したか(#116と同一の判定軸) */
export type TieObservationResult = "consistent" | "inconsistent";

/**
 * 整合性履歴1件分。「どの発言(speechEventId)を発話時点でどう認知し、その後の話者の状態遷移が
 * intentと一致/不一致だったか」を保持する。`weight`はこの観測が補正へ寄与する符号付きの値
 * (どの発言・行動の組が補正へ寄与したかを構造化して追跡できる、という受入条件を満たす記録)。
 */
export type TieConsistencyObservation = {
  speechEventId: string;
  /** 発言が発生したtick */
  speechTick: number;
  /** 決定的な行動を観測した(=履歴へ記録された)tick */
  observedTick: number;
  intent: SpeechIntent;
  observation: TieObservationResult;
  /** 観測された話者の状態遷移(遷移前) */
  observedFromState: AgentState;
  /** 観測された話者の状態遷移(遷移後)。`classifyTrustObservation`の判定対象 */
  observedToState: AgentState;
  /** この観測の補正への符号付き寄与(consistent: +`TIE_CONSISTENT_WEIGHT`、inconsistent: 負) */
  weight: number;
};

/**
 * pair単位(受け手→話者の方向つき)の整合性履歴。キーは`tiePairKey(observerId, speakerId)`。
 * 各値は時系列順(古い→新しい)の観測列で、`TIE_HISTORY_LIMIT`件を超えると先頭(最古)から破棄される。
 * 補正値そのものは保持せず、常に履歴から`correctionFromHistory`で決定的に再計算する(単一の情報源)。
 */
export type RelationshipTieState = Record<string, TieConsistencyObservation[]>;

/** pairごとの補正値(履歴から導出済み)。`RelationshipTieState`から`deriveTieCorrections`で計算する */
export type TieCorrectionState = Record<string, number>;

/** `RelationshipTieState`/`TieCorrectionState`のキー。方向つき(observer→speakerとその逆は別pair) */
export function tiePairKey(observerId: string, speakerId: string): string {
  return `${observerId}->${speakerId}`;
}

/**
 * 整合性履歴1本(あるpairの観測列)から補正値を決定的に計算する。各観測の`weight`の総和を
 * `[-MAX_TIE_CORRECTION, MAX_TIE_CORRECTION]`へclampする(加算合成+範囲clamp、時間減衰なし)。
 * 総和は加算のみで順序に依存しないため、履歴の並びによらず常に同じ値になる。
 */
export function correctionFromHistory(history: TieConsistencyObservation[]): number {
  const sum = history.reduce((total, entry) => total + entry.weight, 0);
  return clamp(sum, -MAX_TIE_CORRECTION, MAX_TIE_CORRECTION);
}

/** `RelationshipTieState`全体から、pairごとの補正値マップを導出する(履歴が空のpairは含めない) */
export function deriveTieCorrections(history: RelationshipTieState): TieCorrectionState {
  const corrections: TieCorrectionState = {};
  for (const [key, observations] of Object.entries(history)) {
    if (observations.length === 0) continue;
    corrections[key] = correctionFromHistory(observations);
  }
  return corrections;
}

/**
 * ある観測者(`observerId`)から見た、輪(構成員`memberIds`)への集約tie補正。構成員各人への
 * pair補正(`corrections`、未登場は0)を合算し`[-MAX_TIE_CORRECTION, MAX_TIE_CORRECTION]`へclampする。
 * 自分自身は集約対象から除外する。`attractiveness()`の同clique bonus / outsider penaltyへ渡す
 * 加算値であり、正なら輪の魅力度を上げ、負なら下げる方向に一貫して効く。
 */
export function aggregateGroupTieCorrection(
  observerId: string,
  memberIds: string[],
  corrections: TieCorrectionState,
): number {
  let sum = 0;
  for (const memberId of memberIds) {
    if (memberId === observerId) continue;
    sum += corrections[tiePairKey(observerId, memberId)] ?? 0;
  }
  return clamp(sum, -MAX_TIE_CORRECTION, MAX_TIE_CORRECTION);
}

/**
 * `deriveSpeechInterpretations`(speechEffects.ts)の`relFactor`へ渡すtie補正解決関数を作る。
 * 受け手→話者pairの補正値(未登場は0)を返す。config OFF時はengine側でこのresolverを渡さないため、
 * `relFactor`は従来値のまま(補正0)になる。
 */
export function createTieCorrectionResolver(corrections: TieCorrectionState): SpeechTrustResolver {
  // SpeechTrustResolverと同じ (receiverId, speakerId, sameClique) => number シグネチャを流用する。
  // sameCliqueはtie補正では使わない(pair補正は履歴のみに依存する)。
  return (receiverId, speakerId) => corrections[tiePairKey(receiverId, speakerId)] ?? 0;
}

/**
 * 未観測の発言コミットメント(発言intentに対する話者のその後の行動をまだ観測していない発言)。
 * #116の`SpeechTrustCommitment`と役割は同じだが、`expiresAtTick`(発話+`TIE_OBSERVATION_WINDOW`)による
 * 時間窓を持つ点が異なる。`hearerIds`は発話時点で認知(heard: true)した受け手のスナップショット。
 */
export type TieObservationCommitment = {
  speechEventId: string;
  speechTick: number;
  speakerId: string;
  intent: SpeechIntent;
  hearerIds: string[];
  /** この時刻(このtickを含む)以降は観測せず失効させる(= speechTick + TIE_OBSERVATION_WINDOW) */
  expiresAtTick: number;
};

/**
 * tie補正が変化したことの構造化記録。「いつ(tick)・誰が誰の何の発言を観測し(observer/speaker/
 * speechEventId/intent)・どの状態遷移で一致/不一致と判定し・補正がどれだけ変化したか
 * (previousCorrection/newCorrection/delta)」を追跡できる。
 */
export type RelationshipTieUpdateEvent = {
  id: string;
  /** 観測(話者の行動)が発生したtick */
  tick: number;
  observerId: string;
  speakerId: string;
  speechEventId: string;
  intent: SpeechIntent;
  observedFromState: AgentState;
  observedToState: AgentState;
  observation: TieObservationResult;
  /** 観測時点の受け手→話者の距離(`TIE_OBSERVATION_RANGE`との比較に使った実測値) */
  distance: number;
  previousCorrection: number;
  newCorrection: number;
  /** newCorrection - previousCorrection */
  delta: number;
  /** この観測を追加した後の、当該pairの履歴保持件数 */
  historySize: number;
};

/** `deriveTieObservations`の戻り値。すべて新しいオブジェクト/配列(入力はmutationしない) */
export type RelationshipTieStepResult = {
  updates: RelationshipTieUpdateEvent[];
  /** 観測を反映した新しい整合性履歴 */
  history: RelationshipTieState;
  /** 解決済み(観測完了)・失効したものを取り除いた残りのコミットメント */
  commitments: TieObservationCommitment[];
};

/**
 * `TieObservationCommitment`を安定順序(speechTick -> speechEventId)へ並べるための比較関数
 * (Phase 3 #97の安定順序パターンを踏襲。同一tick内の観測処理順・履歴への追加順を入力配列順に
 * 依存させないことで、配列を反転しても結果が変わらないことを保証する)。
 */
function compareCommitmentOrder(a: TieObservationCommitment, b: TieObservationCommitment): number {
  if (a.speechTick !== b.speechTick) return a.speechTick - b.speechTick;
  return a.speechEventId < b.speechEventId ? -1 : a.speechEventId > b.speechEventId ? 1 : 0;
}

/**
 * 未観測コミットメントを、このtickの話者の状態遷移(`previousAgents`→`nextAgents`)と突き合わせ、
 * 整合性履歴を更新する純粋関数。rngを一切使わず、同一入力に対して常に同一の結果を返す。
 *
 * 処理規則(固定):
 * - コミットメントは`compareCommitmentOrder`(speechTick -> speechEventId)で安定順に処理する
 *   (配列順反転で結果が変わらない)。各コミットメント内では`hearerIds`をソートして処理する。
 * - 話者の状態が変わっていない、または`classifyTrustObservation`がundefinedを返す遷移では、
 *   `tick < expiresAtTick`の間コミットメントを保留のまま残す。`tick >= expiresAtTick`なら失効
 *   (観測されないまま除去。履歴には何も残さない)。
 * - 一致/不一致が確定した遷移では、`hearerIds`のうち観測条件を満たす受け手(現存し、"left"でなく、
 *   観測tickの話者位置から`TIE_OBSERVATION_RANGE`以内)全員の履歴へ観測を追加し(上限超過分は最古を破棄)、
 *   コミットメントを取り除く(1発言につき観測は1回限り)。
 * - 話者が`previousAgents`/`nextAgents`に見つからない場合(防御的)はコミットメントを取り除く。
 */
export function deriveTieObservations(
  commitments: TieObservationCommitment[],
  history: RelationshipTieState,
  previousAgents: Agent[],
  nextAgents: Agent[],
  tick: number,
  config: RelationshipTieConfig,
): RelationshipTieStepResult {
  if (!config.enabled) {
    const copied: RelationshipTieState = {};
    for (const [key, observations] of Object.entries(history)) copied[key] = [...observations];
    return { updates: [], history: copied, commitments: [...commitments] };
  }

  const previousById = new Map(previousAgents.map((agent) => [agent.id, agent]));
  const nextById = new Map(nextAgents.map((agent) => [agent.id, agent]));

  const nextHistory: RelationshipTieState = {};
  for (const [key, observations] of Object.entries(history)) nextHistory[key] = [...observations];

  const updates: RelationshipTieUpdateEvent[] = [];
  const remaining: TieObservationCommitment[] = [];
  const ordered = [...commitments].sort(compareCommitmentOrder);

  for (const commitment of ordered) {
    const speakerBefore = previousById.get(commitment.speakerId);
    const speakerAfter = nextById.get(commitment.speakerId);
    if (!speakerBefore || !speakerAfter) continue;

    const observation =
      speakerBefore.state === speakerAfter.state
        ? undefined
        : classifyTrustObservation(commitment.intent, speakerAfter.state);
    if (!observation) {
      // 決定的な遷移がまだ起きていない。時間窓内なら保留、窓を過ぎたら失効(除去)。
      if (tick < commitment.expiresAtTick) remaining.push(commitment);
      continue;
    }

    const weight = observation === "consistent" ? TIE_CONSISTENT_WEIGHT : TIE_INCONSISTENT_WEIGHT;
    for (const hearerId of [...commitment.hearerIds].sort()) {
      const observer = nextById.get(hearerId);
      if (!observer || observer.state === "left" || observer.id === commitment.speakerId) continue;
      const dist = Math.hypot(observer.x - speakerAfter.x, observer.y - speakerAfter.y);
      if (dist > TIE_OBSERVATION_RANGE) continue;

      const key = tiePairKey(observer.id, commitment.speakerId);
      const before = nextHistory[key] ?? [];
      const previousCorrection = correctionFromHistory(before);
      const entry: TieConsistencyObservation = {
        speechEventId: commitment.speechEventId,
        speechTick: commitment.speechTick,
        observedTick: tick,
        intent: commitment.intent,
        observation,
        observedFromState: speakerBefore.state,
        observedToState: speakerAfter.state,
        weight,
      };
      // 上限超過分は最古(先頭)から破棄する。件数上限が忘却を担う(時間減衰は導入しない)。
      const updated = [...before, entry].slice(-TIE_HISTORY_LIMIT);
      nextHistory[key] = updated;
      const newCorrection = correctionFromHistory(updated);

      updates.push({
        id: `tie-${tick}-${observer.id}-${commitment.speechEventId}`,
        tick,
        observerId: observer.id,
        speakerId: commitment.speakerId,
        speechEventId: commitment.speechEventId,
        intent: commitment.intent,
        observedFromState: speakerBefore.state,
        observedToState: speakerAfter.state,
        observation,
        distance: dist,
        previousCorrection,
        newCorrection,
        delta: newCorrection - previousCorrection,
        historySize: updated.length,
      });
    }
  }

  return { updates, history: nextHistory, commitments: remaining };
}

/**
 * このtickの発言(乖離調整後)と認知結果から、新しいコミットメントを既存の残りへ追記する純粋関数。
 * 発話時点で認知した受け手(`heard: true`)が1人もいない発言はコミットメントを作らない
 * (観測者が存在しえないため)。登録はそのtickの`deriveTieObservations`の後に行うこと
 * (発言とその発言自体を生んだ状態遷移が同一tickで自己解決しないよう、engine.tsで順序を固定)。
 */
export function registerTieCommitments(
  commitments: TieObservationCommitment[],
  speechEvents: SpeechEvent[],
  receptions: SpeechReceptionEvent[],
  config: RelationshipTieConfig,
): TieObservationCommitment[] {
  if (!config.enabled) return [...commitments];

  const next = [...commitments];
  for (const speech of speechEvents) {
    const hearerIds = receptions
      .filter((reception) => reception.speechEventId === speech.id && reception.heard)
      .map((reception) => reception.receiverId);
    if (hearerIds.length === 0) continue;
    next.push({
      speechEventId: speech.id,
      speechTick: speech.tick,
      speakerId: speech.speakerId,
      intent: speech.intent,
      hearerIds,
      expiresAtTick: speech.tick + TIE_OBSERVATION_WINDOW,
    });
  }
  return next;
}
