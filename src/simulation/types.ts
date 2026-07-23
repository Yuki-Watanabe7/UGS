import type { InterventionAudience, InterventionRuntimeOptions, InterventionScenarioId } from "./interventions";
import type { FormationRuntimeOptions, FormationScenarioId, GroupSizeRule } from "./formationPolicy";
import type { InterventionEffect, InterventionRuntimeState } from "./schoolInterventionRuntime";
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
  | "left"
  /** 学校シナリオの締切時点で、ペアへ割り当てられなかった終端状態 */
  | "unassigned";

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
  /**
   * Issue #133: 直近で参加に失敗した(満員・消滅等で接近を中断した)候補のID。
   * 再探索時にこの候補への即時再接近を避けるクールダウン判定に使う(`lastFailedCandidateAtTick`からの
   * 経過tickで判定し、engine.ts側の`nearestCandidate`呼び出しで一時的に除外する)。
   */
  lastFailedCandidateId?: string;
  /** Issue #133: `lastFailedCandidateId`が記録されたtick(クールダウン判定の起点) */
  lastFailedCandidateAtTick?: number;
  /** Issue #133: `approaching`から参加失敗により`undecided`へ戻り、再探索した回数の累計 */
  searchRestartCount?: number;
  /** Issue #133: そのうち、満員(容量起因)が理由だった回数の累計 */
  capacityFailureCount?: number;
  /**
   * Issue #136: このrunを通じて`stress`が到達した最大値。Phase 3の"greet"由来効果はstressを
   * 一時的に引き下げ得る(engine.tsのstress蓄積式参照)ため、最終的な`stress`だけでは
   * 「一番つらかった瞬間」の負荷を観察できない。`stress`が変化する箇所(通常のstress蓄積、
   * および参加失敗による追加stress)で都度`Math.max`で更新するのみで、それ自体は
   * 意思決定(attractiveness/approachProbability/leave判定)には一切使われない観察専用の値。
   */
  maxStress?: number;
};

/**
 * Issue #133: 接近中(`approaching`)の候補が無効化された/参加に失敗した理由。
 * - "capacityFull": 満員(容量超過)。接近中の再検証、または到着時の同一tick競合のいずれか
 * - "groupDissolved": 候補が解散(dissolving/dissolved)した
 * - "groupExpired": 候補が期限切れ(expired)になった
 * - "groupMissing": 候補自体が見当たらなくなった(通常は上記いずれかより先に検知されるため稀)
 */
export type ApproachFailureReason = "capacityFull" | "groupDissolved" | "groupExpired" | "groupMissing";

/** `simulationFinished`イベントに保持する、シナリオ全体の終了理由 */
export type SimulationFinishReason =
  | "allAssigned"
  | "deadlineReached"
  | "allSettled"
  | "maxTicksReached";

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
  | "intervention"
  /** Issue #134: 学校シナリオの締切で未割当が確定したイベント */
  | "unassigned"
  /** Issue #133: 接近先の無効化・参加失敗・再探索に関するイベント */
  | "joinFailure";

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
  /** Issue #134: deadline到達時、ペア未成立のagentを未割当として確定した */
  | "agentUnassigned"
  | "simulationFinished"
  /** Issue #133: 接近中の候補が満員/消滅/期限切れ等で無効化され、接近を中断した */
  | "approachTargetInvalidated"
  /** Issue #133: 到着時点で満員が判明し参加できなかった(同一tickでの容量競合を含む) */
  | "joinFailedCapacity"
  /** Issue #133: 参加失敗によりundecidedへ戻り、再探索を始めた */
  | "searchRestarted"
  /**
   * Issue #136: undecidedなagentが候補への接近("approaching")を開始した。observerJoinerは
   * 従来どおり`observerApproached`も別途記録される(後方互換のため`observerApproached`はそのまま維持)。
   * 全agent共通で発生するため、agent別の接近回数はこのeventTypeで集計する
   * (`observerApproached`はobserverJoiner限定で、非observerJoinerには発生しない)。
   */
  | "agentApproached"
  /**
   * Issue #156: 学校向け介入(教師介入)が発火した/効果を適用した/対象を割り当てた等の共通イベント。
   * 個別介入(推薦・強制割当等)の具体ロジックはこのIssueの対象外だが、後続Issueが実装する介入は
   * 全てこのeventTypeと`SimulationEventMetadata`の共通フィールドを使って構造化ログを残す想定
   * (受入条件: 表示用messageの解析に依存せず後続の集計がmetadataから算出できる)。
   */
  | "schoolInterventionTriggered"
  /**
   * Issue #158: `anonymous-help-signal`。長時間未決定の生徒本人が、公開の場で名指しされずに
   * 教師へ支援を要請したことを認知した(通知そのものはagentを移動・所属させない)。
   */
  | "anonymousHelpRequested"
  /** Issue #158: `teacher-recommendation`。教師が対象agentへ候補(班または未決定者peer)を推薦した */
  | "teacherRecommendationIssued"
  /** Issue #158: `teacher-recommendation`。推薦を対象agentが受け入れた(直接所属はさせない) */
  | "teacherRecommendationAccepted"
  /** Issue #158: `teacher-recommendation`。推薦を対象agentが断った */
  | "teacherRecommendationDeclined"
  /** Issue #158: `teacher-recommendation`。推薦可能な候補(空きのある班/未決定peer)が存在しなかった */
  | "teacherRecommendationUnavailable"
  /**
   * Issue #158: `teacher-recommendation`。受諾済みの推薦先が、その後(満員化/消滅/期限切れ等で)
   * 無効化された。無効化後の参加失敗・再探索は既存の`approachTargetInvalidated`/`searchRestarted`
   * 経路へそのまま接続する(このeventTypeは推薦固有の追跡目的のみ)。
   */
  | "teacherRecommendationTargetInvalidated"
  /** Issue #159: `teacher-deadline-assignment`。締切時の教師強制割当を開始した(run中に1回のみ) */
  | "teacherAssignmentStarted"
  /** Issue #159: `teacher-deadline-assignment`。1人のagentを既存班の空き/新規班/再編先へ強制割当した */
  | "teacherAssignedAgent"
  /** Issue #159: `teacher-deadline-assignment`。既存班のmemberIdsを再配分(誰かを移動)して構成を変更した */
  | "teacherRebalancedGroup"
  /** Issue #159: `teacher-deadline-assignment`。強制割当処理が完了した(全体の集計をmetadataへ持つ) */
  | "teacherAssignmentCompleted"
  /** Issue #159: `teacher-deadline-assignment`。容量制約上どうしても割当不可能だった(構造的余り) */
  | "teacherAssignmentUnable"
  /** Issue #159: `random-assignment-baseline`。seed付きランダム割当(自由形成を行わない比較基準)を開始した */
  | "randomAssignmentStarted"
  /** Issue #159: `random-assignment-baseline`。ランダム割当により1つの班(confirmed)を作成した */
  | "randomGroupCreated"
  /** Issue #159: `random-assignment-baseline`。ランダム割当処理が完了した(全体の集計をmetadataへ持つ) */
  | "randomAssignmentCompleted";

