import type { InterventionRuntimeOptions, InterventionScenarioId } from "./interventions";
import type { FormationScenarioId } from "./formationPolicy";
import type { SpeechEvent } from "./speech";
import type {
  AggregatedActiveEffect,
  SpeechActiveEffect,
  SpeechEffectDimension,
  SpeechEffectEvent,
  SpeechEffectsConfig,
  SpeechInterpretationEvent,
  SpeechReceptionEvent,
} from "./speechEffects";
import type {
  SpeechTrustCommitment,
  SpeechTrustState,
  SpeechTrustUpdateEvent,
  SpeechTruthfulnessRecord,
} from "./speechTrust";
import type {
  RelationshipTieState,
  RelationshipTieUpdateEvent,
  TieConsistencyObservation,
  TieObservationCommitment,
} from "./relationshipTie";
import type { ExpressedStance, PublicExpressionDivergence } from "./socialExpression";

/**
 * エージェントの行動状態。Phase 4の三層モデル(`socialExpression.ts`)では、この状態遷移・移動
 * そのものが「行動(actualAction)」層にあたる(本心=`PrivateEvaluation`、対外表現=`PublicExpression`
 * と対比される第三の層。actualActionを表す新しい型は導入せず、常にこの既存状態を指す)。
 */
export type AgentState =
  | "undecided"
  | "forming"
  | "approaching"
  /**
   * 輪(GroupCandidate)に合流済み。未確定の「形成中の輪」への合流と、
   * 成立済み二次会グループへの参加の両方を指す。
   * どちらかは joinedGroupId が指す GroupCandidate.status を見て判別する
   * (ログ文言はこの区別に基づいて分けている。engine.ts参照)。
   */
  | "joined"
  | "leaving"
  | "left";

export type Agent = {
  id: string;
  label: string;
  x: number;
  y: number;
  vx: number;
  vy: number;

  /** 二次会に行きたい気持ち */
  willingness: number;
  /** 自分から場を作る力 */
  initiative: number;
  /** 曖昧な時間への耐性 */
  ambiguityTolerance: number;
  /** 自分の意思で場を動かしたくない度合い */
  influenceAvoidance: number;
  /** 周囲の動きに乗る傾向 */
  conformity: number;
  /** 帰宅判断の早さ(しきい値) */
  leaveThreshold: number;

  isObserverJoiner: boolean;
  state: AgentState;
  stress: number;
  joinedGroupId?: string;
  /** 既存の仲良しグループID (既存関係性の強さパラメータに応じて割り当てられる) */
  cliqueId?: number;
  /**
   * `light-observer-invitation`介入で、他のエージェントから軽く声をかけられたtick。
   * observerJoinerが`undecided`のうちに一度だけ設定され(以後は再度声をかけられない)、
   * このtickから一定期間だけ接近確率の上昇・追加ストレスの軽減という一時的な後押しが働く
   * (engine.ts参照)。observerJoiner以外には設定されない。
   */
  invitedAtTick?: number;
};

/**
 * GroupCandidateのライフサイクル状態。
 * forming: 未確定の輪として形成中。
 * confirmed: 成立済み二次会グループ(終端状態)。
 * dissolving: 反応が薄い/時間切れ等の理由で解散が決まり、視覚的にフェードアウトしている途中(終端手前)。
 * dissolved: 反応が薄いまま消えた(終端状態)。
 * expired: 成立に至らないまま期限切れになった(終端状態)。
 */
export type GroupCandidateStatus = "forming" | "confirmed" | "dissolving" | "dissolved" | "expired";

export type GroupCandidate = {
  id: string;
  x: number;
  y: number;
  memberIds: string[];
  status: GroupCandidateStatus;
  /**
   * 何tick存在しているか(演出・ログ用)。
   * dissolving/dissolved/expiredに遷移した時点でリセットされ、
   * そこからは終端状態での経過tick(掃除タイミング制御用)として使う。
   */
  age: number;
  /**
   * `explicit-meeting-point`介入により、初期状態から用意された公開の集合場所であることを示す。
   * 通常のforming候補と同じライフサイクルを辿るが、founder不在のため反応の薄さによる早期解散
   * (弱反応解散)の対象からは除外され、attractivenessでも影響回避の壁を下げて評価される
   * (engine.ts参照)。
   */
  isPublicMeetingPoint?: boolean;
  /**
   * Issue #131: この候補固有の成立最小人数/収容最大人数のオーバーライド。未指定の場合は
   * `FormationPolicy.resolveGroupCapacity`が返すポリシー既定値が使われる(`afterPartyPolicy`では
   * `minGroupSize = params.groupConfirmSize`, `maxGroupSize = Number.POSITIVE_INFINITY` = 実質無制限)。
   * 「満員」はここから`isCandidateFull`/`isJoinable`が都度導出する派生判定であり、status等へ
   * 独立したフラグとしては保持しない(二重管理による不整合を避けるため)。
   */
  minGroupSize?: number;
  maxGroupSize?: number;
};

/**
 * ログの分類タグ。1エントリに複数付与できる(単一カテゴリではなくタグ方式)。
 * observerJoinerの離脱は observerJoiner と leave の両方を持つ、といった重複を許容する。
 */
