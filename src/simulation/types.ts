import type { InterventionAudience, InterventionRuntimeOptions, InterventionScenarioId } from "./interventions";
import type { FormationRuntimeOptions, FormationScenarioId, GroupSizeRule } from "./formationPolicy";
import type { StandingPartyScenarioConfig } from "./standingPartyScenarioConfig";
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
import type { CurrentClusterAttachmentState, DepartureConcernFactor } from "./currentClusterAttachment";
import type { AlternativeClusterInterestFactor } from "./alternativeClusterInterest";
import type { InformationRuntimeState } from "./informationState";
import type { ClusterTopicRuntimeState } from "./conversationTopic";
import type { ContentUtteranceEvent, ContentUtteranceReason } from "./contentUtterance";
import type {
  InformationAdoptionEvent,
  InformationMemoryUpdateEvent,
  InformationReceptionEvent,
} from "./informationTransmission";
import type { ClaimVariant } from "./informationModel";
import type { RetellingEvent, RetellingRuntimeState } from "./retelling";

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
   * Issue #176: 現在の`joinedGroupId`が指すクラスタへ最後に合流(参加)したtick。
   * 責務9(`evaluateClusterDeparture`)が参照する「滞在tick」の起点として使う。
   * `joined`以外の状態では意味を持たず、離脱・所属先喪失時にはクリアされる。
   */
  clusterJoinedAtTick?: number;
  /**
   * Issue #176: 直近で(会場退出ではなく)会話クラスタ自体を離脱した候補ID。
   * Issue #133の`lastFailedCandidateId`(合流前の参加失敗)とは意味が異なるため独立したフィールドとして
   * 持たせる(受入条件: 検索失敗用の既存フィールドと意味が衝突しない)。再探索時、この候補への
   * 即時再接近を避けるクールダウン判定に使う(`lastDepartedClusterAtTick`からの経過tickで判定)。
   */
  lastDepartedClusterId?: string;
  /** Issue #176: `lastDepartedClusterId`が記録されたtick(クールダウン判定の起点) */
  lastDepartedClusterAtTick?: number;
  /** Issue #176: `joined`から会話クラスタ離脱により`undecided`へ戻り、再探索した回数の累計 */
  clusterDepartureCount?: number;
  /**
   * Issue #201 (Phase 3, ステップP3-D): `switchToTargetCluster`確定後に持つ、目的地への一時的な
   * 移動意図(`docs/cluster-transition-phase3-model.md` 1.5節・3.4節)。standingParty以外・
   * Phase 3無効時は常にundefined。`state`が`undecided`/`approaching`の間のみ存在し、生成後は
   * 再評価しない(targetを乗り換えない)。join成功・3.3節の無効化・TTL超過・`leaving`遷移・
   * 強制releaseのいずれかで破棄する。`agent.joinedGroupId`が接近先の正本のままであることは変わらず
   * (1.5節)、このフィールドは意図の記録・無効化判定・step 2の候補選択バイパス専用に読む。
   */
  pendingClusterTransition?: PendingClusterTransition;
  /**
   * Issue #186 (Phase 2): 現在`joined`している会話クラスタの「1回のjoin〜離脱」を表すエピソード状態。
   * `clusterJoinedAtTick`と同じライフサイクル(合流時に初期化、離脱・所属先喪失時にクリア)で扱う、
   * 上位互換のコンテナ。`joinedAtTick`は常に`clusterJoinedAtTick`と一致する(二重管理の不変条件、
   * `conversationEpisode.test.ts`で検証)。`joined`以外の状態、または一度も合流していない場合はundefined。
   * 満足度の具体的な初期化・更新式はPhase 2の対象外(docs/conversation-satisfaction-model.md) ―
   * `conversationSatisfaction`は後続Issueが設定可能な器としてのみ用意する。
   */
  currentEpisode?: ConversationEpisode;
  /**
   * Issue #188 (Phase 2): 社交的回遊傾向 ―― 会話への不満がなくても、より多くの人と交流するため
   * 次の輪へ移りやすいかを表す安定的な個体特性 `[0,1]`(run中不変)。`docs/conversation-satisfaction-model.md`
   * 1.2節。`willingness`/`initiative`/`conformity`とは独立した軸であり、これらから暗黙に導出しない
   * (要件4節)。standingPartyの責務9(`evaluateClusterDeparture`)でのみ参照される
   * ―― afterParty/classroomPairはこの値を読まない。`createInitialAgents`が主系列rngとは独立した
   * 派生ストリームから常に生成するため、値自体は全シナリオのagentに存在するが、未設定
   * (テストで直接`Agent`を構築する場合等)を許容し、その場合は読み取り側が`0.5`へフォールバックする。
   */
  socialCirculationTendency?: number;
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

/**
 * Issue #188 (Phase 2): 責務9の離脱確率へ寄与する要因の種別。`docs/conversation-satisfaction-model.md`
 * 4節の型契約どおり、表示文言の文字列解析に依存しない構造化コードとして持つ。
 * - "lowConversationSatisfaction": 今の会話への満足度が低いために離れる(不満由来)
 * - "socialCirculation": 会話に不満はなくても、より多くの人と交流するため次の輪へ移る(回遊由来)
 */
export type ClusterDepartureFactorKind = "lowConversationSatisfaction" | "socialCirculation";

/** Issue #188: 各要因の寄与(確率への加算分)を構造化して返す。`contribution`は常に`>= 0` */
export type ClusterDepartureFactor = {
  kind: ClusterDepartureFactorKind;
  contribution: number;
};

/**
 * Issue #188: `evaluateClusterDeparture`が返す主要因。両寄与の差が小さい場合は、どちらか一方を
 * 強弁せず"mixedConversationAndSocialCirculation"として表現する(issue要件6節)。
 */
export type ClusterDeparturePrimaryReason = ClusterDepartureFactorKind | "mixedConversationAndSocialCirculation";

/**
 * Issue #200 (Phase 3): 責務9のクラスタ遷移decisionが選べる3action。`docs/cluster-transition-phase3-model.md`
 * (Issue #197 ADR)4節の型契約どおり。`stay`はmembership・stateを変更しない。`departAndExplore`は
 * 目的地を持たない既存の自発離脱・再探索経路(Phase 2と同一)。`switchToTargetCluster`は目的地付きの
 * 離脱で、実際の目的地への接近・無効化・fallbackは#201の対象(本Issueでは決定・記録のみ)。
 */
export type ClusterTransitionAction = "stay" | "departAndExplore" | "switchToTargetCluster";

/**
 * Issue #200 (Phase 3): `ClusterTransitionDecision.primaryReason`。Phase 2の3値
 * (`ClusterDeparturePrimaryReason`)をそのまま包含し(後方互換)、離脱側が他クラスタ関心由来で
 * 支配的な場合(`alternativeClusterInterest`/`mixedDepartureAndAlternativeInterest`)と、
 * 抑制(愛着・配慮)が効いて`stay`が支配的な場合(`stayedBy*`)を追加する(ADR 4.3節の状況表)。
 */
export type ClusterTransitionPrimaryReason =
  | ClusterDeparturePrimaryReason
  | "alternativeClusterInterest"
  | "mixedDepartureAndAlternativeInterest"
  | "stayedByAttachment"
  | "stayedByDepartureConcern"
  | "stayedByMixedInhibition"
  /**
   * Issue #233 (Phase 5): topic/情報state統合(`topicCompatibility.ts`)由来の追加reason。
   * `lowConversationSatisfaction`/`alternativeClusterInterest`/inhibition系reasonのうち、
   * topic要因が主要因だった場合に限り、この6値へ差し替えられる(`clusterTransitionDecision.ts`の
   * `refineReasonForTopicSignal`)。`topicSignal`未設定(Phase 5 disabled)の間は一切生成されない。
   */
  | "topicMismatch"
  | "topicFatigue"
  | "informationSeeking"
  | "novelInformationOpportunity"
  | "mixedConversationAndInformation"
  | "stayedDespiteInformationInterest";