/**
 * Issue #156: `schoolInterventionTriggered`の`metadata.outcome`。表示文言の解析に依存しない結果分類。
 * Issue #158: `unavailable`(推薦可能な候補が存在しない/受諾済み推薦先が無効化された)を追加。
 */
export type SchoolInterventionOutcome =
  | "presented"
  | "accepted"
  | "declined"
  | "assigned"
  | "unassignable"
  | "unavailable";

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
  /** Issue #133: `approachTargetInvalidated`/`joinFailedCapacity`/`searchRestarted`用。無効化・失敗理由 */
  reason?: ApproachFailureReason;
  /** Issue #134: `simulationFinished`用。全体が終了した理由 */
  finishReason?: SimulationFinishReason;
  /** Issue #134: `simulationFinished`時点で割当済み(`joined`)の人数 */
  assignedCount?: number;
  /** Issue #134: `simulationFinished`時点で未割当(`unassigned`)の人数 */
  unassignedCount?: number;
  /** Issue #134: `agentUnassigned`で未割当確定直前にいた探索状態 */
  previousAgentState?: AgentState;
  /** Issue #134: `agentUnassigned`時点までに再探索した回数 */
  searchRestartCount?: number;
  /** Issue #134: `agentUnassigned`時点までに満員を理由として参加失敗した回数 */
  capacityFailureCount?: number;
  /** Issue #134: `agentUnassigned`時点で最後に参加失敗した候補ID */
  lastFailedCandidateId?: string;
  /** Issue #134: `agentUnassigned`時点のstressスナップショット */
  stress?: number;
  /** Issue #156: `schoolInterventionTriggered`用。適用された介入シナリオのID */
  schoolInterventionId?: InterventionScenarioId;
  /** Issue #156: `schoolInterventionTriggered`用。介入の対象者層(常に"school") */
  interventionCategory?: InterventionAudience;
  /** Issue #156: `schoolInterventionTriggered`用。声かけ/推薦等の発生元となったagentID(教師由来なら未設定) */
  sourceAgentId?: string;
  /** Issue #156: `schoolInterventionTriggered`用。発生元が教師(agentを介さない介入)かどうか */
  isTeacherSource?: boolean;
  /** Issue #156: `schoolInterventionTriggered`用。発火理由(人間可読の短いタグ、個別介入が定義する) */
  triggerReason?: string;
  /** Issue #156: `schoolInterventionTriggered`用。一時効果の開始/終了tick */
  effectStartedAtTick?: number;
  effectExpiresAtTick?: number;
  /** Issue #156: `schoolInterventionTriggered`用。結果分類(提示/受諾/拒否/割当/割当不能等) */
  outcome?: SchoolInterventionOutcome;
  /**
   * Issue #157: `schoolInterventionTriggered`(`nearby-peer-prompt`)用。声かけを促した相手側
   * (`agentId`側と組になるもう一方)のagentID/表示名。Issue #158では`teacher-recommendation`が
   * 新規ペア形成推薦(`recommendationTargetKind: "peer"`)の推薦先peerとしても再利用する。
   */
  secondAgentId?: string;
  secondAgentLabel?: string;
  /** Issue #158: `teacherRecommendation*`用。推薦対象の種別(既存候補の班 or 未決定者peerとの新規候補形成) */
  recommendationTargetKind?: "group" | "peer";
  /** Issue #158: `teacherRecommendation*`用。候補選択スコアの主要要素(推薦対象までの距離) */
  recommendationDistance?: number;
  /** Issue #158: `teacherRecommendation*`用。候補選択スコアの主要要素(対象agentと既存clique関係にあるか) */
  recommendationSameClique?: boolean;
  /** Issue #158: `teacherRecommendationAccepted`/`teacherRecommendationDeclined`用。受諾確率(0-1) */
  recommendationAcceptanceProbability?: number;
  /**
   * Issue #158: `schoolInterventionTriggered`(`teacher-recommendation`、outcome: "assigned")用。
   * 推薦(`teacherRecommendationAccepted`)が発行されたtickから、実際にその班へ参加するまでの経過tick
   */
  ticksSinceRecommendation?: number;
  /**
   * Issue #159: `teacherAssigned*`/`randomAssignment*`/`randomGroupCreated`用。どちらの割当戦略による
   * 結果かを明示する(「教師の救済介入」と「自由形成を行わない比較基準」を混同しないための構造化フィールド)。
   */
  assignmentStrategy?: "teacherForced" | "randomBaseline";
  /** Issue #159: `teacherAssignedAgent`用。既存班の空きへの追加/新規班構成のいずれで割り当てられたか */
  assignmentKind?: "existingVacancy" | "newGroup";
  /** Issue #159: `teacherRebalancedGroup`用。再配分により移動する前に所属していた班ID */
  previousGroupId?: string;
  /** Issue #159: 容量情報が関係するイベントでのみ設定される、その候補の成立最小人数 */
  minGroupSize?: number;
  /**
   * Issue #159: `teacherAssignmentStarted`/`randomAssignmentStarted`用。処理開始時点で
   * 割当対象だった人数(教師強制割当は締切時点の未割当プール、ランダム割当は全人口)
   */
  assignmentPoolSize?: number;
  /** Issue #159: `teacherAssignmentCompleted`/`randomAssignmentCompleted`用。強制/ランダムで割り当てられた人数 */
  assignedByStrategyCount?: number;
  /** Issue #159: `teacherAssignmentCompleted`用。既存班の再配分により構成が変更された班数 */
  rebalancedGroupCount?: number;
  /** Issue #159: `teacherAssignmentCompleted`用。再配分により班を移された生徒数 */
  rebalancedStudentCount?: number;
  /**
   * Issue #159: `teacherAssignmentCompleted`/`randomAssignmentCompleted`/`teacherAssignmentUnable`用。
   * 容量制約上どうしても割当不可能だった構造的な余り人数
   */
  structuralUnassignedCount?: number;
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
   * Issue #156: このstateを生成したrunのseed(`createInitialState`の`seed`引数)。学校向け介入の
   * 実行コンテキスト(`SchoolInterventionContext.runSeed`)・介入専用rngの導出元として使う。
   * `interventionId`と同じfall backパターン(`stepSimulation`は引数でseedを受け取らないため、
   * 常に直前のstateから引き継ぐ)。未指定(既存stateの読み込み等)は`0`として扱う。
   */
  seed?: number;
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
   * Issue #154: `formationScenarioId`が`classroomPair`の場合に使われる、成立最小人数・収容最大人数の
   * 上書き。`formationScenarioId`/`formationDeadlineTick`と同じfall backパターン(呼び出し側が
   * 引き継ぎ忘れても直前の設定を維持する)で扱う。`classroomPair`以外では無視され、未指定時は
   * `DEFAULT_CLASSROOM_PAIR_GROUP_SIZE`(`formationPolicy.ts`、2人固定)が使われる。
   */
  formationClassroomGroupSize?: GroupSizeRule;
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
  /**
   * Issue #156: 学校向け介入(教師介入)の複数tickにまたがる進行状態。`interventionId`と同じ
   * fall backパターン(呼び出し側が引き継ぎ忘れても直前の設定を維持する)で扱う。未指定
   * (`createInitialState`直後、または既存stateの読み込み)は`createInitialInterventionRuntimeState`
   * が返す空状態。個別介入の実装が存在しない間は常にこの空状態のまま変化しない。
   */
  interventionRuntimeState?: InterventionRuntimeState;
  /**
   * Issue #156: 現在有効な`InterventionEffect`(学校向け介入由来の一時的な補正)の一覧。
   * `activeSpeechEffects`と同じ設計(時系列の蓄積ログではなく「今このtickで作用している効果」の
   * スナップショット)。個別介入の実装が存在しない間は常に空配列。
   */
  activeInterventionEffects?: InterventionEffect[];
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