export type LogTag =
  | "observerJoiner"
  | "nucleus"
  | "groupConfirmed"
  | "leave"
  | "groupLifecycle"
  | "simulation"
  | "intervention";

/**
 * 集計(終了サマリー/Monte Carlo)向けのイベント種別。
 * 表示用の`message`文言を文字列解析せずに、主要イベントの発生をtickとひも付けて判定できるようにする。
 */
export type SimulationEventType =
  | "simulationStarted"
  | "interventionApplied"
  | "publicMeetingPointEstablished"
  | "lateJoinPermissionAnnounced"
  | "anonymousIntentSignalAnnounced"
  | "observerInvited"
  | "nucleusCreated"
  | "observerApproached"
  | "observerJoinedForming"
  | "observerJoinedConfirmed"
  | "observerLeaveStarted"
  | "observerLeft"
  | "groupConfirmed"
  | "groupDissolved"
  | "groupExpired"
  | "simulationFinished";

/** `eventType`ごとに必要な範囲で付与される集計用の補助情報。全フィールド任意 */
export type SimulationEventMetadata = {
  agentId?: string;
  agentLabel?: string;
  groupId?: string;
  groupStatus?: GroupCandidateStatus;
  memberCount?: number;
  /** 合流/参加時点でのGroupCandidateStatus (forming = 未確定の輪への合流, confirmed = 成立済みグループへの参加) */
  joinedGroupStatus?: GroupCandidateStatus;
  /** eventType: "interventionApplied" 用。適用された介入シナリオのID */
  interventionId?: InterventionScenarioId;
  /** eventType: "observerInvited" 用。声をかけた側のエージェントID/表示名 */
  inviterAgentId?: string;
  inviterAgentLabel?: string;
  /** Issue #131: 容量情報が関係するイベント(合流/成立)でのみ設定される、その候補の収容最大人数 */
  maxGroupSize?: number;
  /** Issue #131: 容量情報が関係するイベントでのみ設定される、そのイベント時点での残り空き人数(`maxGroupSize - memberIds.length`) */
  remainingCapacity?: number;
};

export type LogEntry = {
  tick: number;
  message: string;
  tags: LogTag[];
  /** 集計用の構造化イベント種別。既存の表示・フィルタリングには影響しない任意フィールド */
  eventType?: SimulationEventType;
  /** eventTypeに応じた集計用の補助情報。任意フィールド */
  metadata?: SimulationEventMetadata;
};

export type SimParams = {
  /** 人数 */
  populationSize: number;
  /** 二次会成立に必要な人数 */
  groupConfirmSize: number;
  /** 主導者の人数 */
  numLeaders: number;
  /** 全体の二次会意欲 (0-1, willingnessの平均に影響) */
  overallWillingness: number;
  /** 曖昧な時間の長さ (stressの蓄積速度の逆数的パラメータ) */
  ambiguityDuration: number;
  /** 後乗り参加のしやすさ (confirmed groupへの参加コスト低減) */
  lateJoinEase: number;
  /** 既存関係性の強さ (クラスタ同士がまとまりやすく、混ざりにくい) */
  existingTieStrength: number;
  /** observerJoinerの曖昧さ耐性 */
  observerAmbiguityTolerance: number;
  /** observerJoinerの影響回避度 */
  observerInfluenceAvoidance: number;
  /** observerJoinerの帰宅しやすさ (leaveThresholdの逆) */
  observerLeaveEase: number;
};

export type SimulationConfig = {
  seed: number;
  params: SimParams;
  presetId: string;
};