/**
 * Issue #176: `clusterDepartureStarted`/`clusterDepartureCompleted`の`metadata.departureReason`に
 * 保持する、離脱理由の構造化コード。表示文言の文字列解析に依存せず後続の集計ができるようにする。
 * - "clusterBelowMinimumSize": Issue #177(責務10)。自発的な離脱ではなく、他memberの離脱で
 *   クラスタが成立最小人数を下回ったため、残存memberが強制的に再探索へ戻された
 *   (`clusterMemberReleased`イベントで使う)
 * - `ClusterDeparturePrimaryReason`(Issue #188, Phase 2): 責務9の自発的離脱(`clusterDepartureStarted`/
 *   `Completed`)の主要因。
 * - `ClusterTransitionPrimaryReason`(Issue #200, Phase 3)がPhase 2の3値を包含する形で拡張したため、
 *   Phase 3有効時はこのフィールドへ追加の値(`alternativeClusterInterest`等)が入ることがある
 *   (既存の3値だけを扱う消費者を壊さない、ADR 4.3節)。
 *
 * 移行メモ: Phase 1では"provisionalStayDuration"(一定滞在tick超過後の、agent特性に依存しない
 * 固定確率抽選による離脱)という第3のコードが存在したが、Phase 2実装(Issue #188)でこの暫定ルール
 * 自体を撤去したため、このコードは生成されなくなった。過去に保存・集計されたログにこの文字列が
 * 残っている場合は「Phase 1の暫定ルールによる離脱」であったことを示す歴史的な値として読み替えること
 * (このアプリはシミュレーション結果を永続化しないため、実データ上の互換対応は不要)。
 */
export type ClusterDepartureReason = ClusterTransitionPrimaryReason | "clusterBelowMinimumSize";

/**
 * Issue #201 (Phase 3, ステップP3-D): `switchToTargetCluster`確定と同時に生成する、目的地への
 * 一時的な移動意図。`docs/cluster-transition-phase3-model.md`(Issue #197 ADR)1.5節・4節・3.4節の
 * 型契約どおり。生成後は不変(再評価しない、targetを乗り換えない) ―― join成功・3.3節の無効化・
 * TTL超過・`leaving`遷移・強制releaseのいずれかで破棄する。`agent.joinedGroupId`が接近先の正本の
 * ままであり(1.5節)、このフィールドは意図の記録・無効化判定・step 2の候補選択バイパス専用に読む。
 * 容量の事前予約は一切行わない(#201の背景が指摘する既存の同一tick競合・capacity契約を壊さないため)。
 */
export type PendingClusterTransition = {
  targetClusterId: string;
  /** 関心を主に駆動したmember(ADR 1.1.1節)。距離・入りやすさだけで選ばれた場合はundefined */
  focusAgentId?: string;
  sourceClusterId: string;
  decidedAtTick: number;
  /** `decidedAtTick + ClusterTransitionConfig.pendingTransitionTtlTicks` */
  expiresAtTick: number;
  /** 決定時点の他クラスタ関心score`[0,1]`(以後再評価しない、3.4節) */
  interestScore: number;
  primaryReason: ClusterTransitionPrimaryReason;
};

/**
 * Issue #201 (Phase 3): `PendingClusterTransition`が無効化される理由(ADR 3.3節の優先順位表どおり、
 * 同時に複数成立しても最初の1つだけを記録する)。
 * - "currentClusterLost": 意図の生成元clusterが消滅済みで、意図自体が既に意味を失っている(防御的)
 * - "targetMissing": targetのcandidateが`groupCandidates`に存在しない
 * - "targetDissolved" / "targetExpired": targetの`status`が`dissolving`/`dissolved` / `expired`
 * - "targetFull": targetが容量上限に達した
 * - "focusAgentLeft": `focusAgentId`が設定されており、そのagentがtargetの`memberIds`に含まれない
 * - "intentExpired": `tick >= expiresAtTick`(TTL超過)
 */
export type ClusterTransitionInvalidationReason =
  | "currentClusterLost"
  | "targetMissing"
  | "targetDissolved"
  | "targetExpired"
  | "targetFull"
  | "focusAgentLeft"
  | "intentExpired";

/**
 * Issue #186 (Phase 2): 1回の`joined`〜離脱までの、ひとつながりの会話エピソードの状態。
 * `docs/conversation-satisfaction-model.md` 1.3節「会話エピソード / 滞在時間」の型化。
 * - `episodeId`: `${agentId}:${clusterId}:${joinedAtTick}`から決定的に導出する(rngを消費しない)。
 *   同一clusterへの再参加でも`joinedAtTick`が異なるため、常に前回と異なるIDになる。
 * - `joinedAtTick`/`lastUpdatedTick`: 合流tickと、直近でこのエピソードの状態を更新したtick
 *   (`joinedAtTick <= lastUpdatedTick <= 現在tick`)。滞在tickは`lastUpdatedTick - joinedAtTick`で導出する。
 * - `memberCountAtJoin`: 合流が成立した瞬間の`candidate.memberIds.length`(自分自身を含む)。
 * - `lastObservedMemberCount`: 直近の更新時点で観測した同席人数。次回更新時に現在の人数と比較すると
 *   「直近tickでmember構成が変化したか」を判定できる(具体的な比較・反映タイミングの契約は
 *   `docs/conversation-satisfaction-model.md` 3.3節、実装はPhase 2の対象外)。
 * - `conversationSatisfaction`: 後続Issueが初期化・更新式を実装するための器。Phase 2では一切
 *   書き込まれない(常にundefined)。
 * - `attachment`: Issue #199 (Phase 3): 今の会話エピソードから離れにくい度合いを表す、
 *   満足度とは独立の状態(`docs/cluster-transition-phase3-model.md` 1.2節)。
 *   `currentClusterAttachment.ts`の`initializeAttachment`/`updateAttachment`が
 *   同じjoin境界・同じtick順序で初期化・更新する。standingParty以外、または合流直後の一部の
 *   経路では常にundefined。episodeが終了すれば(この型ごと)自動的に破棄され、前episodeの愛着を
 *   継承しない(前episodeを別のepisodeIdで再作成するだけで新しいクリア処理は不要)。
 */
export type ConversationEpisode = {
  episodeId: string;
  clusterId: string;
  joinedAtTick: number;
  lastUpdatedTick: number;
  memberCountAtJoin: number;
  lastObservedMemberCount: number;
  conversationSatisfaction?: number;
  attachment?: CurrentClusterAttachmentState;
  /**
   * Issue #200 (Phase 3): `clusterTransitionInhibited`をこのエピソード内で既に記録したか
   * (ADR 8.1節: 「関心はあったがなぜ留まったのか」を1エピソードにつき最初の1回だけ記録する)。
   * episode終了で(この型ごと)自動的に破棄されるため、新しいエピソードでは常に未記録から始まる。
   */
  transitionInhibitedLogged?: boolean;
};

/**
 * Issue #186 (Phase 2): 会話エピソードが終了した理由。表示文言の解析に依存させず、構造化イベントの
 * metadata(`episodeEndReason`)や将来のテスト・集計から区別できるようにする。
 * - "voluntaryDeparture": 責務9による自発的なクラスタ離脱(`clusterDepartureCompleted`)
 * - "memberReleased": 責務10によるクラスタの成立最小人数割れに伴う強制解放(`clusterMemberReleased`)
 * - "membershipLost": 所属先候補自体がmissing/dissolved/expired等になった際の整合性回復
 *   (Issue #212: 観測用の`clusterMembershipLost`イベントで記録する。意思決定・PRNGには影響しない)
 */
export type ConversationEpisodeEndReason = "voluntaryDeparture" | "memberReleased" | "membershipLost";

/**
 * `simulationFinished`イベントに保持する、シナリオ全体の終了理由。
 * `allAssigned`/`deadlineReached`/`allSettled`/`maxTicksReached`は、いずれも`FormationPolicy`が
 * 判定する**意味論的な自然終了**(semantic finish、社会過程そのものが終わったこと)を表す。
 * `observationHorizonReached`(Issue #175)はこれらとは独立した軸で、`FormationPolicy`が
 * 自然終了を持たない/まだ判定していない状態のまま、呼び出し側が明示した観測期間の上限tick
 * (`SimulationState.observationHorizonTick`)に達したことだけを表す。「社会過程が終わった」という
 * 意味づけを一切含まない(バッチ実行・テスト・Monte Carloが有限時間で必ず停止するための、観測側の
 * 都合による打ち切り)。立食パーティー(`standingParty`)は`FormationPolicy.isFinished`/`finishReason`が
 * 常に自然終了しない(全員所属・全クラスタ成立・クラスタ0件のいずれでも終了しない)ため、
 * バッチ実行時はこの理由でのみ終了する。
 */