/** Issue #135: Inspector/Canvasで表示する、ペア形成上の現在の割当状態 */
export type AgentAssignmentStatus =
  | "searching"
  | "waitingForPartner"
  | "approaching"
  | "searchingAgain"
  | "assigned"
  | "unassigned"
  | "leaving"
  | "left";

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
  /** Issue #133: 参加失敗により再探索した回数の累計(`Agent.searchRestartCount`、未発生なら0) */
  searchRestartCount: number;
  /** Issue #133: そのうち満員(容量起因)が理由だった回数の累計(`Agent.capacityFailureCount`、未発生なら0) */
  capacityFailureCount: number;
  /** Issue #135: AgentStateと再探索履歴から導出した、ペア形成上の現在の割当状態 */
  assignmentStatus: AgentAssignmentStatus;
  /** Issue #135: approaching中の場合に限る、現在の接近先候補ID */
  approachTargetGroupId?: string;
  /** Issue #135: joined/forming/approachingの場合に所属・対象となっている候補ID */
  currentGroupId?: string;
  /** Issue #135: `approachTargetInvalidated`/`joinFailedCapacity`の発生回数 */
  joinFailureCount: number;
  /** Issue #135: 最新の参加失敗理由と発生tick。未発生ならundefined */
  lastFailureReason?: ApproachFailureReason;
  lastFailureTick?: number;
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