export type SimulationState = {
  tick: number;
  agents: Agent[];
  groupCandidates: GroupCandidate[];
  log: LogEntry[];
  width: number;
  height: number;
  finished: boolean;
  /**
   * このstateの生成(`createInitialState`)/更新(`stepSimulation`)に使われた介入シナリオID。
   * 介入なしの場合は"none"。UI表示・集計向けの最小限の保持であり、既存の状態遷移ロジックには影響しない。
   */
  interventionId?: InterventionScenarioId;
  /**
   * Issue #130 (Phase 1): このstateの生成(`createInitialState`)/更新(`stepSimulation`)に使われた
   * グループ形成ポリシー(`formationPolicy.ts`の`FormationPolicy`)のID。`interventionId`と同じfall back
   * 規則(呼び出し側が引き継ぎ忘れても直前の設定を維持する)で扱う。未指定(既存stateの読み込み等)は
   * 後方互換として`"afterParty"`が選択される。
   */
  formationScenarioId?: FormationScenarioId;
  /**
   * Issue #132 (Phase 2): `formationScenarioId`が`classroomPair`の場合に使われる、全員割当に至らなくても
   * 強制終了するtick数。`formationScenarioId`と同じfall backパターン(呼び出し側が引き継ぎ忘れても
   * 直前の設定を維持する)で扱う。`classroomPair`以外では無視され、未指定時は
   * `DEFAULT_CLASSROOM_PAIR_DEADLINE_TICK`(`formationPolicy.ts`)が使われる。
   */
  formationDeadlineTick?: number;
  /**
   * エージェントが実際に行った発言(`SpeechEvent`、`speech.ts`参照)の時系列記録。Phase 2で追加。
   * `log`(検証可能な出来事の記録)とは別軸で、「誰が何を発言したか」だけを構造化して保持する。
   * 生成・記録・表示の基盤に留まり、この記録を他エージェントの判断が参照することはない
   * (発言の認知・介入効果はPhase 3で扱う)。既存stateとの後方互換のため任意フィールド。
   */
  speechLog?: SpeechEvent[];
  /**
   * Phase 3(`speechEffects.ts`)の認知・解釈・効果の因果イベントログ。`speechEffectsEnabled`が
   * false(デフォルト)の間は常に空配列であり、既存のagents/rng/最終結果には一切影響しない。
   * 3つとも`speechLog`と同様に時系列蓄積のみを行う記録であり、意思決定の入力には使われない。
   */
  speechReceptionLog?: SpeechReceptionEvent[];
  speechInterpretationLog?: SpeechInterpretationEvent[];
  speechEffectLog?: SpeechEffectEvent[];
  /**
   * このstateの生成/更新時点でPhase 3効果(`speechEffects.ts`)が有効だったかどうか。
   * `interventionId`と同様、呼び出し側が引き継ぎ忘れても直前の設定を維持するためのfall back用。
   * 未指定(既存stateの読み込み等)は無効相当として扱う。
   */
  speechEffectsEnabled?: boolean;
  /**
   * Issue #115: このstateの生成/更新時点でPhase 4三層モデル(`socialExpression.ts`)の乖離判定と
   * 発言生成への統合が有効だったかどうか。`speechEffectsEnabled`と同様、呼び出し側が引き継ぎ忘れても
   * 直前の設定を維持するためのfall back用。未指定(既存stateの読み込み等)は無効相当として扱う。
   */
  socialExpressionEnabled?: boolean;
  /**
   * Issue #96: 現在有効な`SpeechActiveEffect`(発言由来の一時的な補正)の一覧。`speechEffectLog`と
   * 異なり、これは時系列の蓄積ログではなく「今このtickで作用している効果」のスナップショットで、
   * `engine.ts`が毎tick、期限切れのものを取り除き・強度を減衰させ・新規登録分を加えた配列で置き換える
   * (`speechEffectsEnabled`がfalseの間は常に空配列)。
   */
  activeSpeechEffects?: SpeechActiveEffect[];
  /**
   * Issue #116: このstateの生成/更新時点でPhase 4 trust更新(`speechTrust.ts`)が有効だったかどうか。
   * `speechEffectsEnabled`/`socialExpressionEnabled`と同じfall back規則。
   */
  speechTrustEnabled?: boolean;
  /**
   * Issue #116: pair単位(受け手→話者の方向つき)の動的trust。キーは`speechTrustPairKey`。
   * 更新が一度でも発生したpairのみ保持され、未登場のpairは静的`relationshipTrust`が初期値として
   * 解決される。`speechTrustEnabled`がfalseの間は常に空(既存挙動に一切影響しない)。
   */
  speechTrust?: SpeechTrustState;
  /**
   * Issue #116: trust更新の構造化記録(いつ・何を観測して・どれだけ変化したか)の時系列蓄積ログ。
   * 意思決定の入力には使われない(判断への反映は`speechTrust`経由の解釈trust係数のみ)。
   */
  speechTrustUpdateLog?: SpeechTrustUpdateEvent[];
  /**
   * Issue #116: 発言の真実性(発話時点の本心と対外表現の一致度)の時系列蓄積ログ。
   * 話者側の純粋な記録であり、trust更新・他エージェントの判断の入力には使われない。
   */
  speechTruthfulnessLog?: SpeechTruthfulnessRecord[];
  /**
   * Issue #116: 未観測の発言コミットメント(発言intentに対する話者のその後の行動をまだ観測して
   * いない発言)の進行状態。ログではなく`activeSpeechEffects`と同種の「現在のスナップショット」で、
   * `engine.ts`が毎tick、観測が完了したものを取り除き・このtickの発言分を追記した配列で置き換える。
   */
  speechTrustCommitments?: SpeechTrustCommitment[];
  /**
   * Issue #117: このstateの生成/更新時点でPhase 4の整合性履歴に基づく関係性補正(`relationshipTie.ts`)が
   * 有効だったかどうか。他のPhase 3/4フラグと同じfall back規則。
   */
  relationshipTieEnabled?: boolean;
  /**
   * Issue #117: pair単位(受け手→話者の方向つき)の整合性履歴。キーは`tiePairKey`。件数上限まで
   * 蓄積され、tie補正値はこの履歴から常に決定的に再導出される(補正値そのものはstateに保持しない)。
   * `relationshipTieEnabled`がfalseの間は常に空(既存挙動に一切影響しない)。
   */
  tieHistory?: RelationshipTieState;
  /**
   * Issue #117: tie補正が変化したことの構造化記録(いつ・誰の何の発言を観測し・どの遷移で
   * 一致/不一致と判定し・補正がどれだけ変化したか)の時系列蓄積ログ。意思決定の入力には使われない
   * (判断への反映は`tieHistory`由来の補正のみ)。
   */
  relationshipTieUpdateLog?: RelationshipTieUpdateEvent[];
  /**
   * Issue #117: 未観測の整合性コミットメント(発言intentに対する話者のその後Ntick以内の行動を
   * まだ観測していない発言)の進行状態。`speechTrustCommitments`と同種のスナップショットで、
   * `engine.ts`が毎tick、観測完了・時間窓失効したものを取り除き・このtickの発言分を追記して置き換える。
   */
  tieCommitments?: TieObservationCommitment[];
};

