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
};

export const DEFAULT_CIRCULATION_TENDENCY_RANGE: SocialCirculationTendencyRange = { min: 0, max: 1 };

export const DEFAULT_STANDING_PARTY_SCENARIO_CONFIG: StandingPartyScenarioConfig = {
  conversationSatisfaction: DEFAULT_CONVERSATION_SATISFACTION_CONFIG,
  clusterDeparture: DEFAULT_CLUSTER_DEPARTURE_DECISION_CONFIG,
  circulationTendencyRange: DEFAULT_CIRCULATION_TENDENCY_RANGE,
  alternativeInterest: DEFAULT_ALTERNATIVE_CLUSTER_INTEREST_CONFIG,
  attachment: DEFAULT_CURRENT_CLUSTER_ATTACHMENT_CONFIG,
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
};

validateStandingPartyScenarioConfig(NETWORKING_STANDING_PARTY_CONFIG);
validateStandingPartyScenarioConfig(INTIMATE_STANDING_PARTY_CONFIG);