/** 学校シナリオで締切時に未割当となった一人分の終了サマリー */
export type UnassignedAgentSummary = {
  agentId: string;
  label: string;
  /** 未割当確定直前の探索状態(`undecided`/`forming`/`approaching`等) */
  previousState?: AgentState;
  /** 確定直前に形成・接近していた候補。該当しない場合はundefined */
  targetGroupId?: string;
  searchRestartCount: number;
  capacityFailureCount: number;
  lastFailedCandidateId?: string;
  stress: number;
};

/**
 * Issue #159: `teacher-deadline-assignment`/`random-assignment-baseline`が関与した場合の、
 * 割当経路別の内訳。`state.log`の構造化イベント(`teacherAssigned*`/`schoolInterventionTriggered`)
 * のみから導出し、いずれの介入も未選択(自然形成のみ)の場合は全カウントが0になる
 * (受入条件: 既存班の再編と強制割当人数を監査できる、割当不能を隠さず記録・表示する)。
 */
export type AssignmentBreakdown = {
  /** 教師介入(推薦・強制割当)を経ずに自然形成で割り当てられた人数 */
  naturalCount: number;
  /** `teacher-recommendation`の受諾を経て割り当てられた人数 */
  recommendationAssistedCount: number;
  /** `teacher-deadline-assignment`により強制割当された人数(再配分による移動は含まない) */
  teacherForcedCount: number;
  /** 再配分により班を移された生徒数 */
  rebalancedStudentCount: number;
  /** 再配分により構成が変更された班数 */
  rebalancedGroupCount: number;
  /** 容量制約上どうしても割当不可能だった構造的な余り人数 */
  structuralUnassignedCount: number;
};

/**
 * シミュレーションの終了(または途中経過)サマリー。表示文言の文字列解析に依存せず、
 * `state.log`の構造化イベントと`state.agents`から導出する。`SimulationState`をmutationしない。
 * `finished: false`の状態でも呼び出し可能で、その時点までの暫定値を返す
 * (UI側で「終了前の暫定サマリー」として表示することを想定)。
 */