/**
 * observerJoinerと`SpeechEvent`との関わり方。1件のSpeechEventにつき最も強い関係を1つだけ持つ
 * (speaker > target > audienceの優先順で判定。話者と対象/audienceが同一tickで重なることはない)。
 * - "speaker": 自分がその発言の話者
 * - "target": 自分がその発言の明示的なtarget
 * - "audience": `audience === "nearby"`の発言。ここでは引き続き、observerJoinerを含む全エージェントを
 *   audience対象とみなす簡略化を採る(inspection.ts参照)。Issue #94により実座標近接判定に基づく
 *   `SpeechReceptionEvent`(`speechEffects.ts`、`SimulationState.speechReceptionLog`)は導入済みだが、
 *   Inspector表示をそちらに切り替える対応はこのissueのスコープ外(対応しない範囲: UI表示)のため、
 *   この簡略化は意図的に維持している。
 */
export type SpeechRelation = "speaker" | "target" | "audience";

/** observerJoiner Inspector向けに、関連する発言1件と、その関わり方をひも付けたもの */
export type ObserverSpeechHistoryEntry = {
  event: SpeechEvent;
  relation: SpeechRelation;
};

/**
 * `SpeechActiveEffect`のうち、現在も`SimulationState.activeSpeechEffects`に残っている分の
 * 状態(Issue #98)。効果は生成された(`SpeechEffectEvent`は存在する)が既に失効/再発言による
 * 置換(`registerActiveSpeechEffects`)で取り除かれている場合、この型は生成されず`undefined`になる。
 */
export type ObserverActiveEffectStatus = {
  initialStrength: number;
  currentStrength: number;
  startedAtTick: number;
  expiresAtTick: number;
  /** 現在tick時点での残りtick数(`expiresAtTick - tick`、0未満にはならない) */
  remainingTicks: number;
};

/**
 * observerJoinerに関わる発言1件(`ObserverSpeechHistoryEntry`と`speechEventId`で対応する)について、
 * 認知(`SpeechReceptionEvent`)→解釈(`SpeechInterpretationEvent`)→効果(`SpeechEffectEvent`)→
 * 現在の適用状況(`ObserverActiveEffectStatus`)の因果チェーンを1件ずつひも付けたもの(Issue #98)。
 * 各段は、Phase 3効果が無効(`speechEffectsEnabled: false`)、またはその段に到達しなかった場合
 * (圏外で認知されなかった/解釈がneutralで効果が生成されなかった/効果が既に失効・置換された)は
 * `undefined`になる。「非認知・効果なしの理由」は、後続の段がすべて`undefined`であることと
 * `reception.reason`/`interpretation.valence`から読み取れる。
 */
export type ObserverSpeechEffectDetail = {
  speechEventId: string;
  reception?: SpeechReceptionEvent;
  interpretation?: SpeechInterpretationEvent;
  effect?: SpeechEffectEvent;
  activeEffectStatus?: ObserverActiveEffectStatus;
};

/**
 * observerJoiner一人分の観察用データ。UI(inspector表示)から安全に参照できるよう、
 * engine.ts内部のロジック結果を読み取り専用の形にまとめたもの。
 * 最寄りの合流可能な輪(joinableなGroupCandidate)が存在しない場合、
 * nearestGroup*系とattractivenessScoreはundefinedになる。
 */
export type ObserverJoinerInspection = {
  agentId: string;
  label: string;
  state: AgentState;
  stress: number;
  willingness: number;
  ambiguityTolerance: number;
  influenceAvoidance: number;
  leaveThreshold: number;
  /** leaveThreshold - stress。0以下ならleaving判定まであとわずか(またはleaving済み) */
  leaveMargin: number;
  nearestGroupId?: string;
  nearestGroupStatus?: GroupCandidateStatus;
  nearestGroupMemberCount?: number;
  nearestGroupDistance?: number;
  attractivenessScore?: number;
  /**
   * `attractivenessScore`からPhase 3の発言効果(welcome由来のattractiveness補正)を除いた基準値
   * (Issue #98)。`nearestGroupId`が存在する場合のみ設定される。`attractivenessScore`との差が
   * 「発言効果によって最寄りの輪の魅力度がどれだけ補正されたか」を表す(適用前値/適用後値)。
   */
  attractivenessScoreBeforeEffects?: number;
  /** このobserverJoinerが話者/target/audienceのいずれかとして関わった発言の履歴。tick順 */
  speechHistory: ObserverSpeechHistoryEntry[];
  /**
   * `speechHistory`と同じ発言集合について、認知/解釈/効果の因果詳細を`speechEventId`でひも付けた
   * もの(`speechHistory`と同じ順序・同じ長さ、Issue #98)。
   */
  speechEffectDetails: ObserverSpeechEffectDetail[];
  /**
   * 現在このagentに作用しているPhase 3効果を、dimension(・attractivenessならtargetGroupId)ごとに
   * 集約したもの(Issue #97の`aggregateActiveEffects`をそのまま利用)。集約値だけでなく、
   * 寄与した各`speechEventId`ごとの個別寄与(正/負/重複)も保持する(Issue #98)。
   */
  activeEffectSummaries: AggregatedActiveEffect[];
  /**
   * Issue #119: 現在tickの本心(`PrivateEvaluation`)と対外表現(`PublicExpression`)、乖離の有無・
   * 要因内訳。Phase 4三層モデル(socialExpression)が有効な場合のみ設定される(無効/導出不能なら
   * undefined)。
   */
  socialExpression?: ObserverSocialExpressionSnapshot;
  /**
   * Issue #119: このobserverJoiner(受け手)から見た、話者ごとの動的trust現在値と更新履歴。
   * trustが一度でも更新された、または現在値が保持されている話者のみを含む(speakerId昇順)。
   */
  trustSummaries: ObserverTrustSummary[];
  /**
   * Issue #119: このobserverJoiner(受け手)から見た、話者ごとの関係性補正の現在値と、
   * 寄与した整合性観測(発言・行動の組)・更新履歴。整合性履歴を持つ話者のみを含む(speakerId昇順)。
   */
  tieSummaries: ObserverTieSummary[];
};

