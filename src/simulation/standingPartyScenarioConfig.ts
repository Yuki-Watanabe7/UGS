/**
 * Issue #189 (Phase 2): #185〜#188がstandingParty専用のscenario configとして`engine.ts`/
 * `formationPolicy.ts`へ直接埋め込んだ`ConversationSatisfactionConfig`/`ClusterDepartureDecisionConfig`と、
 * `model.ts`の社交的回遊傾向(`Agent.socialCirculationTendency`)分布を、1つの実行時設定として束ね、
 * `FormationRuntimeOptions.standingPartyConfig`経由でUI/プリセットから安全に差し替えられるようにする。
 *
 * `SimParams`へは追加しない(#185のADR 5.1節の方針を踏襲) ―― 二次会・学校のvalidation/UI/seed結果へは
 * 一切影響しない。standingParty以外のシナリオでは常に無視される。
 *
 * Issue #198 (Phase 3): `docs/cluster-transition-phase3-model.md`(Issue #197 ADR)6.1節どおり、
 * 他クラスタ関心(`AlternativeClusterInterestConfig`)をこの器へ追加する。engine.tsからはまだ
 * どこからも参照されない(ADR 9節P3-Aの区切り) ―― 追加自体はafterParty/classroomPair/既存の
 * standingParty挙動へ一切影響しない。
 *
 * Issue #199 (Phase 3, ステップP3-B): 同じ6.1節どおり、現在クラスタ愛着・離脱配慮
 * (`CurrentClusterAttachmentConfig`)をこの器へ追加する。`engine.ts`のstep 5a2で
 * `ConversationEpisode.attachment`の初期化・更新にのみ使われ、離脱確率の式へはまだ入力しない
 * (#200で結線)。
 */
import {
  DEFAULT_CONVERSATION_SATISFACTION_CONFIG,
  validateConversationSatisfactionConfig,
  type ConversationSatisfactionConfig,
} from "./conversationSatisfaction";
import {
  DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG,
  validateClusterDepartureDecisionConfig,
  type ClusterDepartureDecisionConfig,
} from "./clusterDepartureDecision";
import {
  DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG,
  validateAlternativeClusterInterestConfig,
  type AlternativeClusterInterestConfig,
} from "./alternativeClusterInterest";
import {
  DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG,
  validateCurrentClusterAttachmentConfig,
  type CurrentClusterAttachmentConfig,
} from "./currentClusterAttachment";
import {
  DEFAULT_CLUSTER_TRANSITION_CONFIG,
  validateClusterTransitionConfig,
  type ClusterTransitionConfig,
} from "./clusterTransitionDecision";
import {
  DEFAULT_INFORMATION_PROPAGATION_CONFIG,
  validateInformationPropagationConfig,
  type InformationPropagationConfig,
} from "./informationState";

/** 社交的回遊傾向(`Agent.socialCirculationTendency`)を一様分布で生成する範囲 `[0,1]` */
export type SocialCirculationTendencyRange = {
  min: number;
  max: number;
};

export type StandingPartyScenarioConfig = {
  conversationSatisfaction: ConversationSatisfactionConfig;
  clusterDeparture: ClusterDepartureDecisionConfig;
  circulationTendencyRange: SocialCirculationTendencyRange;
  /** Issue #198 (Phase 3): 他クラスタ関心。engine.tsからはまだ参照されない(観察専用の純粋関数群) */
  alternativeInterest: AlternativeClusterInterestConfig;
  /** Issue #199 (Phase 3): 現在クラスタ愛着・離脱配慮。engine.tsのstep 5a2が初期化・更新にのみ使う */
  attachment: CurrentClusterAttachmentConfig;
  /**
   * Issue #200 (Phase 3): クラスタ遷移decisionの合成設定。`enabled: false`(既定)の間は
   * `evaluateClusterDeparture`がPhase 2の`computeClusterDepartureDecision`のみを返し、
   * step 5a3(他クラスタ関心の導出)も実行されない(ADR 4.3節1、後方互換の本体)。
   */
  transition: ClusterTransitionConfig;
  /**
   * Issue #229 (Phase 5): 話題・情報伝播の初期状態(Topic/Claim catalog、初期保有・関心分布、上限)。
   * `enabled: false`(既定)の間は`engine.ts`が`createInitialInformationRuntimeState`を一切呼ばず、
   * `SimulationState.informationRuntime`は常にundefinedのまま(既存Agent/state/event/PRNG系列を変えない)。
   */
  informationPropagation: InformationPropagationConfig;
};

export const DEFAULT_CIRCULATION_TENDENCY_RANGE: SocialCirculationTendencyRange = { min: 0, max: 1 };

export const DEFAULT_STANDING_PARTY_SCENARIO_CONFIG: StandingPartyScenarioConfig = {
  conversationSatisfaction: DEFAULT_CONVERSATION_SATISFACTION_CONFIG,
  clusterDeparture: DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG,
  circulationTendencyRange: DEFAULT_CIRCULATION_TENDENCY_RANGE,
  alternativeInterest: DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG,
  attachment: DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG,
  transition: DEFAULT_CLUSTER_TRANSITION_CONFIG,
  informationPropagation: DEFAULT_INFORMATION_PROPAGATION_CONFIG,
};