export type SimulationSummary = {
  finished: boolean;
  /**
   * Issue #159: 教師介入(推薦・強制割当)による割当経路別の内訳。`classroomPair`以外、または
   * 該当する介入が一度も発火していない場合でも常に定義され、全カウントが0になる。
   */
  assignmentBreakdown: AssignmentBreakdown;
  /** 終了tick。finished: falseの場合はundefined */
  finishedTick?: number;
  /** 構造化`simulationFinished`イベントから取得した終了理由。実行中・旧stateではundefined */
  finishReason?: SimulationFinishReason;
  joinedCount: number;
  leftCount: number;
  unassignedCount: number;
  /** 未割当者をagent順に保持する。実行中/二次会シナリオでは通常空配列 */
  unassignedAgents: UnassignedAgentSummary[];
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
  /**
   * Issue #136: 単発実行/Monte Carloの各runに適用するグループ形成ポリシー。省略時は
   * `resolveFormationPolicy`の既定値(後方互換として"afterParty")。classroomPair(学校シナリオ)の
   * Monte Carlo集計(`runPairFormationMonteCarlo`)を行うには、プリセット由来のこの値を渡す必要がある。
   */
  formation?: FormationRuntimeOptions;
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
  /**
   * Issue #136: 全runに共通で適用するグループ形成ポリシー。省略時は既定値("afterParty")。
   * `compareMonteCarloIntervention`はbaseline/intervention双方でこの値をそのまま引き継ぐ
   * (介入の比較とは独立した軸のため)。
   */
  formation?: FormationRuntimeOptions;
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
  /** 発言効果OFF/ONの両条件で共通して使う形成ポリシー */
  formation?: FormationRuntimeOptions;
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

/**
 * Issue #136: agent 1人分の、ペア/グループ形成過程の負荷を表す観察指標。`pairFormation.ts`の
 * `buildPairFormationRunSummary`が`state.log`の構造化イベント(`eventType`/`metadata`)と
 * `state.agents`のみから導出する(表示用`message`文言は参照しない)。
 */
export type PairFormationAgentMetric = {
  agentId: string;
  label: string;
  isObserverJoiner: boolean;
  /** run終了(または現時点)でのAgentState */
  finalState: AgentState;
  /** "approaching"へ遷移した回数の累計(`agentApproached`/`observerApproached`いずれかのeventTypeから集計) */
  approachCount: number;
  /** 参加失敗(`approachTargetInvalidated`/`joinFailedCapacity`)の発生回数 */
  joinFailureCount: number;
  /** 参加失敗による再探索の回数の累計(`Agent.searchRestartCount`) */
  searchRestartCount: number;
  /** そのうち満員(容量起因)が理由だった回数の累計(`Agent.capacityFailureCount`) */
  capacityFailureCount: number;
  /** このrunを通じて到達した最大stress(`Agent.maxStress`、未記録なら現在のstress) */
  maxStress: number;
  /** run終了(または現時点)でのstress */
  finalStress: number;
};

/** Issue #136: 属性(population全体/observerJoinerのみ)ごとの平均値 */
export type PairFormationMetricAverages = {
  averageApproachCount: number;
  averageJoinFailureCount: number;
  averageSearchRestartCount: number;
  averageCapacityFailureCount: number;
  averageMaxStress: number;
  averageFinalStress: number;
};

/**
 * Issue #136: 単一run分のペア/グループ形成過程サマリー。既存の`SimulationSummary`(観察対象は
 * observerJoinerの参加/離脱経過が中心)とは独立した集計軸であり、「割当に至るまでの過程の負担」
 * (未割当・参加失敗・再探索・stressのピーク・clique内外の偏り)に焦点を当てる。
 */
export type PairFormationRunSummary = {
  /** 成立した(confirmedになった)グループ/ペアの総数(`SimulationSummary.confirmedGroupCount`と同値) */
  confirmedPairCount: number;
  /** 最初にペア/グループが成立したtick。一度も成立していなければundefined */
  firstPairConfirmedTick?: number;
  /** 最後にペア/グループが成立したtick。一度も成立していなければundefined */
  lastPairConfirmedTick?: number;
  /** 割当済み("joined")人数 */
  assignedCount: number;
  /** 未割当("unassigned")人数 */
  unassignedCount: number;
  /**
   * 最後に成立したペア/グループへ、最後に加わった(=`GroupCandidate.memberIds`の末尾)agent。
   * 成立イベントが一度もなければundefined
   */
  lastAssignedAgent?: {
    agentId: string;
    label: string;
    tick: number;
    groupId: string;
  };
  /**
   * Issue #155 (Phase 4): 成立した(confirmedな)グループ/ペアを、最終的な人数(`memberIds.length`)別に
   * 集計した分布。キーは班人数(2, 3, 4, ...)、値はその人数で成立したグループ数。3〜4人班のような
   * 可変定員シナリオで「3人で成立した班」と「4人まで埋まった班」の内訳を確認できるようにする。
   * 固定定員シナリオでは常に単一キーのみを持つ。成立が1件もなければ空オブジェクト。
   */
  groupSizeDistribution: Record<number, number>;
  /** agent配列順のagent別指標 */
  agentMetrics: PairFormationAgentMetric[];
  /** population全体の平均(`agentMetrics`全件から算出) */
  populationAverages: PairFormationMetricAverages;
  /** observerJoinerのみの平均(observerJoinerが1人もいなければ全て0) */
  observerJoinerAverages: PairFormationMetricAverages;
  /**
   * 成立した(confirmedな)グループ/ペアのうち、全メンバーが同一cliqueに属していた割合。
   * 成立が1件もなければundefined
   */
  sameCliquePairRate?: number;
  /** `1 - sameCliquePairRate`(成立が1件もなければundefined) */
  crossCliquePairRate?: number;
  /**
   * このシナリオの定員が固定サイズ(`minGroupSize === maxGroupSize`かつ有限。classroomPairの2人固定等)
   * の場合のみ、人口をその固定サイズで割った余り = 理論上どうしても割当不可能な人数。
   * 定員が可変/実質無制限(afterParty等)のシナリオではundefined(「全員割当率」をそのまま
   * 失敗判定に使ってよいシナリオのため、この指標自体が不要)。
   */
  structuralUnassignedFloor?: number;
  /** `unassignedCount`のうち`structuralUnassignedFloor`を超える「追加的」未割当人数(floor未定義ならundefined) */
  excessUnassignedCount?: number;
};

/** 複数run分のペア/グループ形成過程集計値 */
export type PairFormationMonteCarloSummary = {
  runs: number;
  /** unassignedCount === 0 のrunの割合(0〜1) */
  allAssignedRate: number;
  /**
   * `structuralUnassignedFloor`が定義されているrunに限り、`excessUnassignedCount === 0`
   * (=理論上の必然的未割当を除けば全員割当できた)runの割合。対象runが1件もなければundefined
   */
  allAssignableRate?: number;
  averageUnassignedCount: number;
  /** `structuralUnassignedFloor`が定義されているrunのみを対象にした平均。対象runが1件もなければundefined */
  averageExcessUnassignedCount?: number;
  /** 未割当("unassigned")になった割合を、agent属性(observerJoiner/population全体)別に集計したもの */
  unassignedRateByAttribute: {
    observerJoiner: number;
    population: number;
  };
  averageApproachCount: number;
  averageJoinFailureCount: number;
  averageSearchRestartCount: number;
  /** run毎の完了(`finished`)tickの分布。run配列(seed順)と同じ順序・長さ */
  finishedTickDistribution: number[];
  /** `sameCliquePairRate`が定義されているrun(成立が1件以上あったrun)のみを対象にした平均。対象runが1件もなければundefined */
  averageSameCliquePairRate?: number;
  /** `crossCliquePairRate`の平均。`averageSameCliquePairRate`と同じ対象・条件 */
  averageCrossCliquePairRate?: number;
};

/** `runPairFormationMonteCarlo`の戻り値。既存の`MonteCarloResult`とは独立にペア形成指標を並立させる */
export type PairFormationMonteCarloResult = {
  config: MonteCarloConfig;
  runs: MonteCarloRunResult[];
  summary: MonteCarloSummary;
  /** `runs`と同じ順序・同じ長さ(seedで1:1対応)のペア形成過程run結果 */
  pairFormationRuns: PairFormationRunSummary[];
  pairFormationSummary: PairFormationMonteCarloSummary;
};

/**
 * Issue #160 (Phase 4): 学校向け教師介入(推薦・強制割当・再配分・ランダム割当)の構造化イベント
 * (`schoolInterventionTriggered`/`teacherRecommendation*`/`teacherAssigned*`/`teacherRebalancedGroup`/
 * `randomAssignment*`/`anonymousHelpRequested`)から`groupFormation.ts`が集計する、run単位の副作用指標。
 * 介入なし・二次会シナリオのrunでは全フィールドが0/falseになる。`PairFormationRunSummary`の
 * 未割当・stress・参加失敗等の既存指標に対して独立した追加の軸(「未割当が減ったか」だけでなく
 * 「何と引き換えだったか」を見るための指標群)。
 */
export type InterventionEffectMetrics = {
  /** `schoolInterventionTriggered`イベントの総数(介入が実際に効果/結果へ結び付いた回数) */
  interventionTriggerCount: number;
  /** `anonymousHelpRequested`イベントの総数 */
  anonymousHelpRequestedCount: number;
  /** `teacherRecommendationIssued`イベントの総数(推薦提示回数) */
  recommendationPresentedCount: number;
  /** `teacherRecommendationAccepted`イベントの総数 */
  recommendationAcceptedCount: number;
  /** `teacherRecommendationDeclined`イベントの総数 */
  recommendationDeclinedCount: number;
  /** `teacherRecommendationUnavailable`イベントの総数(推薦可能な候補が存在しなかった回数) */
  recommendationUnavailableCount: number;
  /** `teacherAssignmentCompleted`の`assignedByStrategyCount`(締切時の教師強制割当で割り当てられた人数) */
  teacherForcedAssignedCount: number;
  /** `teacherAssignmentCompleted`の`rebalancedGroupCount`(再配分により構成が変わった既存班数) */
  reassignedGroupCount: number;
  /** `teacherAssignmentCompleted`の`rebalancedStudentCount`(再配分により班を移された生徒数) */
  reassignedStudentCount: number;
  /** `teacherAssignmentCompleted`/`teacherAssignmentUnable`由来の、教師強制割当でもなお割当不能だった人数 */
  teacherUnassignableCount: number;
  /** `randomAssignmentCompleted`の`assignedByStrategyCount`(ランダム割当で割り当てられた人数) */
  randomAssignedCount: number;
  /** `randomAssignmentCompleted`の`structuralUnassignedCount`(ランダム割当でも割当不能だった構造的な人数) */
  randomUnassignableCount: number;
  /**
   * このrunで`random-assignment-baseline`が適用されたか(`randomAssignmentStarted`イベントの有無)。
   * trueの場合、接近・参加失敗・再探索・stressといった自由形成の過程指標は構造的に発生しない
   * (「0」ではなく「対象外」として扱うべきことを示すフラグ)。
   */
  isRandomAssignmentBaseline: boolean;
  /**
   * 割当済み("joined")人数のうち、教師強制割当/ランダム割当による人数(`teacherForcedAssignedCount +
   * randomAssignedCount`)。agent単位の追跡ではなく、完了イベントの集計値どうしの差分による近似値
   */
  interventionAssignedCount: number;
  /** `assignedCount - interventionAssignedCount`(自然形成のみで割当に至った人数の近似値) */
  naturalAssignedCount: number;
};

/**
 * Issue #160 (Phase 4): `PairFormationRunSummary`(#136、ペア専用の名前が残る)の一般化版。班形成
 * (3人以上・可変定員)でも意味が通る名前(`confirmedGroupCount`等)を標準語彙として追加し、既存の
 * ペア専用フィールド(`confirmedPairCount`等)は同値の後方互換aliasとしてそのまま残す(#160本文
 * 「1. ペア専用集計名の一般化」: 既存APIを直ちに破壊しない段階的移行)。`InterventionEffectMetrics`を
 * 合成し、介入の副作用指標も同一runサマリーへ含める。
 */
export type GroupFormationRunSummary = PairFormationRunSummary &
  InterventionEffectMetrics & {
    /** `confirmedPairCount`の一般化名(同値) */
    confirmedGroupCount: number;
    /** `firstPairConfirmedTick`の一般化名(同値) */
    firstGroupConfirmedTick?: number;
    /** `lastPairConfirmedTick`の一般化名(同値) */
    lastGroupConfirmedTick?: number;
    /** `sameCliquePairRate`の一般化名(同値)。班サイズが2以外でも意味が通る名前 */
    sameCliqueGroupRate?: number;
    /** `crossCliquePairRate`の一般化名(同値) */
    crossCliqueGroupRate?: number;
    /** 形成設定のスナップショット(#160本文「単発runの追加指標」: min/max/deadline/population) */
    formationConfig: {
      minGroupSize: number;
      maxGroupSize: number;
      deadlineTick?: number;
      populationSize: number;
    };
    /**
     * Issue #170: 割当済み("joined")agentを、所属が確定した経路(`AssignmentOrigin`)別に
     * 集計した人数。全カテゴリの合計は必ず`assignedCount`と一致する(`assignmentOrigin.ts`参照)。
     */
    assignmentOrigins: AssignmentOriginCounts;
    /**
     * Issue #170: 選択中の介入が`nearby-peer-prompt`/`open-group-signal`のいずれかの場合のみ定義される、
     * 発火から接近・所属・失敗までの構造化ファネル。それ以外の介入・介入なしでは`undefined`
     * (「0」ではなく「対象外」を明示するため)。
     */
    lowPressureInterventionFunnel?: LowPressureInterventionFunnel;
  };

/** 複数run分の`InterventionEffectMetrics`平均値。全てのrunが`isRandomAssignmentBaseline`ならその旨を`randomAssignmentBaselineRunRate`で示す */
export type InterventionEffectMonteCarloAverages = {
  averageInterventionTriggerCount: number;
  averageAnonymousHelpRequestedCount: number;
  averageRecommendationPresentedCount: number;
  averageRecommendationAcceptedCount: number;
  /** `accepted / (accepted + declined)`。提示が1件もなければundefined */
  recommendationAcceptanceRate?: number;
  averageTeacherForcedAssignedCount: number;
  /** `teacherForcedAssignedCount > 0`だったrunの割合(0〜1) */
  forcedAssignmentRate: number;
  averageReassignedGroupCount: number;
  averageReassignedStudentCount: number;
  /** `reassignedGroupCount > 0`だったrunの割合(0〜1) */
  reassignmentRate: number;
  averageRandomAssignedCount: number;
  /** `isRandomAssignmentBaseline === true`だったrunの割合(0〜1)。通常は0か1のいずれかに揃う */
  randomAssignmentBaselineRunRate: number;
};

/**
 * Issue #160 (Phase 4): `PairFormationMonteCarloSummary`の一般化版。一般化フィールド
 * (`confirmedGroupCount`系)に加え、中央値(#160本文「平均だけでなく、少なくとも中央値または
 * 分位点を表示する」)と`InterventionEffectMonteCarloAverages`を追加する。
 */
export type GroupFormationMonteCarloSummary = PairFormationMonteCarloSummary &
  InterventionEffectMonteCarloAverages & {
    medianUnassignedCount: number;
    averageMaxStress: number;
    medianMaxStress: number;
    /** `1 - allAssignedRate`。「介入後も未割当だった率」を明示的な名前で示す */
    stillUnassignedAfterRunRate: number;
    /** Issue #170: run毎の`assignmentOrigins`を起源別に平均した、1runあたりの平均人数 */
    assignmentOriginAverages: AssignmentOriginCounts;
    /**
     * Issue #170: `lowPressureInterventionFunnel`が定義されているrun(=低圧介入選択時)のみを対象にした
     * 平均値。対象runが1件もなければ`undefined`(「0」ではなく「対象外」を明示するため)。
     */
    lowPressureInterventionFunnelAverages?: LowPressureInterventionFunnel;
    /**
     * Issue #170: 平均値だけでは見えない分布を確認するための中央値(p50)・上位分位点(p90)。
     * 対象値は1run=1値としてrun間で分位点を取る(`quantiles.ts`の`computeQuantileSummary`)。
     * `excessUnassignedCount`は`structuralUnassignedFloor`が定義されているrunが1件もなければ`undefined`。
     */
    quantiles: QuantileMetrics;
  };

/** `runGroupFormationMonteCarlo`の戻り値 */
export type GroupFormationMonteCarloResult = {
  config: MonteCarloConfig;
  runs: MonteCarloRunResult[];
  summary: MonteCarloSummary;
  /** `runs`と同じ順序・同じ長さ(seedで1:1対応)の一般化グループ形成過程run結果 */
  groupFormationRuns: GroupFormationRunSummary[];
  groupFormationSummary: GroupFormationMonteCarloSummary;
};

/**
 * Issue #160 (Phase 4): `compareGroupFormation`の戻り値。同一`presetId`由来`params`・`formation`・
 * `baseSeed`・`runs`・`maxTicks`で、baseline(`interventionId: "none"`)と選択中の介入を実行した結果
 * 一式。`compareMonteCarloIntervention`(#99)と同じpaired比較の考え方に、班形成過程の負担・介入の
 * 副作用指標(未割当・stress・参加失敗・再探索・推薦受諾・強制割当・再配分等)のdeltaを追加する。
 */
export type GroupFormationComparisonResult = {
  baseline: GroupFormationMonteCarloResult;
  intervention: GroupFormationMonteCarloResult;
  /** `baseline.runs`と同じ順序のseed列。`intervention.runs`のseed列と常に一致する(paired比較の前提) */
  pairedSeeds: number[];
  /**
   * `intervention`側が`random-assignment-baseline`の場合はfalse。false時は
   * `groupFormationMetrics`の接近・参加失敗・再探索・stress系フィールドを「0」ではなく
   * 「対象外」として表示すべきことを示す(#160本文「ランダム割当は…比較表で『過程指標は直接比較
   * 不可／0が構造的』であることを明示する」)。
   */
  processMetricsComparable: boolean;
  metrics: MonteCarloComparisonResult["metrics"];
  groupFormationMetrics: {
    unassignedCount: MonteCarloMetricDelta;
    excessUnassignedCount: MonteCarloMetricDelta<number | undefined>;
    averageMaxStress: MonteCarloMetricDelta;
    averageJoinFailureCount: MonteCarloMetricDelta;
    averageSearchRestartCount: MonteCarloMetricDelta;
    interventionTriggerCount: MonteCarloMetricDelta;
    recommendationAcceptedCount: MonteCarloMetricDelta;
    teacherForcedAssignedCount: MonteCarloMetricDelta;
    reassignedStudentCount: MonteCarloMetricDelta;
    randomAssignedCount: MonteCarloMetricDelta;
    /** Issue #170: 平均だけでなくp50/p90でもbaseline/介入を比較できるようにする */
    maxStressP50: MonteCarloMetricDelta;
    maxStressP90: MonteCarloMetricDelta;
    finishedTickP50: MonteCarloMetricDelta;
    finishedTickP90: MonteCarloMetricDelta;
  };
};

/**
 * Issue #170: agentの最終所属("joined")が確定した経路の分類。最終stateだけからの推測ではなく、
 * 所属確定に関連する構造化イベント(`schoolInterventionTriggered`の`triggerReason`/`outcome`、
 * `teacherAssignedAgent`/`teacherRebalancedGroup`、`randomAssignmentStarted`の有無)から
 * `assignmentOrigin.ts`が導出する。低圧介入(`nearby-peer-prompt`/`open-group-signal`)は所属を
 * 強制しないため、`lowPressureAssisted`は「介入効果期間中の接近から所属した」という相関関係であり、
 * 因果の断定ではない(`docs/`参照)。
 */
export type AssignmentOrigin =
  | "natural"
  | "lowPressureAssisted"
  | "recommendationAssisted"
  | "teacherAssigned"
  | "randomAssigned";

/** `AssignmentOrigin`別の人数。合計は常に対象agent集合の人数と一致する */
export type AssignmentOriginCounts = Record<AssignmentOrigin, number>;

/**
 * Issue #170: 低圧介入(`nearby-peer-prompt`/`open-group-signal`)専用の「発火 → 対象 → 接近 →
 * 所属/失敗」ファネル。選択中の介入がこの2つのいずれでもない場合、呼び出し側は`undefined`を扱う
 * (「0」ではなく「対象外」であることを明示するため)。`assignmentOrigin.ts`参照。
 */
export type LowPressureInterventionFunnel = {
  interventionScenarioId: "nearby-peer-prompt" | "open-group-signal";
  /** `schoolInterventionTriggered`(`outcome: "presented"`)の発火回数 */
  triggeredCount: number;
  /**
   * 介入対象となった延べagent数(重複除く)。`open-group-signal`は特定agentを狙い撃つ介入ではなく
   * 未決定者全員への一時効果のため、「対象群にいたと確認できるagent」= 対象groupへ接近したagentの
   * 近似値になる(`nearby-peer-prompt`は`schoolInterventionTriggered`のagentId/secondAgentIdそのもの)。
   */
  targetedAgentCount: number;
  /** 介入対象となったgroup数(`nearby-peer-prompt`は候補と紐づかないため常に0) */
  targetedGroupCount: number;
  /** 対象agentのうち、関連する効果期間内に接近(`agentApproached`/`observerApproached`)を開始した数 */
  approachedDuringEffectCount: number;
  /** 効果期間中の接近から実際に所属まで至った数(`assignmentOrigins.lowPressureAssisted`と同値) */
  assistedJoinCount: number;
  /** 効果期間中に接近したが、満員化・消滅等で所属に至らなかった数 */
  failedAfterApproachCount: number;
  /** 対象になったが接近すら起きなかった数 */
  noActionCount: number;
};

/** Issue #170: 分位点1件分(中央値・90パーセンタイル)。`quantiles.ts`の`computeQuantileSummary`が返す */
export type QuantileSummary = {
  p50: number;
  p90: number;
};

/** Issue #170: Monte Carlo集計へ追加する分位点一式。各値はrun毎に1値を対応させた上でrun間の分位点を取る */
export type QuantileMetrics = {
  /** run毎の`populationAverages.averageMaxStress`の分位点 */
  maxStress: QuantileSummary;
  /** run毎の完了tickの分位点 */
  finishedTick: QuantileSummary;
  /** run毎の`populationAverages.averageJoinFailureCount`(agentあたり参加失敗回数)の分位点 */
  joinFailureCount: QuantileSummary;
  /** run毎の`populationAverages.averageSearchRestartCount`(agentあたり再探索回数)の分位点 */
  searchRestartCount: QuantileSummary;
  /** run毎の`unassignedCount`の分位点 */
  unassignedCount: QuantileSummary;
  /** run毎の`excessUnassignedCount`の分位点。対象run(`structuralUnassignedFloor`定義済み)が1件もなければundefined */
  excessUnassignedCount?: QuantileSummary;
};