/**
 * Issue #119: observerJoiner一人分の、現在tickの本心/対外表現/乖離のスナップショット。
 * `derivePrivateEvaluations`/`derivePublicExpressions`(socialExpression.ts)の結果から組み立てる。
 */
export type ObserverSocialExpressionSnapshot = {
  /** 本心の参加意欲(`PrivateEvaluation.joinDesire`) */
  privateJoinDesire: number;
  /** 対外表現の参加意欲(`PublicExpression.expressedJoinDesire`、乖離適用後) */
  expressedJoinDesire: number;
  /** 本心側スタンス(positive/none/negative) */
  privateStance: ExpressedStance;
  /** 対外表現側スタンス */
  expressedStance: ExpressedStance;
  /** 本心の離脱傾向(`PrivateEvaluation.leaveInclination`) */
  privateLeaveInclination: number;
  /** 対外表現の離脱傾向(乖離適用後) */
  expressedLeaveInclination: number;
  /** いずれかの次元で乖離があるか */
  divergent: boolean;
  /** 次元ごとの乖離判定結果(要因内訳付き、固定順: joinDesire→leaveInclination) */
  divergences: PublicExpressionDivergence[];
};

/** Issue #119: 話者ごとの動的trust現在値と更新履歴(受け手→話者の方向つき) */
export type ObserverTrustSummary = {
  speakerId: string;
  /** 現在のtrust値([0,1])。動的更新済みならその値 */
  trust: number;
  /** 動的更新が発生済み(`state.speechTrust`にpairが登録済み)か */
  isDynamic: boolean;
  /** この受け手→話者のtrust更新履歴(tick昇順) */
  updates: SpeechTrustUpdateEvent[];
};

/** Issue #119: 話者ごとの関係性補正の現在値・寄与した整合性観測・更新履歴(受け手→話者の方向つき) */
export type ObserverTieSummary = {
  speakerId: string;
  /** 現在の関係性補正値(整合性履歴から導出、`[-MAX, MAX]`) */
  correction: number;
  /** 補正へ寄与した整合性観測(発言・行動の組。tick昇順) */
  observations: TieConsistencyObservation[];
  /** この受け手→話者のtie補正更新履歴(tick昇順) */
  updates: RelationshipTieUpdateEvent[];
};

/**
 * observerJoiner一人分の、シミュレーション終了(または途中経過)サマリー。
 * `state.log`の構造化イベント(`eventType`/`metadata`)から抽出した、tickに紐づく意思決定の推移。
 */
export type ObserverJoinerRunSummary = {
  agentId: string;
  label: string;
  /** サマリー導出時点でのstate.agentsの状態(finished: falseの場合は暫定値) */
  finalState: AgentState;
  joinedGroupId?: string;
  /** 輪/成立済みグループへの接近を開始したtick("observerApproached"、複数回接近し直した場合は直近のもの) */
  approachedTick?: number;
  /** 輪への合流、または成立済みグループへの参加が完了したtick */
  joinedTick?: number;
  /** 参加時点でのGroupCandidateStatus (forming = 未確定の輪への合流, confirmed = 成立済みグループへの参加) */
  joinedGroupStatus?: GroupCandidateStatus;
  leaveStartedTick?: number;
  leftTick?: number;
  /**
   * 後乗り参加が成立したとみなす条件(いずれかを満たせばtrue、finalStateが"joined"でなければ常にfalse):
   * (a) 参加した輪が参加時点で既に"confirmed"だった(joinedGroupStatus === "confirmed")、または
   * (b) シミュレーション全体で最初にグループが成立したtick(firstGroupConfirmedTick)より後に参加した
   *     (自分の輪が後から成立したケースも含め、既に何らかのグループが成立済みの状況下での参加は後乗りとみなす)
   */
  lateJoinSucceeded: boolean;
};