export type SimulationFinishReason =
  | "allAssigned"
  | "deadlineReached"
  | "allSettled"
  | "maxTicksReached"
  | "observationHorizonReached";

/**
 * GroupCandidateのライフサイクル状態。
 * forming: 未確定の輪として形成中。
 * confirmed: 成立済みグループ。二次会・学校シナリオでは終端状態だが、`FormationPolicy
 *   .confirmedClusterIsMutable`がtrueのシナリオ(Issue #177: standingParty)では「成立後も
 *   join/leaveで人数が変動するactiveな会話クラスタ」を表す(ADR: docs/interaction-cluster-model.md
 *   3.3節3。`status`列挙自体は追加せず、confirmedが終端か継続かはpolicyが決める)。
 * dissolving: 反応が薄い/時間切れ/(standingPartyでは)成立最小人数割れ等の理由で解散が決まり、
 *   視覚的にフェードアウトしている途中(終端手前)。
 * dissolved: 反応が薄いまま、または成立後に人数が0になって消えた(終端状態)。
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
  /**
   * Issue #177(責務10、ADR 3.1節で検討候補として挙げられていたフィールド): この候補が
   * `memberIds.length >= 成立最小人数`へ実際に達したことが一度でもあるか。責務3の成立判定
   * (`computeConfirmationCount`)はafterPartyの近接ヒューリスティックを流用しており、
   * まだ`memberIds`へ正式加入していない接近中/形成中の人も「集まった人数」に数えるため、
   * confirmedへ遷移した直後は実際の`memberIds.length`がそれより少ないことがある。
   * `FormationPolicy.confirmedClusterIsMutable`なクラスタの縮小判定(責務10)は、この猶予期間中の
   * 人数不足を「離脱による解散」と誤判定しないよう、このフラグがtrueになって以降にのみ適用する。
   * `confirmedClusterIsMutable`でないシナリオ(afterParty/classroomPair)では参照されない。
   */
  everConfirmed?: boolean;
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
  | "joinFailure"
  /**
   * Issue #176: 合流済みクラスタからの離脱・再探索・再参加に関するイベント。「会場からの退出」
   * (既存の`leave`タグ)とは意味を分ける(受入条件: クラスタ離脱と会場退出をログ/タグから区別できる)。
   */
  | "clusterDeparture"
  /** Issue #230 (Phase 5): active clusterでの内容発話(topic/claim付き発言)・話題選択に関するイベント */
  | "contentUtterance";

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
  | "randomAssignmentCompleted"
  /**
   * Issue #176: 責務9(`evaluateClusterDeparture`)によりjoined状態のagentが会話クラスタからの
   * 離脱を開始した(candidate.memberIdsからはまだ除去していない時点)。Phase 1では
   * `clusterDepartureCompleted`と同一tickで発生する(離脱そのものが多tickにまたがる遷移を
   * 持たないため)が、将来multi-tick化されても開始/完了を区別できるよう別イベントとして分けている。
   */
  | "clusterDepartureStarted"
  /** Issue #176: 上記の離脱が完了した(candidate.memberIdsから除去し、agentがundecidedへ戻った) */
  | "clusterDepartureCompleted"
  /** Issue #176: クラスタ離脱が完了し、再探索状態(undecided)に戻ったことを明示する */
  | "clusterResearchStarted"
  /**
   * Issue #176: 一度でもクラスタ離脱したことのあるagentが、新たに(同じクラスタ・別クラスタの
   * いずれでも)合流した。`metadata.previousClusterId`で離脱元、`metadata.groupId`で合流先を持つ。
   */
  | "clusterRejoined"
  /**
   * Issue #177: undecidedなagentが候補(forming/confirmed問わず)へ合流した(`state`が`joined`に
   * なった)。`agentApproached`と同じ設計で、observerJoinerには従来どおり`observerJoinedForming`/
   * `observerJoinedConfirmed`が別途記録される(このeventTypeはそれ以外のagent向け)。
   * `metadata.joinedGroupStatus`で未確定の輪への合流("forming")か、成立済み/activeなクラスタへの
   * 参加("confirmed")かを判別できる。
   */
  | "agentJoined"
  /**
   * Issue #177(責務10): `FormationPolicy.confirmedClusterIsMutable`なクラスタ(standingParty)で、
   * 責務9由来の離脱が発生した後もmemberIds.lengthが成立最小人数以上を維持しており、
   * クラスタが引き続きactiveであることを表す。
   */
  | "activeClusterShrunk"
  /**
   * Issue #177(責務10): activeなクラスタの人数が成立最小人数を下回り(0人にはなっていない)、
   * dissolvingへ遷移したことを表す。残存memberは同一tickで`clusterMemberReleased`により
   * 再探索へ戻される。
   */
  | "activeClusterDissolving"
  /**
   * Issue #177(責務10): activeなクラスタの人数が0人になり、猶予なく即座にdissolvedへ遷移した
   * ことを表す。
   */
  | "activeClusterDissolved"
  /**
   * Issue #177(責務10): `activeClusterDissolving`/`activeClusterDissolved`により、joined状態
   * だった残存memberが自発的な離脱ではなく強制的にundecidedへ戻され、再探索を始めたことを表す
   * (`clusterDepartureStarted`/`Completed`は責務9由来の自発的離脱専用であり、この経路では発生しない)。
   */
  | "clusterMemberReleased"
  /**
   * Issue #200 (Phase 3): クラスタ遷移decisionが`stay`を選び、かつ愛着・離脱配慮由来の抑制
   * (`inhibition.total > 0`)が効いていたことを、1エピソードにつき最初の1回だけ記録する
   * (ADR 8.1節)。`standingPartyConfig.transition.enabled`が`false`の間は発生しない。
   */
  | "clusterTransitionInhibited"
  /**
   * Issue #201 (Phase 3): `switchToTargetCluster`が確定し、`PendingClusterTransition`を生成した
   * (責務9の離脱と同一処理内、原子的)。`standingPartyConfig.transition.enabled`が`false`の間は
   * 発生しない。
   */
  | "clusterTransitionTargetSelected"
  /**
   * Issue #201 (Phase 3): 移動意図が無効化された(ADR 3.3節の優先順位表どおり、`metadata
   * .invalidationReason`に理由を1つだけ持つ)。
   */
  | "clusterTransitionTargetInvalidated"
  /**
   * Issue #201 (Phase 3): 意図したtargetへ実際にjoinできた。既存の`clusterRejoined`/`agentJoined`
   * とは別に、目的地付き移動意図そのものの成否として記録する。
   */
  | "clusterTransitionCompleted"
  /**
   * Issue #201 (Phase 3): 無効化直後、通常の`nearestCandidate`探索へfallbackしたことを表す
   * (`clusterTransitionTargetInvalidated`の直後に続く1件で「その後どうなったか」を補う)。
   */
  | "clusterTransitionAbandoned"
  /**
   * Issue #212 (standing-party Phase 4 分析): 所属先候補がmissing/dissolved/expired等になり、
   * 整合性回復で`joined`→`undecided`へ戻したこと(`episodeEndReason: "membershipLost"`)。
   * 観測穴埋め専用で、意思決定・PRNG・離脱判定には使わない(`docs/standing-party-analysis-phase4-model.md` Gap A)。
   */
  | "clusterMembershipLost"
  /**
   * Issue #230 (Phase 5): confirmed clusterで内容発話(`ContentUtteranceEvent`)が1件生成された。
   * `metadata.topicId`/`claimId`/`variantId`/`contentUtteranceReason`/`topicTransition`で
   * 誰が・どのtopicを・どのclaim/variantとして・topicが継続/変更/開始のいずれで話したかを追跡できる。
   */
  | "contentUtteranceGenerated"
  /**
   * Issue #230 (Phase 5): 発話機会が巡ってきたclusterで、発話可能な話者/claimが見つからず発話が
   * 起きなかった。同一clusterで理由が変わらない間は再記録しない(受入条件: 発話なしを毎tick大量記録しない)。
   */
  | "contentUtteranceSkipped";

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
  /**
   * Issue #176: `clusterDepartureStarted`/`clusterDepartureCompleted`用。この時点までクラスタに
   * 留まっていたtick数(責務9の`ClusterDepartureContext.ticksInCluster`のスナップショット)
   */
  ticksInCluster?: number;
  /** Issue #176: `clusterDepartureStarted`/`clusterDepartureCompleted`用。離脱理由の構造化コード */
  departureReason?: ClusterDepartureReason;
  /** Issue #176: `clusterRejoined`用。離脱元のクラスタID(`agent.lastDepartedClusterId`) */
  previousClusterId?: string;
  /** Issue #176: `clusterRejoined`用。離脱してから今回の合流までに経過したtick数 */
  ticksSinceDeparture?: number;
  /**
   * Issue #177: `activeClusterShrunk`/`activeClusterDissolving`/`activeClusterDissolved`/
   * `clusterMemberReleased`用。この変化が起きる直前のmemberIds.length(`memberCount`は
   * 変化後の値を保持する既存の意味を維持する)
   */
  memberCountBefore?: number;
  /**
   * Issue #186 (Phase 2): `agentJoined`/`observerJoinedForming`/`observerJoinedConfirmed`/
   * `clusterRejoined`(開始)・`clusterDepartureCompleted`/`clusterMemberReleased`/
   * `clusterMembershipLost`(終了)用。該当する会話エピソードの`ConversationEpisode.episodeId`
   */
  episodeId?: string;
  /**
   * Issue #186 (Phase 2): `clusterDepartureCompleted`/`clusterMemberReleased`/
   * `clusterMembershipLost`(Issue #212)用。エピソード終了理由
   */
  episodeEndReason?: ConversationEpisodeEndReason;
  /**
   * Issue #188 (Phase 2): `clusterDepartureStarted`/`clusterDepartureCompleted`用。離脱評価時点の
   * 会話満足度`[0,1]`(`ClusterDepartureContext.conversationSatisfaction`のスナップショット)
   */
  conversationSatisfactionAtDeparture?: number;
  /** Issue #188: 同上。このagentの社交的回遊傾向`[0,1]`(`ClusterDepartureContext.socialCirculationTendency`) */
  socialCirculationTendency?: number;
  /** Issue #188: 離脱確率の内訳(寄与降順)。表示文言は含まない構造化データのみ */
  departureFactors?: ClusterDepartureFactor[];
  /** Issue #188: このtickの離脱評価で実際に`rng.chance`へ渡した最終確率`[0,1]` */
  departureProbability?: number;
  /**
   * Issue #200 (Phase 3): `clusterDepartureStarted`/`clusterDepartureCompleted`/
   * `clusterTransitionInhibited`用。このtickのクラスタ遷移decisionが選んだaction
   * (`standingPartyConfig.transition.enabled`が`false`の間は常にundefined)。
   */
  transitionAction?: ClusterTransitionAction;
  /** Issue #200: `switchToTargetCluster`が選ばれた場合の目的地クラスタID(#201が実際の接近へ使う) */
  targetClusterId?: string;
  /** Issue #200: 目的地関心を主に駆動したmember(ADR 1.1.1節)。特定の相手が理由でない場合はundefined */
  focusAgentId?: string;
  /** Issue #200: 決定時点の最良他クラスタ関心score`[0,1]`(#198) */
  alternativeInterestScore?: number;
  /** Issue #200: 上記の寄与内訳(contribution降順) */
  alternativeInterestFactors?: AlternativeClusterInterestFactor[];
  /** Issue #200: 決定時点の現在クラスタ愛着`[0,1]`(#199) */
  attachmentValue?: number;
  /** Issue #200: 決定時点の構造的配慮の合計`[0,1]`(#199の`DepartureInhibition.concern`) */
  departureConcern?: number;
  /** Issue #200: 抑制の寄与内訳(contribution降順) */
  inhibitionFactors?: DepartureConcernFactor[];
  /** Issue #200: 観察専用の葛藤強度`[0,1]`(ADR 1.4節、`min(interestDrive, inhibition)`) */
  conflictIntensity?: number;
  /** Issue #200: 決定時点の3action確率(合計は常に1) */
  transitionActionProbabilities?: Record<ClusterTransitionAction, number>;
  /**
   * Issue #201: `clusterTransitionTargetSelected`/`clusterTransitionTargetInvalidated`/
   * `clusterTransitionCompleted`/`clusterTransitionAbandoned`用。移動意図の
   * `PendingClusterTransition.primaryReason`のスナップショット。
   */
  transitionPrimaryReason?: ClusterTransitionPrimaryReason;
  /** Issue #201: `clusterTransitionTargetInvalidated`用。無効化理由(優先順位に従い1つだけ) */
  invalidationReason?: ClusterTransitionInvalidationReason;
  /** Issue #230: `contentUtteranceGenerated`/`contentUtteranceSkipped`用。発話が起きた(起きなかった)cluster ID。既存`groupId`と同じ意味だがcluster文脈であることを明示するため別名で持つ */
  clusterId?: string;
  /** Issue #230: `contentUtteranceGenerated`用。選ばれたtopic ID */
  topicId?: string;
  /** Issue #230: `contentUtteranceGenerated`用。選ばれたcanonical claim ID */
  claimId?: string;
  /** Issue #230: `contentUtteranceGenerated`用。実際に話されたvariant ID(発話者が現在保持しているものそのまま) */
  variantId?: string;
  /** Issue #230: `contentUtteranceGenerated`用。話者からみたこの発話の分類(originalShare/knownClaimShare/retelling) */
  contentUtteranceReason?: ContentUtteranceReason;
  /** Issue #230: `contentUtteranceGenerated`用。cluster topic runtime上でこの発話が持つ意味(新規開始/切替/継続) */
  topicTransition?: "started" | "changed" | "continued";
  /** Issue #230: `contentUtteranceSkipped`用。発話が起きなかった理由の構造化コード */
  contentUtteranceSkipReason?: "noEligibleSpeaker" | "noEligibleClaim";
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
   * Issue #189 (Phase 2): `formationScenarioId`が`standingParty`の場合に使われる、会話満足度・
   * クラスタ離脱判定・社交的回遊傾向分布の上書き。`formationScenarioId`/`formationDeadlineTick`と
   * 同じfall backパターン(呼び出し側が引き継ぎ忘れても直前の設定を維持する)で扱う。
   * `standingParty`以外では無視され、未指定時は`DEFAULT_STANDING_PARTY_SCENARIO_CONFIG`
   * (`standingPartyScenarioConfig.ts`)が使われる。
   */
  standingPartyConfig?: StandingPartyScenarioConfig;
  /**
   * Issue #175: 意味論的な自然終了(semantic finish)を持たないシナリオ(`standingParty`)向けに、
   * バッチ実行・テスト・Monte Carlo等の非対話実行が有限tickで必ず停止できるようにする観測期間の
   * 上限tick(observation horizon)。`formationPolicy.finishReason`が一度も自然終了を返さないまま
   * このtickに到達すると、`stepSimulation`は`finished: true`・`finishReason:
   * "observationHorizonReached"`として終了する(`FormationPolicy`が既に自然終了を返している場合は
   * そちらを優先する)。`formationDeadlineTick`と同じfall backパターン(呼び出し側が引き継ぎ忘れても
   * 直前の設定を維持する)で扱う。未指定(既存の対話的UI実行を含む)では上限自体が存在せず、
   * 手動のpause/resume/resetのみで実行を制御する(意味論的な自然終了を持つ`afterParty`/
   * `classroomPair`では通常到達しない安全網としても働く)。
   */
  observationHorizonTick?: number;
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
  /**
   * Issue #229 (Phase 5, roadmap #172): agentごとのtopic/claim情報状態(`informationState.ts`)。
   * catalog(Topic/Claim定義)自体はここへ持たず、`standingPartyConfig.informationPropagation`
   * (run/scenario config)側に置く ―― これはmutableなagent stateだけを持つ(§2.4/§2.6の境界)。
   * `createInitialState`は`informationPropagation.enabled`が真の場合だけ
   * `createInitialInformationRuntimeState`で初期配置を生成し、`stepSimulation`は#230以降が
   * 発話・受信・採用・記憶更新を実装するまでは単純に前tickの値をそのまま引き継ぐ(このIssueでは
   * 状態遷移そのものを実装しない)。無効時・未指定時(既存stateの読み込み等)はundefinedのまま。
   */
  informationRuntime?: InformationRuntimeState;
  /**
   * Issue #230 (Phase 5): confirmed clusterごとの会話topic runtime state(`conversationTopic.ts`)。
   * `informationRuntime`と同じ境界: `standingPartyConfig.informationPropagation.enabled`が真の場合だけ
   * `engine.ts`が更新し、無効時・standingParty以外では常にundefinedのまま(既存挙動に一切影響しない)。
   * cluster解散・membership喪失後は対応するentryを破棄する(`pruneClusterTopicRuntimeState`)。
   */
  clusterTopicRuntime?: ClusterTopicRuntimeState;
  /**
   * Issue #230 (Phase 5): 生成された内容発話(`ContentUtteranceEvent`)の時系列蓄積ログ。
   * `speechLog`と同じ「後から取り除かない、蓄積するだけ」の方針。各要素は`speechEventId`で
   * `speechLog`中の対応する`SpeechEvent`(intent: "shareInformation")と1:1に対応する。
   * 受け手の採用・記憶更新(#231以降)はこのログを起点にするが、このIssue自体はここへ書き込むだけで
   * 読み取り側の状態遷移は実装しない。
   */
  contentUtteranceLog?: ContentUtteranceEvent[];
  /**
   * Issue #231 (Phase 5): 受け手別の受信(heard/comprehension)の時系列蓄積ログ。`informationRuntime`
   * と同じ境界(informationPropagation.enabled === falseの間は常にundefined)。
   */
  informationReceptionLog?: InformationReceptionEvent[];
  /**
   * Issue #231 (Phase 5): receiver × claim × tickにつき1件のadoption decisionの時系列蓄積ログ。
   * rejected/uncertain/alreadyKnownも含む(受入条件: 採用しなかった記録も欠落させない)。
   */
  informationAdoptionLog?: InformationAdoptionEvent[];
  /**
   * Issue #231 (Phase 5): awareness/memoryStrength/source traceが実際に更新された時系列蓄積ログ。
   * scheduled forget(reason: "forgotten")もここに含まれる。
   */
  informationMemoryUpdateLog?: InformationMemoryUpdateEvent[];
  /**
   * Issue #232 (Phase 5): このrunで生成された(canonical catalogのfixtureにない)`ClaimVariant`の蓄積。
   * 静的fixture catalog(`standingPartyConfig.informationPropagation.claimCatalog`)は不変のまま、
   * `engine.ts`が毎tick`mergeGeneratedVariants`でこれをmergeしてから`contentUtterance.ts`/`retelling.ts`
   * へ渡す。`informationRuntime`と同じ境界(disabled/standingParty以外では常にundefined)。
   * 古いvariantを削除・つなぎ替えることはない(§6.3受入条件)。
   */
  generatedClaimVariants?: ClaimVariant[];
  /**
   * Issue #232 (Phase 5): 同一cluster内で同一variantが語られた累計回数(`retelling.ts`の
   * `sameClusterVariantRepeatLimit`判定に使う)。`clusterTopicRuntime`と同じ境界・寿命。
   */
  retellingRuntime?: RetellingRuntimeState;
  /**
   * Issue #232 (Phase 5): retelling decisionの結果(faithful/mutated/variantReused/blockedByLimit)の
   * 時系列蓄積ログ。`contentUtteranceLog`と同じ「後から取り除かない」方針。
   */
  retellingLog?: RetellingEvent[];
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
  /**
   * Issue #178: `currentGroupId`が指す候補の現在の状態。standingPartyでは合流後もこの値が
   * "confirmed"のまま変動人数で維持され続けるため、Inspectorで「成立して固定されたグループ」に
   * 見せないための材料として使う(nearestGroupStatusは最寄りの合流可能候補のものであり、
   * 必ずしも現在の所属先と同一とは限らないため別フィールドとして持たせる)。
   */
  currentGroupStatus?: GroupCandidateStatus;
  /** Issue #178: `currentGroupId`が指す候補の現在member数 */
  currentGroupMemberCount?: number;
  /**
   * Issue #178: `currentGroupId`が指す候補が、成立最小人数へ実際に到達したことがあるか
   * (`GroupCandidate.everConfirmed`)。standingParty以外・未所属時はundefined。
   */
  currentGroupEverConfirmed?: boolean;
  /** Issue #178: `currentGroupId`が指す候補の成立最小人数(`FormationPolicy.resolveGroupCapacity`) */
  currentGroupMinSize?: number;
  /**
   * Issue #178 (責務9): 現在`joined`の輪へ合流したtick(`Agent.clusterJoinedAtTick`)。
   * 未所属、またはそもそも一度も合流していない場合はundefined。
   */
  clusterJoinedAtTick?: number;
  /** Issue #178: `clusterJoinedAtTick`からの経過tick数(=現在の輪での滞在tick)。未所属ならundefined */
  ticksInCurrentCluster?: number;
  /** Issue #186 (Phase 2): 現在の会話エピソードID(`Agent.currentEpisode.episodeId`)。未所属ならundefined */
  episodeId?: string;
  /**
   * Issue #186 (Phase 2): 現在の会話満足度(`Agent.currentEpisode.conversationSatisfaction`)。
   * 満足度の更新式はPhase 2の対象外のため、実装が入るまでは常にundefined(ダミー値は返さない)。
   */
  conversationSatisfaction?: number;
  /**
   * Issue #178 (責務9): 直前に(会場退出ではなく)輪自体を離脱した候補ID(`Agent.lastDepartedClusterId`)。
   * standingParty以外では常にundefined(受入条件: 既存シナリオへ暫定離脱ルール由来の表示が混入しない)。
   */
  lastDepartedClusterId?: string;
  /** Issue #178: `lastDepartedClusterId`が記録されたtick */
  lastDepartedClusterAtTick?: number;
  /** Issue #178: 合流→離脱→再探索の累計回数(`Agent.clusterDepartureCount`、未発生なら0) */
  clusterDepartureCount: number;
  /**
   * Issue #189 (Phase 2): 社交的回遊傾向(`Agent.socialCirculationTendency`)。standingParty以外でも
   * 値自体は存在するが(`createInitialAgents`が全agentに生成するため)、標準の観察対象は
   * standingPartyのみ(受入条件: Phase 2で他シナリオへの表示混入を作らない、はUI側で担保する)。
   */
  socialCirculationTendency?: number;
  /**
   * Issue #189 (Phase 2): 現在tickの離脱判定要因(`clusterDepartureDecision.ts`と同じ計算式を、
   * `state.standingPartyConfig`の設定でInspectorから再現した結果)。`joined`かつstandingPartyの
   * agentでのみ意味を持つ。まだ最低滞在tickに達していない場合は`eligible: false`(要件:
   * 「まだ離脱判定前」を0で捏造しない)。
   */
  departureDecisionEligible?: boolean;
  /** Issue #189: `departureDecisionEligible`な場合の現在の離脱確率 */
  departureDecisionProbability?: number;
  /** Issue #189: 現在の離脱確率の寄与内訳(寄与が正のものだけ、contribution降順) */
  departureDecisionFactors?: ClusterDepartureFactor[];
  /** Issue #189: 現在最も寄与の大きい離脱要因 */
  departureDecisionPrimaryReason?: ClusterDeparturePrimaryReason;
  /**
   * Issue #200 (Phase 3): 現在tickのクラスタ遷移decision(`clusterTransitionDecision.ts`と同じ計算式を
   * Inspectorから再現した結果)。`standingPartyConfig.transition.enabled`が`false`の場合、
   * standingParty以外、または`joined`していない場合は全てundefined。
   */
  transitionEligible?: boolean;
  /** Issue #200: 現在tickの3action確率(合計は常に1) */
  transitionActionProbabilities?: Record<ClusterTransitionAction, number>;
  /** Issue #200: `switchToTargetCluster`確率が0より大きい場合の目的地クラスタID */
  transitionSelectedTargetClusterId?: string;
  /** Issue #200: 上記の目的地関心を主に駆動したmember */
  transitionFocusAgentId?: string;
  /** Issue #200: 決定時点の最良他クラスタ関心score`[0,1]` */
  transitionAlternativeInterestScore?: number;
  /** Issue #200: 決定時点の現在クラスタ愛着`[0,1]` */
  transitionAttachmentValue?: number;
  /** Issue #200: 決定時点の構造的配慮の合計`[0,1]` */
  transitionDepartureConcern?: number;
  /** Issue #200: 観察専用の葛藤強度`[0,1]`(ADR 1.4節) */
  transitionConflictIntensity?: number;
  /** Issue #200: 現在の主要因(Phase 2の3値、Phase 3の関心/抑制由来の値のいずれか) */
  transitionPrimaryReason?: ClusterTransitionPrimaryReason;
  /**
   * Issue #189 (Phase 2): `lastDepartedClusterId`が記録された直近の輪離脱が、自発的離脱
   * (`clusterDepartureCompleted`)によるものか、クラスタ解散によるrelease(`clusterMemberReleased`)
   * によるものかの区別(要件: 自発的離脱とcluster解散によるreleaseを表示上区別する)。
   * `lastDepartedClusterId`が未設定なら常にundefined。
   */
  lastClusterExitKind?: "voluntaryDeparture" | "memberReleased";
  /** Issue #189: `lastClusterExitKind`が"voluntaryDeparture"の場合の主要因。releaseの場合はundefined */
  lastClusterExitReason?: ClusterTransitionPrimaryReason;
  /** Issue #135: `approachTargetInvalidated`/`joinFailedCapacity`の発生回数 */
  joinFailureCount: number;
  /** Issue #135: 最新の参加失敗理由と発生tick。未発生ならundefined */
  lastFailureReason?: ApproachFailureReason;
  lastFailureTick?: number;
  /**
   * Issue #202 (Phase 3): 現在保持している移動意図(`Agent.pendingClusterTransition`)のスナップショット。
   * 意図を持っていない場合は常にundefined(0やダミー値で「意図なし」を捏造しない)。
   */
  pendingTransition?: ObserverPendingTransitionSnapshot;
  /**
   * Issue #202 (Phase 3): 直近で移動意図が無効化された理由(`clusterTransitionTargetInvalidated`)と、
   * 通常の再探索へfallbackしたか(直後の`clusterTransitionAbandoned`の有無)。無効化が一度も
   * 発生していない場合、または現在別のpending transitionを新たに保持している場合はundefined。
   */
  lastTransitionInvalidation?: ObserverTransitionInvalidationSnapshot;
};