function assertRange01(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`standingPartyScenarioConfig: ${name} must be within [0, 1] (got ${value})`);
  }
}

/**
 * NaN/Infinity・範囲外・min>maxを明示的に拒否する(既存の`validateConversationSatisfactionConfig`/
 * `validateClusterDepartureDecisionConfig`と同じ方針)。UI側の入力検証だけに頼らず、
 * この関数がdomain layerでの最終防衛線になる。
 */
export function validateStandingPartyScenarioConfig(config: StandingPartyScenarioConfig): void {
  validateConversationSatisfactionConfig(config.conversationSatisfaction);
  validateClusterDepartureDecisionConfig(config.clusterDeparture);
  validateAlternativeClusterInterestConfig(config.alternativeInterest);
  validateCurrentClusterAttachmentConfig(config.attachment);
  validateClusterTransitionConfig(config.transition);
  validateInformationPropagationConfig(config.informationPropagation);
  assertRange01("circulationTendencyRange.min", config.circulationTendencyRange.min);
  assertRange01("circulationTendencyRange.max", config.circulationTendencyRange.max);
  if (config.circulationTendencyRange.min > config.circulationTendencyRange.max) {
    throw new Error(
      `standingPartyScenarioConfig: circulationTendencyRange.min (${config.circulationTendencyRange.min}) must be <= max (${config.circulationTendencyRange.max})`,
    );
  }
}

validateStandingPartyScenarioConfig(DEFAULT_STANDING_PARTY_SCENARIO_CONFIG);

/**
 * 比較プリセット「幅広く交流するネットワーキング型」(issue #189要件2節)。標準ケース(`DEFAULT_...`)と
 * populationSize等の`SimParams`は揃えたまま、Phase 2パラメータだけを差し替える。
 * - 回遊傾向を高いagentが多くなる範囲にする(要件: 社交的回遊傾向が高いagentが多い)。
 * - `circulationWarmupTicks`/`circulationRampTicks`を短くし`maxCirculationContribution`を上げることで、
 *   最低滞在時間経過後、満足度が高くても比較的早く・高い確率で次の輪へ移る(要件: 満足度が高くても
 *   一定確率で移動する、一つの会話への平均滞在が比較的短い)。
 * - `minStayTicks`も標準よりやや短く、異なる会話クラスタへの再参加が観察しやすい間隔にする。
 */
export const NETWORKING_STANDING_PARTY_CONFIG: StandingPartyScenarioConfig = {
  conversationSatisfaction: {
    ...DEFAULT_CONVERSATION_SATISFACTION_CONFIG,
    satisfactionDecayPerTick: 0.015,
  },
  clusterDeparture: {
    ...DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG,
    minStayTicks: 10,
    maxCirculationContribution: 0.14,
    circulationWarmupTicks: 4,
    circulationRampTicks: 10,
  },
  circulationTendencyRange: { min: 0.6, max: 1 },
  alternativeInterest: DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG,
  attachment: DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG,
  transition: DEFAULT_CLUSTER_TRANSITION_CONFIG,
  informationPropagation: DEFAULT_INFORMATION_PROPAGATION_CONFIG,
};

/**
 * 比較プリセット「少人数でじっくり話す懇親型」(issue #189要件2節)。standard-partyと同じ`SimParams`のまま、
 * - 満足度減衰を遅くする(要件: 満足度減衰が遅い)。
 * - 回遊傾向を低いagentが多くなる範囲にする(要件: 回遊傾向が低い)。
 * - `minStayTicks`を長くする(要件: 最低滞在時間が長め)。
 * - `maxCirculationContribution`を下げ`circulationWarmupTicks`/`circulationRampTicks`を伸ばすことで、
 *   回遊由来の離脱がほぼ発生しなくなり、同じクラスタが比較的長く維持される(要件)。
 */
export const INTIMATE_STANDING_PARTY_CONFIG: StandingPartyScenarioConfig = {
  conversationSatisfaction: {
    ...DEFAULT_CONVERSATION_SATISFACTION_CONFIG,
    satisfactionDecayPerTick: 0.004,
  },
  clusterDeparture: {
    ...DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG,
    minStayTicks: 26,
    maxDissatisfactionContribution: 0.05,
    maxCirculationContribution: 0.015,
    circulationWarmupTicks: 24,
    circulationRampTicks: 36,
  },
  circulationTendencyRange: { min: 0, max: 0.3 },
  alternativeInterest: DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG,
  attachment: DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG,
  transition: DEFAULT_CLUSTER_TRANSITION_CONFIG,
  informationPropagation: DEFAULT_INFORMATION_PROPAGATION_CONFIG,
};

validateStandingPartyScenarioConfig(NETWORKING_STANDING_PARTY_CONFIG);
validateStandingPartyScenarioConfig(INTIMATE_STANDING_PARTY_CONFIG);