/**
 * シミュレーションの終了(または途中経過)サマリー。表示文言の文字列解析に依存せず、
 * `state.log`の構造化イベントと`state.agents`から導出する。`SimulationState`をmutationしない。
 * `finished: false`の状態でも呼び出し可能で、その時点までの暫定値を返す
 * (UI側で「終了前の暫定サマリー」として表示することを想定)。
 */
export type SimulationSummary = {
  finished: boolean;
  /** 終了tick。finished: falseの場合はundefined */
  finishedTick?: number;
  joinedCount: number;
  leftCount: number;
  stateCounts: Record<AgentState, number>;
  observerJoiners: ObserverJoinerRunSummary[];
  /** 最初に核(forming候補)が形成されたtick。一度も形成されていなければundefined */
  firstNucleusTick?: number;
  /** 最初にグループが成立したtick。一度も成立していなければundefined */
  firstGroupConfirmedTick?: number;
  /** 成立した(confirmedになった)グループの総数 */
  confirmedGroupCount: number;
  /** グループ成立イベントが一度もない場合にtrue */
  groupFailure: boolean;
};

/** `runSimulationToEnd`/`runMonteCarlo`の安全上限tick数などの実行オプション */
export type MonteCarloRunOptions = {
  /**
   * 1runあたりの最大tick数(無限ループ防止用の安全上限)。
   * engine.ts側の内部上限(tick >= 400)とは独立に、Monte Carlo層としても明示的に持つ。
   * 省略時は`DEFAULT_MAX_TICKS`(monteCarlo.ts参照)。
   */
  maxTicks?: number;
  /** 単発実行/Monte Carloの各runに適用する介入シナリオ。省略時は介入なし */
  intervention?: InterventionRuntimeOptions;
  /**
   * 単発実行/Monte Carloの各runに適用するPhase 3発言効果設定(Issue #99)。省略時は無効
   * (`resolveSpeechEffectsConfig`の既定値、既存呼び出し元との後方互換のため)。
   */
  speechEffects?: Partial<SpeechEffectsConfig>;
};

/** Monte Carlo実行全体の設定。`runs`回、`baseSeed + index`をseedとして実行する */
export type MonteCarloConfig = {
  baseSeed: number;
  runs: number;
  params: SimParams;
  maxTicks?: number;
  /** 全runに共通で適用する介入シナリオ。省略時は介入なし(単発実行と同じ介入設定を使うことを想定) */
  intervention?: InterventionRuntimeOptions;
  /**
   * 全runに共通で適用するPhase 3発言効果設定(Issue #99)。省略時は無効。
   * `compareSpeechEffects`(`speechEffectsMonteCarlo.ts`)はこの値を無視し、常にoff/on両方を実行する
   * (`compareMonteCarloIntervention`がbaseline側で`config.intervention`を無視するのと同じ設計)。
   */
  speechEffects?: Partial<SpeechEffectsConfig>;
};

/** 単一seed分のMonte Carlo実行結果 */
export type MonteCarloRunResult = {
  seed: number;
  summary: SimulationSummary;
  /** 実行が終了したtick(安全上限に達して打ち切られた場合はその上限tick) */
  finishedTick: number;
};

/** 複数run分の集計値 */
export type MonteCarloSummary = {
  runs: number;
  /** observerJoinerが最終的に"joined"になったrunの割合(0〜1)。複数observerJoinerがいるrunは、いずれか1人でも該当すれば成功とみなす */
  observerJoinerJoinRate: number;
  /** observerJoinerがleaveStartedTickまたはleftTickを持つrunの割合(0〜1)。複数observerJoinerがいるrunは、いずれか1人でも該当すれば該当とみなす */
  observerJoinerLeaveRate: number;
  /** confirmedGroupCount === 0 のrunの割合(0〜1) */
  groupFailureRate: number;
  /** グループ成立が発生したrunのみを母数にした平均firstGroupConfirmedTick。全runで未成立ならundefined */
  averageFirstGroupConfirmedTick?: number;
  /** observerJoinerのlateJoinSucceeded === trueであるrunの割合(0〜1)。複数observerJoinerがいるrunは、いずれか1人でも該当すれば成功とみなす */
  lateJoinSuccessRate: number;
  averageJoinedCount: number;
  averageLeftCount: number;
};

/** `runMonteCarlo`の戻り値。個別run結果と集計値の両方を保持する */
export type MonteCarloResult = {
  config: MonteCarloConfig;
  runs: MonteCarloRunResult[];
  summary: MonteCarloSummary;
};

/**
 * baseline(介入なし)とintervention(選択中の介入)の間での、単一指標の比較値。
 * `delta`は`intervention - baseline`(比率は0-1のまま、tickはtick差、人数は人数差)。
 * `averageFirstGroupConfirmedTick`のように片方または両方が未成立(undefined)になり得る指標では
 * `T`を`number | undefined`にして使う。
 */
export type MonteCarloMetricDelta<T = number> = {
  baseline: T;
  intervention: T;
  delta: T;
};

/**
 * `compareMonteCarloIntervention`の戻り値。同一`presetId`/`params`/`baseSeed`/`runs`/`maxTicks`で
 * baseline(interventionId: "none")とintervention(選択中の介入)を実行した結果一式。
 * `baseline`/`intervention`はそれぞれの`runMonteCarlo`の完全な結果(個別run一覧を含む)を保持し、
 * `metrics`は`MonteCarloSummary`の主要指標をbaseline/intervention/deltaの形にまとめたもの。
 */