/** Issue #202 (Phase 3): `ObserverJoinerInspection.pendingTransition`の内訳 */
export type ObserverPendingTransitionSnapshot = {
  sourceClusterId: string;
  targetClusterId: string;
  /** 関心を主に駆動したmember。距離・入りやすさだけで選ばれた場合はundefined */
  focusAgentId?: string;
  decidedAtTick: number;
  expiresAtTick: number;
  /** 現tick時点での経過tick数(`state.tick - decidedAtTick`) */
  elapsedTicks: number;
  /** 決定時点の他クラスタ関心score`[0,1]`(以後再評価しない) */
  interestScore: number;
  primaryReason: ClusterTransitionPrimaryReason;
};

/** Issue #202 (Phase 3): `ObserverJoinerInspection.lastTransitionInvalidation`の内訳 */
export type ObserverTransitionInvalidationSnapshot = {
  reason: ClusterTransitionInvalidationReason;
  tick: number;
  /** 無効化直後、通常の再探索(`clusterTransitionAbandoned`)へ切り替わったか */
  fallbackStarted: boolean;
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

/**
 * Issue #190: standingParty専用の比較指標(agentあたりの自発cluster離脱・再参加・異なるcluster参加数)。
 * `standingPartyComparison.ts`の`buildStandingPartyRunSummary`が`state.log`の構造化イベント
 * (`eventType`/`metadata`)と`state.agents`のみから導出する(表示用`message`文言は参照しない)。
 * afterParty/classroomPairのrunに対して呼び出しても該当イベントが一切発生しないため、
 * 全フィールドが0/空になる(既存挙動への影響なし、`standingPartyDynamicCycle.test.ts`が
 * 立証済みの「他シナリオへclusterDeparture系イベントが混入しない」という前提に乗る)。
 */
export type StandingPartyAgentMetric = {
  agentId: string;
  label: string;
  finalState: AgentState;
  /** 責務9による自発的なcluster離脱回数(`clusterDepartureCompleted`)。責務10の強制releaseは含まない */
  voluntaryDepartureCount: number;
  /**
   * 責務10によるクラスタ解散に伴う強制release回数(`clusterMemberReleased`)。issue #190 6節
   * 「cluster解散による強制releaseを自発的回遊として集計しない」の要求どおり、
   * `voluntaryDepartureCount`とは別フィールドに分離する。
   */
  forcedReleaseCount: number;
  /** 離脱後に別/同じclusterへ再参加した回数(`clusterRejoined`) */
  rejoinCount: number;
  /** このrunでこのagentが所属した、重複を除くcluster数(核形成/合流/再参加のいずれも含む) */
  distinctClusterCount: number;
};

/** 完了(voluntary/forced問わず)した1つの会話エピソードの滞在tickサンプル */
export type StandingPartyEpisodeDwellSample = {
  agentId: string;
  clusterId: string;
  ticksInCluster: number;
  endReason: "voluntaryDeparture" | "memberReleased";
  /** `endReason === "voluntaryDeparture"`の場合のみ定義される主要因 */
  primaryReason?: ClusterDeparturePrimaryReason;
};

/** `ClusterDeparturePrimaryReason`別の発生件数(自発離脱`clusterDepartureCompleted`のみを対象とする) */
export type StandingPartyDepartureReasonCounts = Record<ClusterDeparturePrimaryReason, number>;

/**
 * Issue #190: standingPartyの単発run分の比較指標サマリー。既存の`SimulationSummary`/
 * `PairFormationRunSummary`とは独立した集計軸で、issue #190 5節(プリセット間の定性的比較)の
 * 最低限の集計項目(自発離脱回数・再参加回数・異なるcluster参加数・完了episodeの滞在tick・
 * cluster解散回数・会場退出人数・離脱理由別件数)をカバーする。
 */
export type StandingPartyRunSummary = {
  agentMetrics: StandingPartyAgentMetric[];
  totalVoluntaryDepartureCount: number;
  totalForcedReleaseCount: number;
  totalRejoinCount: number;
  averageDistinctClusterCountPerAgent: number;
  /** 完了した会話エピソードそれぞれの滞在tick(voluntary/forced両方を含む) */
  episodeDwellSamples: StandingPartyEpisodeDwellSample[];
  /** `episodeDwellSamples`の平均滞在tick。1件もなければundefined */
  meanCompletedEpisodeDwellTicks?: number;
  /** `episodeDwellSamples`の中央値滞在tick。1件もなければundefined */
  medianCompletedEpisodeDwellTicks?: number;
  /** このrunで解散(`activeClusterDissolved`)に至った、重複を除くcluster数 */
  clusterDissolutionCount: number;
  /** run終了時点で会場を退出("left")した人数 */
  venueExitCount: number;
  /** 自発離脱(`clusterDepartureCompleted`)の主要因別件数 */
  departureReasonCounts: StandingPartyDepartureReasonCounts;
};

/** 複数run分のstandingParty比較指標集計値(issue #190 5節: 固定seed列でのpaired比較用) */
export type StandingPartyMonteCarloSummary = {
  runs: number;
  averageVoluntaryDepartureCountPerAgent: number;
  averageForcedReleaseCountPerAgent: number;
  averageRejoinCountPerAgent: number;
  averageDistinctClusterCountPerAgent: number;
  /** run毎の`meanCompletedEpisodeDwellTicks`(定義済みのrunのみ)の平均。対象runが1件もなければundefined */
  averageMeanCompletedEpisodeDwellTicks?: number;
  /** run毎の`medianCompletedEpisodeDwellTicks`(定義済みのrunのみ)の平均。対象runが1件もなければundefined */
  averageMedianCompletedEpisodeDwellTicks?: number;
  averageClusterDissolutionCount: number;
  averageVenueExitCount: number;
  /** 主要因別の1runあたり平均件数 */
  departureReasonRateAverages: StandingPartyDepartureReasonCounts;
};

/**
 * Issue #212 (standing-party Phase 4 分析): 会話履歴 read model の schema version。
 * Roadmap #61 の Phase 4(`socialExpression`等)とは無関係。
 * `docs/standing-party-analysis-phase4-model.md` §6.2。
 */
export const STANDING_PARTY_ANALYSIS_SCHEMA_VERSION = 1 as const;

/** 完了分布に混ぜないための区間状態(`docs/standing-party-analysis-phase4-model.md` §1冒頭・§4.3) */
export type AnalysisIntervalStatus = "active" | "completed" | "censored";

/**
 * Issue #212: 履歴レコード上のepisode終了理由。既存3値に加え、分析層で区別する拡張値を含む。
 * イベントmetadataの`episodeEndReason`は従来どおり`ConversationEpisodeEndReason`のまま
 * (`targetedTransition`は`voluntaryDeparture`+`transitionAction`から導出する)。
 */
export type ConversationEpisodeEndReasonV2 =
  | ConversationEpisodeEndReason
  | "targetedTransition"
  | "venueExit"
  | "reset";

/** Issue #212: 1agentの1回のjoined〜episode終了を表す正規履歴レコード */
export type ConversationEpisodeRecord = {
  episodeId: string;
  agentId: string;
  clusterId: string;
  startedAtTick: number;
  endedAtTick?: number;
  /** endedAtTick定義時は endedAtTick - startedAtTick。active/censoredは asOfTick - startedAtTick */
  dwellTicks: number;
  status: AnalysisIntervalStatus;
  endReason?: ConversationEpisodeEndReasonV2;
  joinedGroupStatus: GroupCandidateStatus;
  startMemberIds: string[];
  endMemberIds?: string[];
};

/**
 * Issue #212: cluster membership区間。standingPartyではepisodeと1:1で、同じ`episodeId`を共有する
 * (`docs/standing-party-analysis-phase4-model.md` §1.2)。
 */
export type ClusterMembershipInterval = {
  intervalId: string;
  agentId: string;
  clusterId: string;
  startedAtTick: number;
  endedAtTick?: number;
  status: AnalysisIntervalStatus;
  episodeId: string;
};

export type ClusterLifetimeEndReason =
  | "activeClusterDissolved"
  | "groupDissolved"
  | "groupExpired"
  | "cleanedUp";

/** Issue #212: 1つのGroupCandidateの生成〜解散/期限切れ/cleanupまでのlifetime */
export type ClusterLifetimeRecord = {
  clusterId: string;
  founderAgentId?: string;
  createdAtTick: number;
  confirmedAtTick?: number;
  dissolvingAtTick?: number;
  endedAtTick?: number;
  status: AnalysisIntervalStatus;
  endReason?: ClusterLifetimeEndReason;
  peakMemberCount: number;
  joinCount: number;
  voluntaryLeaveCount: number;
  forcedReleaseCount: number;
};

export type ClusterTransitionResult = "completed" | "invalidated" | "abandoned" | "explore";

/** Issue #212: 目的地付き移動または目的地なし再探索の1過程 */
export type ClusterTransitionRecord = {
  transitionId: string;
  agentId: string;
  sourceClusterId: string;
  targetClusterId?: string;
  focusAgentId?: string;
  startedAtTick: number;
  endedAtTick?: number;
  result?: ClusterTransitionResult;
  invalidationReason?: ClusterTransitionInvalidationReason;
  sourceEpisodeId?: string;
  targetEpisodeId?: string;
  /** endedAtTick定義時は endedAtTick - startedAtTick */
  elapsedTicks?: number;
};

export type StandingPartyAnalysisDiagnosticCode =
  | "duplicateEpisodeStart"
  | "episodeCloseWithoutOpen"
  | "transitionCloseWithoutOpen"
  | "overlappingMembership"
  | "membershipStateMismatch"
  /** Issue #213: 同一agentが同一tickで複数clusterに同時所属している不正状態 */
  | "overlappingMultiClusterMembership";

/** Issue #212: イベント欠落・不正順序を黙って補正せず検出するための診断 */
export type StandingPartyAnalysisDiagnostic = {
  code: StandingPartyAnalysisDiagnosticCode;
  tick: number;
  agentId?: string;
  clusterId?: string;
  episodeId?: string;
  transitionId?: string;
  detail?: string;
};

/**
 * Issue #212: 会話参加・離脱・クラスタ遷移の統合履歴スナップショット。
 * contact / network は #213、統計は #214 の範囲(本型には含めない)。
 */
export type StandingPartyConversationHistory = {
  schemaVersion: typeof STANDING_PARTY_ANALYSIS_SCHEMA_VERSION;
  asOfTick: number;
  episodes: ConversationEpisodeRecord[];
  membershipIntervals: ClusterMembershipInterval[];
  clusterLifetimes: ClusterLifetimeRecord[];
  transitions: ClusterTransitionRecord[];
  diagnostics: StandingPartyAnalysisDiagnostic[];
};

/**
 * Issue #213: 2agentが同一clusterに同時`joined`所属していた連続期間。
 * IDは `` `${minId}:${maxId}:${clusterId}:${startTick}` `` (ADR §1.5 / §6.1)。
 * 区間は半開`[startedAtTick, endedAtTick)`。active/censoredは`endedAtTick`未定義。
 */
export type ContactIntervalRecord = {
  contactIntervalId: string;
  agentIdA: string;
  agentIdB: string;
  clusterId: string;
  startedAtTick: number;
  endedAtTick?: number;
  status: AnalysisIntervalStatus;
  /** endedAtTick定義時は endedAtTick - startedAtTick。active/censoredは asOfTick - startedAtTick */
  dwellTicks: number;
};

/**
 * Issue #213: 2agent間に1つ以上のcontact intervalがあるとき張る無向辺。
 * edgeKeyは `` `${minId}:${maxId}` ``。weightは同席tick等の観測事実のみで、
 * clique / trust / relationshipTie を混ぜない(ADR §3)。
 */
export type ContactNetworkEdge = {
  edgeKey: string;
  agentIdA: string;
  agentIdB: string;
  totalCoPresenceTicks: number;
  contactIntervalCount: number;
  distinctClusterCount: number;
  firstContactTick: number;
  lastContactTick: number;
  isActive: boolean;
};

/**
 * Issue #213: contact networkのnode。比較表示用のclique等は`comparisonAttributes`に分離し、
 * edge weightへ暗黙に混ぜない。
 */
export type ContactNetworkNode = {
  agentId: string;
  label: string;
  isObserverJoiner: boolean;
  currentState: AgentState;
  currentClusterId?: string;
  /** 異なる接触相手数 */
  degree: number;
  /** 総接触tick(全edgeのtotalCoPresenceTicks合計) */
  weightedDegree: number;
  activeContactCount: number;
  episodeCount: number;
  /**
   * 表示比較用。contactの有無・weightとは独立。
   * trust / relationshipTieはpair単位のため本nodeには載せず、呼び出し側が別ログと照合する。
   */
  comparisonAttributes?: {
    cliqueId?: number;
  };
};

/** Issue #213: Phase 4で必要な記述指標に限定したnetwork指標(中心性の高度分析は対象外) */
export type ContactNetworkMetrics = {
  nodeCount: number;
  edgeCount: number;
  /** `2|E| / (n(n-1))`。n < 2 のとき 0 */
  density: number;
  isolatedNodeCount: number;
  connectedComponentCount: number;
};

/**
 * Issue #213: membership区間の時間重複から導出した接触ネットワークsnapshot。
 * 入力の履歴・SimulationStateをmutationしない。
 */
export type StandingPartyContactNetwork = {
  schemaVersion: typeof STANDING_PARTY_ANALYSIS_SCHEMA_VERSION;
  asOfTick: number;
  fromTick: number;
  toTick: number;
  contactIntervals: ContactIntervalRecord[];
  edges: ContactNetworkEdge[];
  nodes: ContactNetworkNode[];
  metrics: ContactNetworkMetrics;
  diagnostics: StandingPartyAnalysisDiagnostic[];
};

/**
 * Issue #214: 数値列の記述統計。emptyは0で捏造せず、分位点・mean等を`undefined`にする。
 * `docs/standing-party-analysis-phase4-model.md` §4。
 */
export type DistributionSummary = {
  count: number;
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  p10?: number;
  p25?: number;
  p75?: number;
  p90?: number;
  sum?: number;
};

/**
 * Issue #214: 成功率など分母0を明示する比率。`rate`は`denominator === 0`のとき`undefined`。
 */
export type RateWithDenominator = {
  numerator: number;
  denominator: number;
  rate?: number;
};

/**
 * Issue #214: 統計集計のfilter。元履歴をmutationせず、窓clip / 部分集合で再集計する。
 * 半開区間`[fromTick, toTick)`。省略時は run 全体(`[0, asOfTick)`)。
 */
export type StandingPartyStatisticsFilter = {
  fromTick?: number;
  toTick?: number;
  agentIds?: readonly string[];
  clusterIds?: readonly string[];
  /** ObserverJoinerのみ / 除外 / 全員(default) */
  observerJoinerMode?: "only" | "exclude" | "all";
  /** episode終了理由で絞る(完了episodeのみ対象。activeは`includeActive`側) */
  endReasons?: readonly ConversationEpisodeEndReasonV2[];
  /** transition結果で絞る */
  transitionResults?: readonly ClusterTransitionResult[];
  /**
   * active / censored 区間を件数・系列に含めるか。default true。
   * 完了分布(`completedDwell`等)には常に混ぜない。
   */
  includeActive?: boolean;
};

/** Issue #214: agent粒度の記述統計 */
export type StandingPartyAgentStatistics = {
  agentId: string;
  label: string;
  isObserverJoiner: boolean;
  finalState: AgentState;
  startedEpisodeCount: number;
  completedEpisodeCount: number;
  activeEpisodeCount: number;
  /** 完了episodeの滞在tick分布。0件ならempty summary */
  completedDwellTicks: DistributionSummary;
  /** 現在openなepisodeの滞在tick合計(複数あっても通常0〜1)。無ければundefined */
  currentEpisodeDwellTicks?: number;
  distinctContactCount: number;
  contactIntervalCount: number;
  totalContactTicks: number;
  joinedClusterCount: number;
  distinctClusterCount: number;
  voluntaryDepartureCount: number;
  forcedReleaseCount: number;
  departAndExploreCount: number;
  targetedTransitionStartedCount: number;
  targetedTransitionSuccessCount: number;
  targetedTransitionFailureCount: number;
  targetedTransitionFallbackCount: number;
  /** success / (success + failure)。分母0はrate undefined */
  targetedTransitionSuccessRate: RateWithDenominator;
  /** 愛着由来のstay記録(`clusterTransitionInhibited` + stayedByAttachment) */
  stayedByAttachmentCount: number;
  /** 配慮由来のstay記録(stayedByDepartureConcern) */
  stayedByDepartureConcernCount: number;
  /** 混合抑制のstay記録(stayedByMixedInhibition) */
  stayedByMixedInhibitionCount: number;
  /** 会場退出tick。構造化イベントで確定できる場合のみ(主にobserverLeft) */
  venueExitTick?: number;
  /** 観測時点で`state === "left"`ならtrue */
  hasExitedVenue: boolean;
};

/** Issue #214: cluster粒度の記述統計。turnover = (vol+forced) / max(join, 1) */
export type StandingPartyClusterStatistics = {
  clusterId: string;
  founderAgentId?: string;
  createdAtTick: number;
  confirmedAtTick?: number;
  endedAtTick?: number;
  status: AnalysisIntervalStatus;
  endReason?: ClusterLifetimeEndReason;
  /** completedなら ended - created。active/censoredは asOf - created */
  lifetimeTicks: number;
  /** confirmed〜終了(またはasOf)の長さ。未confirmならundefined */
  activeDurationTicks?: number;
  peakMemberCount: number;
  /**
   * lifetime窓でのjoined member数の区間加重平均(=毎tick snapshot平均)。
   * Σ(membership重複tick) / lifetimeTicks。lifetimeTicks===0ならundefined。
   */
  meanMemberCount?: number;
  /** 終了時点(またはasOf)のjoined member数 */
  finalMemberCount: number;
  uniqueMemberCount: number;
  joinCount: number;
  voluntaryLeaveCount: number;
  forcedReleaseCount: number;
  turnoverRate: number;
  targetedTransitionInflowCount: number;
  targetedTransitionOutflowCount: number;
};

/** Issue #214: run全体の記述統計・分布・network概要 */
export type StandingPartyRunLevelStatistics = {
  populationSize: number;
  observationFromTick: number;
  observationToTick: number;
  asOfTick: number;
  completedEpisodeDwellTicks: DistributionSummary;
  activeEpisodeCount: number;
  completedEpisodeCount: number;
  agentDistinctContactCounts: DistributionSummary;
  pairContactDurationTicks: DistributionSummary;
  completedClusterLifetimeTicks: DistributionSummary;
  completedClusterPeakSizes: DistributionSummary;
  clusterCreatedCount: number;
  clusterEndedCount: number;
  /** 観測終点でのactive cluster数 */
  activeClusterCountAtAsOf: number;
  network: ContactNetworkMetrics;
  /**
   * density分母に使うnode数。ADR推奨どおりrun開始時populationを固定分母とする
   * (`network.density`は接触に現れたnode集合ベースのまま別途保持)。
   */
  networkDensityVsPopulation: RateWithDenominator;
  voluntaryDepartureCount: number;
  forcedReleaseCount: number;
  voluntaryDepartureShare: RateWithDenominator;
  targetedTransitionSuccessCount: number;
  targetedTransitionFailureCount: number;
  targetedTransitionFailureByReason: Partial<Record<ClusterTransitionInvalidationReason, number>>;
  targetedTransitionSuccessRate: RateWithDenominator;
  venueExitCount: number;
  activeEpisodeCountAtAsOf: number;
  activeContactIntervalCountAtAsOf: number;
};

/** Issue #214: ObserverJoiner個人と非OJ集団の記述比較(優劣・因果は主張しない) */
export type StandingPartyObserverJoinerComparison = {
  /** ObserverJoiner本人(複数将来拡張のため配列)。0人なら空 */
  observerJoiners: StandingPartyAgentStatistics[];
  /** 非ObserverJoiner集団の代表値(同じ定義・分母) */
  nonObserverJoinerGroup: {
    agentCount: number;
    episodeCount: DistributionSummary;
    completedDwellTicks: DistributionSummary;
    distinctContactCount: DistributionSummary;
    targetedTransitionStartedCount: DistributionSummary;
    targetedTransitionSuccessRate: RateWithDenominator;
    stayedByAttachmentCount: DistributionSummary;
    stayedByDepartureConcernCount: DistributionSummary;
    venueExitCount: number;
    venueExitRate: RateWithDenominator;
  };
};

/** Issue #214: UI向け時系列の1サンプル */
export type StandingPartyTimeSeriesPoint = {
  tick: number;
  activeClusterCount: number;
  joinedCount: number;
  undecidedCount: number;
  approachingCount: number;
  formingCount: number;
  leavingCount: number;
  leftCount: number;
  activeContactEdgeCount: number;
  cumulativeUniqueContactEdgeCount: number;
  cumulativeCompletedEpisodeCount: number;
  cumulativeTargetedTransitionSuccessCount: number;
  cumulativeTargetedTransitionFailureCount: number;
};

/** Issue #214: サンプリング済み時系列。最終tickは必ず含む */
export type StandingPartyTimeSeries = {
  schemaVersion: typeof STANDING_PARTY_ANALYSIS_SCHEMA_VERSION;
  fromTick: number;
  toTick: number;
  sampleIntervalTicks: number;
  points: StandingPartyTimeSeriesPoint[];
};

/**
 * Issue #214: standing-party Phase 4 統計集計のversioned snapshot。
 * `StandingPartyRunSummary`(#190)は維持し、本型は横に載せる薄い層。
 */
export type StandingPartyRunStatistics = {
  schemaVersion: typeof STANDING_PARTY_ANALYSIS_SCHEMA_VERSION;
  asOfTick: number;
  fromTick: number;
  toTick: number;
  filter: StandingPartyStatisticsFilter;
  agents: StandingPartyAgentStatistics[];
  clusters: StandingPartyClusterStatistics[];
  run: StandingPartyRunLevelStatistics;
  observerJoinerComparison: StandingPartyObserverJoinerComparison;
  series: StandingPartyTimeSeries;
};