/**
 * Issue #202 (Phase 3): 比較プリセット「交流先へ移りやすい場」。standard-partyと同じ`SimParams`/
 * Phase 2設定(会話満足度・離脱判定・回遊傾向分布)のまま、Phase 3の3configだけを差し替える
 * (要件: 比較時はPhase 2基本パラメータを可能な限り揃え、Phase 3設定差だけを観察できるようにする)。
 * - `alternativeInterest`: 観察半径・各weightを広め/高めにし、`minTargetInterestScore`を下げることで、
 *   他クラスタがtarget候補になりやすくする(要件: 観察半径または外部関心寄与が比較的高い、
 *   switch thresholdが低め)。
 * - `attachment`: 愛着の飽和値・形成速度と、解散配慮・influenceAvoidance寄与を下げることで、
 *   愛着・解散配慮による抑制が働きにくくする(要件: 愛着・解散配慮の抑制が比較的弱い)。
 *   `maxInhibition`も下げ、抑制が効いた場合の上限自体も低くする。
 * - `transition`: `enabled: true`にしてPhase 3decisionを有効化し、関心のswitch寄与と
 *   目的地ありの配分を高める(要件: 目的地付き移動が観察しやすい)。
 * 会場からの退出(`SimulationFinishReason`等)には一切触れない ―― Phase 2の離脱判定・会話満足度は
 * 標準ケースと同一のため、単に会場退出人数が増える設定にはならない(要件)。
 */
export const OUTWARD_INTEREST_STANDING_PARTY_CONFIG: StandingPartyScenarioConfig = {
  conversationSatisfaction: DEFAULT_CONVERSATION_SATISFACTION_CONFIG,
  clusterDeparture: DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG,
  circulationTendencyRange: DEFAULT_CIRCULATION_TENDENCY_RANGE,
  alternativeInterest: {
    ...DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG,
    observationRadius: 260,
    distanceWeight: 0.35,
    knownParticipantWeight: 0.3,
    cliqueCompatibilityWeight: 0.25,
    outsiderBarrierPenaltyCap: 0.12,
    capacityPressurePenaltyCap: 0.1,
    minTargetInterestScore: 0.22,
  },
  attachment: {
    ...DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG,
    attachmentGrowthPerTick: 0.006,
    maxAttachment: 0.55,
    clusterWouldDissolveConcern: 0.1,
    influenceAvoidanceGain: 0.5,
    maxInhibition: 0.35,
  },
  transition: {
    ...DEFAULT_CLUSTER_TRANSITION_CONFIG,
    enabled: true,
    interestToDepartureGain: 0.8,
    targetShareBase: 0.6,
    targetShareGain: 0.35,
  },
  informationPropagation: DEFAULT_INFORMATION_PROPAGATION_CONFIG,
};

/**
 * Issue #202 (Phase 3): 比較プリセット「今の輪への配慮が強い場」。上記と同じく`SimParams`/Phase 2設定は
 * standard-partyと揃え、Phase 3の3configだけを差し替える。
 * - `alternativeInterest`: 既定のまま ―― 他クラスタへの関心自体は普通に生じる(要件: 外部関心があっても
 *   stay decisionが観察しやすい。関心そのものを消してしまう極端な設定にはしない)。
 * - `attachment`: 愛着の形成速度・飽和値を上げ、解散配慮・influenceAvoidance寄与・抑制上限を高めることで、
 *   愛着・解散見込みによる抑制が強く効くようにする(要件: attachment形成が速い/上限が高い、
 *   解散見込み・influenceAvoidanceの抑制寄与が高い)。`maxInhibition`は1未満(0.75)に留め、
 *   離脱が完全にブロックされる(=永久に移動しない)極端な設定にはしない(要件)。
 * - `transition`: `enabled: true`で他の4プリセットと同じdecision経路を通しつつ、関心→離脱寄与や
 *   target配分は既定値のままとし、「抑制が強く効いてstayが選ばれやすい」という差だけを観察できるようにする。
 */
export const CURRENT_CIRCLE_ATTACHMENT_STANDING_PARTY_CONFIG: StandingPartyScenarioConfig = {
  conversationSatisfaction: DEFAULT_CONVERSATION_SATISFACTION_CONFIG,
  clusterDeparture: DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG,
  circulationTendencyRange: DEFAULT_CIRCULATION_TENDENCY_RANGE,
  alternativeInterest: DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG,
  attachment: {
    ...DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG,
    attachmentGrowthPerTick: 0.02,
    maxAttachment: 0.95,
    clusterWouldDissolveConcern: 0.35,
    influenceAvoidanceGain: 2,
    maxInhibition: 0.75,
  },
  transition: {
    ...DEFAULT_CLUSTER_TRANSITION_CONFIG,
    enabled: true,
  },
  informationPropagation: DEFAULT_INFORMATION_PROPAGATION_CONFIG,
};

validateStandingPartyScenarioConfig(OUTWARD_INTEREST_STANDING_PARTY_CONFIG);
validateStandingPartyScenarioConfig(CURRENT_CIRCLE_ATTACHMENT_STANDING_PARTY_CONFIG);