export type MonteCarloComparisonResult = {
  baseline: MonteCarloResult;
  intervention: MonteCarloResult;
  metrics: {
    observerJoinerJoinRate: MonteCarloMetricDelta;
    observerJoinerLeaveRate: MonteCarloMetricDelta;
    groupFailureRate: MonteCarloMetricDelta;
    averageFirstGroupConfirmedTick: MonteCarloMetricDelta<number | undefined>;
    lateJoinSuccessRate: MonteCarloMetricDelta;
    averageJoinedCount: MonteCarloMetricDelta;
    averageLeftCount: MonteCarloMetricDelta;
  };
};

/**
 * Issue #99: 単一run分の、Phase 3(発言効果)固有の観察指標。`buildSpeechEffectsRunSummary`
 * (`summary.ts`)が`SimulationState`(`speechReceptionLog`/`speechInterpretationLog`/
 * `speechEffectLog`/`log`/`agents`)から導出する。既存の`SimulationSummary`とは独立した集計軸であり、
 * どちらか一方の型を拡張せず並立させることで、「介入あり/なし比較」と「発言効果ON/OFF比較」を
 * 型レベルで混同しないようにする(受入条件)。
 */
export type SpeechEffectsRunSummary = {
  /** このrunでobserverJoinerが1件以上の発言を認知(`SpeechReceptionEvent.heard === true`)したか */
  observerJoinerHeardSpeech: boolean;
  /**
   * このrunで、中立でない解釈(`SpeechInterpretationEvent.valence !== "neutral"`)、または
   * `SpeechEffectEvent`が1件以上発生したか
   */
  hadInterpretationOrEffect: boolean;
  /**
   * dimension別の累積補正(このrunで発生した`SpeechEffectEvent.outputValue`の絶対値の合計)。
   * 発言効果が一度も発生しなければ全dimension 0。
   */
  dimensionTotals: Record<SpeechEffectDimension, number>;
  /**
   * 発言効果が何らかの状態遷移に寄与したとみなせるrunか。`approachProbability`→`observerApproached`、
   * `attractiveness`→`observerJoinedForming`/`observerJoinedConfirmed`、`leaveThreshold`→
   * `observerLeaveStarted`の対応で、同一`receiverId`(=`LogEntry.metadata.agentId`)について
   * `SpeechEffectEvent`の有効期間(`appliedTick`〜`appliedTick + durationTicks`)内に該当する
   * 構造化ログイベントが存在するかで判定するヒューリスティックであり、厳密な反実仮想検証ではない
   * (`stress`は蓄積率の緩和が「離脱しなかった」という非イベントにしか現れず対応する離散イベントを
   * 持たないため、この判定の対象外。詳細は`docs/speech-effects-paired-monte-carlo.md`参照)。
   */
  transitionInfluenced: boolean;
};

/** 複数run分のPhase 3固有指標の集計値 */
export type SpeechEffectsMonteCarloSummary = {
  runs: number;
  observerJoinerHeardSpeechRate: number;
  interpretationOrEffectRate: number;
  averageDimensionTotals: Record<SpeechEffectDimension, number>;
  transitionInfluencedRate: number;
};

/**
 * Issue #99: 発言効果ON/OFF paired比較の実行設定。既存の`MonteCarloConfig`(介入あり/なし比較用)とは
 * 独立した型であり、意図せず混同されないようにする。`compareSpeechEffects`は、この設定のまま
 * `speechEffects.enabled`だけをfalse/trueに切り替えてoff/on両方を実行する
 * (preset由来`params`・`intervention`・`baseSeed`・`runs`・`maxTicks`は固定)。
 */
export type SpeechEffectsMonteCarloConfig = {
  baseSeed: number;
  runs: number;
  params: SimParams;
  maxTicks?: number;
  intervention?: InterventionRuntimeOptions;
};

/** `compareSpeechEffects`が内部でoff/onそれぞれについて実行する単一条件分の結果一式 */
export type SpeechEffectsMonteCarloResult = {
  config: SpeechEffectsMonteCarloConfig;
  runs: MonteCarloRunResult[];
  summary: MonteCarloSummary;
  /** `runs`と同じ順序・同じ長さ(seedで1:1対応)のPhase 3固有run結果 */
  speechEffectsRuns: SpeechEffectsRunSummary[];
  speechEffectsSummary: SpeechEffectsMonteCarloSummary;
};

/**
 * `compareSpeechEffects`の戻り値。既存の`MonteCarloComparisonResult`(`baseline`/`intervention`)とは
 * フィールド名も型も分離し、「発言効果OFF」「発言効果ON」であることを`off`/`on`という名前で明示する
 * (受入条件: 既存介入比較と名称・型を混同しない)。
 */
export type SpeechEffectsComparisonResult = {
  off: SpeechEffectsMonteCarloResult;
  on: SpeechEffectsMonteCarloResult;
  /** off/on共通のseed列(`baseSeed`〜`baseSeed + runs - 1`)。run iがseedで対応することの明示 */
  pairedSeeds: number[];
  metrics: {
    observerJoinerJoinRate: MonteCarloMetricDelta;
    observerJoinerLeaveRate: MonteCarloMetricDelta;
    groupFailureRate: MonteCarloMetricDelta;
    averageFirstGroupConfirmedTick: MonteCarloMetricDelta<number | undefined>;
    lateJoinSuccessRate: MonteCarloMetricDelta;
    averageJoinedCount: MonteCarloMetricDelta;
    averageLeftCount: MonteCarloMetricDelta;
  };
  /** Phase 3固有指標のoff/on/delta。`metrics`とは別に保持し、既存指標との混同を避ける */
  phase3Metrics: {
    observerJoinerHeardSpeechRate: MonteCarloMetricDelta;
    interpretationOrEffectRate: MonteCarloMetricDelta;
    transitionInfluencedRate: MonteCarloMetricDelta;
    dimensionTotals: Record<SpeechEffectDimension, MonteCarloMetricDelta>;
  };
};

/**
 * Issue #120: Phase 4(本心/建前の乖離・#114、trust更新・#116、関係性補正・#117)固有の、
 * 単一run分の観察指標。`buildPhase4RunSummary`(`summary.ts`)が、いずれも時系列蓄積ログである
 * `speechLog`(`SpeechEvent.expression`)・`speechTrustUpdateLog`・`relationshipTieUpdateLog`からのみ
 * 導出する(意思決定には使われない記録の集計であり、追加の状態導出は行わない)。
 * Phase 3固有指標(`SpeechEffectsRunSummary`)とは独立した集計軸として並立させる。
 */
export type Phase4RunSummary = {
  /** `SpeechEvent.expression.divergent === true`だった発言の件数(乖離発生数) */
  divergenceCount: number;
  /** `expression`スナップショットを持つ発言の件数(socialExpression有効時のみ非0) */
  expressedSpeechCount: number;
  /** `speechTrustUpdateLog`の`|delta|`合計(受け手→話者pairのtrust変化量の総和) */
  trustChangeAmount: number;
  /** `relationshipTieUpdateLog`の`|delta|`合計(pairの関係性補正の変化量の総和) */
  tieChangeAmount: number;
};

/** 複数run分のPhase 4固有指標の集計値 */
export type Phase4MonteCarloSummary = {
  runs: number;
  averageDivergenceCount: number;
  averageExpressedSpeechCount: number;
  averageTrustChangeAmount: number;
  averageTieChangeAmount: number;
};

/**
 * Issue #120: Phase 4モデル(socialExpression・speechTrust・relationshipTieをまとめて切り替える)の
 * ON/OFF paired比較の実行設定。`SpeechEffectsMonteCarloConfig`と同じ設計(既存の`MonteCarloConfig`とは
 * 独立した型)。`comparePhase4Model`は、この設定のまま3設定の`enabled`だけをまとめてfalse/trueに
 * 切り替えてoff/on両方を実行する(preset由来`params`・`intervention`・`baseSeed`・`runs`・`maxTicks`は固定)。
 * speechEffects(Phase 3)は両条件とも有効固定(Phase 4の観測がPhase 3の認知記録を前提とするため)。
 */
export type Phase4MonteCarloConfig = {
  baseSeed: number;
  runs: number;
  params: SimParams;
  maxTicks?: number;
  intervention?: InterventionRuntimeOptions;
};

/** `comparePhase4Model`が内部でoff/onそれぞれについて実行する単一条件分の結果一式 */
export type Phase4MonteCarloResult = {
  config: Phase4MonteCarloConfig;
  runs: MonteCarloRunResult[];
  summary: MonteCarloSummary;
  /** `runs`と同じ順序・同じ長さ(seedで1:1対応)のPhase 4固有run結果 */
  phase4Runs: Phase4RunSummary[];
  phase4Summary: Phase4MonteCarloSummary;
};

/**
 * `comparePhase4Model`の戻り値。`SpeechEffectsComparisonResult`と同様、既存の`MonteCarloComparisonResult`
 * ともPhase 3の`SpeechEffectsComparisonResult`とも型・フィールド名を分離する。
 */
export type Phase4ComparisonResult = {
  off: Phase4MonteCarloResult;
  on: Phase4MonteCarloResult;
  /** off/on共通のseed列(`baseSeed`〜`baseSeed + runs - 1`)。run iがseedで対応することの明示 */
  pairedSeeds: number[];
  metrics: {
    observerJoinerJoinRate: MonteCarloMetricDelta;
    observerJoinerLeaveRate: MonteCarloMetricDelta;
    groupFailureRate: MonteCarloMetricDelta;
    averageFirstGroupConfirmedTick: MonteCarloMetricDelta<number | undefined>;
    lateJoinSuccessRate: MonteCarloMetricDelta;
    averageJoinedCount: MonteCarloMetricDelta;
    averageLeftCount: MonteCarloMetricDelta;
  };
  /** Phase 4固有指標のoff/on/delta。`metrics`とは別に保持し、既存指標との混同を避ける */
  phase4Metrics: {
    divergenceCount: MonteCarloMetricDelta;
    expressedSpeechCount: MonteCarloMetricDelta;
    trustChangeAmount: MonteCarloMetricDelta;
    tieChangeAmount: MonteCarloMetricDelta;
  };
};
