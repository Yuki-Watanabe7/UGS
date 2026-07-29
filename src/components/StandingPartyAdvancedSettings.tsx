import type { StandingPartyScenarioConfig } from "../simulation/standingPartyScenarioConfig";

type Props = {
  config: StandingPartyScenarioConfig;
  onConfigChange: (config: StandingPartyScenarioConfig) => void;
  hasPendingChanges: boolean;
};

type NumberFieldDef = {
  key: string;
  label: string;
  description: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  get: (config: StandingPartyScenarioConfig) => number;
  set: (config: StandingPartyScenarioConfig, value: number) => StandingPartyScenarioConfig;
};

type BooleanFieldDef = {
  key: string;
  label: string;
  description: string;
  get: (config: StandingPartyScenarioConfig) => boolean;
  set: (config: StandingPartyScenarioConfig, value: boolean) => StandingPartyScenarioConfig;
};

/**
 * Issue #189 (Phase 2): standingParty専用のPhase 2設定(会話満足度・クラスタ離脱判定・社交的回遊傾向分布)を
 * 一覧で編集する。既存の`SLIDERS`(sliderConfig.ts)は`SimParams`のkeyに固定された構造のため、
 * standingParty専用のこのネストした設定には転用せず、同じ見た目(range input・単位・説明文)だけ踏襲する
 * 独立したフィールド定義にする(要件: 既存の一般パラメータと意味が重複する項目を作らない)。
 */
const FIELDS: NumberFieldDef[] = [
  {
    key: "initialConversationSatisfaction",
    label: "満足度の基礎初期値",
    description: "輪への合流時点での会話満足度の基礎値(人数・clique補正を加える前)。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.conversationSatisfaction.initialConversationSatisfaction,
    set: (c, v) => ({ ...c, conversationSatisfaction: { ...c.conversationSatisfaction, initialConversationSatisfaction: v } }),
  },
  {
    key: "satisfactionDecayPerTick",
    label: "満足度の時間減衰率",
    description: "1tickあたりに会話満足度が自然に下がる量。大きいほど早く満足度が下がる。",
    unit: "/tick",
    min: 0,
    max: 0.05,
    step: 0.001,
    decimals: 3,
    get: (c) => c.conversationSatisfaction.satisfactionDecayPerTick,
    set: (c, v) => ({ ...c, conversationSatisfaction: { ...c.conversationSatisfaction, satisfactionDecayPerTick: v } }),
  },
  {
    key: "newMemberFreshnessBoost",
    label: "新規member参加による新鮮さ回復量",
    description: "同じ輪に新しい参加者が1人増えるごとに会話満足度が回復する量。",
    min: 0,
    max: 0.3,
    step: 0.01,
    decimals: 2,
    get: (c) => c.conversationSatisfaction.newMemberFreshnessBoost,
    set: (c, v) => ({ ...c, conversationSatisfaction: { ...c.conversationSatisfaction, newMemberFreshnessBoost: v } }),
  },
  {
    key: "preferredConversationSize",
    label: "居心地のよい会話人数",
    description: "この人数から実際の人数が離れるほど、会話人数補正によって満足度が下がりやすくなる。",
    unit: "人",
    min: 2,
    max: 10,
    step: 1,
    decimals: 0,
    get: (c) => c.conversationSatisfaction.preferredConversationSize,
    set: (c, v) => ({ ...c, conversationSatisfaction: { ...c.conversationSatisfaction, preferredConversationSize: v } }),
  },
  {
    key: "sizeMismatchPenaltyCap",
    label: "会話人数補正の上限",
    description: "居心地のよい会話人数からの乖離による、1tickあたりの満足度低下の上限。",
    min: 0,
    max: 0.2,
    step: 0.01,
    decimals: 2,
    get: (c) => c.conversationSatisfaction.sizeMismatchPenaltyCap,
    set: (c, v) => ({ ...c, conversationSatisfaction: { ...c.conversationSatisfaction, sizeMismatchPenaltyCap: v } }),
  },
  {
    key: "minStayTicks",
    label: "最低滞在tick",
    description: "この tick数を過ぎるまでは輪からの離脱判定の対象にならない。",
    unit: "tick",
    min: 0,
    max: 60,
    step: 1,
    decimals: 0,
    get: (c) => c.clusterDeparture.minStayTicks,
    set: (c, v) => ({ ...c, clusterDeparture: { ...c.clusterDeparture, minStayTicks: v } }),
  },
  {
    key: "maxDissatisfactionContribution",
    label: "満足度低下の離脱寄与係数",
    description: "会話満足度が下限を大きく下回ったときの、離脱確率への寄与の上限。",
    min: 0,
    max: 0.3,
    step: 0.01,
    decimals: 2,
    get: (c) => c.clusterDeparture.maxDissatisfactionContribution,
    set: (c, v) => ({ ...c, clusterDeparture: { ...c.clusterDeparture, maxDissatisfactionContribution: v } }),
  },
  {
    key: "maxCirculationContribution",
    label: "社交的回遊傾向の離脱寄与係数",
    description: "社交的回遊傾向が高い人ほど、最低滞在tick経過後に離脱確率へ寄与する量の上限。",
    min: 0,
    max: 0.3,
    step: 0.01,
    decimals: 2,
    get: (c) => c.clusterDeparture.maxCirculationContribution,
    set: (c, v) => ({ ...c, clusterDeparture: { ...c.clusterDeparture, maxCirculationContribution: v } }),
  },
  {
    key: "circulationTendencyRangeMin",
    label: "社交的回遊傾向の分布(下限)",
    description: "参加者ごとの社交的回遊傾向を一様分布で生成する範囲の下限。高低は性格の良し悪しを意味しない。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.circulationTendencyRange.min,
    set: (c, v) => ({
      ...c,
      circulationTendencyRange: { min: Math.min(v, c.circulationTendencyRange.max), max: c.circulationTendencyRange.max },
    }),
  },
  {
    key: "circulationTendencyRangeMax",
    label: "社交的回遊傾向の分布(上限)",
    description: "参加者ごとの社交的回遊傾向を一様分布で生成する範囲の上限。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.circulationTendencyRange.max,
    set: (c, v) => ({
      ...c,
      circulationTendencyRange: { min: c.circulationTendencyRange.min, max: Math.max(v, c.circulationTendencyRange.min) },
    }),
  },
];

/**
 * Issue #202 (Phase 3): 他クラスタ関心(`alternativeInterest`)の設定項目。#198のconfig型・validateへ
 * そのまま従う(相互制約なし、各項目は独立に`[0,1]`または`> 0`)。
 */
const ALTERNATIVE_INTEREST_FIELDS: NumberFieldDef[] = [
  {
    key: "observationRadius",
    label: "他クラスタの観察半径",
    description: "この距離を超える会話の輪は関心の対象にならない。",
    unit: "px",
    min: 50,
    max: 400,
    step: 10,
    decimals: 0,
    get: (c) => c.alternativeInterest.observationRadius,
    set: (c, v) => ({ ...c, alternativeInterest: { ...c.alternativeInterest, observationRadius: v } }),
  },
  {
    key: "distanceWeight",
    label: "距離による関心の上限寄与",
    description: "近い輪ほど関心scoreへ寄与する度合いの上限。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.alternativeInterest.distanceWeight,
    set: (c, v) => ({ ...c, alternativeInterest: { ...c.alternativeInterest, distanceWeight: v } }),
  },
  {
    key: "distanceDecayRadius",
    label: "距離寄与の減衰スケール",
    description: "この距離スケールで、近さによる関心寄与が徐々に薄れていく。",
    unit: "px",
    min: 50,
    max: 400,
    step: 10,
    decimals: 0,
    get: (c) => c.alternativeInterest.distanceDecayRadius,
    set: (c, v) => ({ ...c, alternativeInterest: { ...c.alternativeInterest, distanceDecayRadius: v } }),
  },
  {
    key: "knownParticipantWeight",
    label: "既知participantによる関心の上限寄与",
    description: "既に面識のある参加者がいる輪ほど関心scoreへ寄与する度合いの上限。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.alternativeInterest.knownParticipantWeight,
    set: (c, v) => ({ ...c, alternativeInterest: { ...c.alternativeInterest, knownParticipantWeight: v } }),
  },
  {
    key: "cliqueCompatibilityWeight",
    label: "clique compatibilityによる関心の上限寄与",
    description: "自分と同じclique(既存の顔なじみ集団)の比率が高い輪ほど関心scoreへ寄与する度合いの上限。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.alternativeInterest.cliqueCompatibilityWeight,
    set: (c, v) => ({ ...c, alternativeInterest: { ...c.alternativeInterest, cliqueCompatibilityWeight: v } }),
  },
  {
    key: "outsiderBarrierPenaltyCap",
    label: "outsider barrierによる減点上限",
    description: "単一cliqueに占有された輪であるほど関心scoreを下げる度合いの上限。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.alternativeInterest.outsiderBarrierPenaltyCap,
    set: (c, v) => ({ ...c, alternativeInterest: { ...c.alternativeInterest, outsiderBarrierPenaltyCap: v } }),
  },
  {
    key: "capacityPressurePenaltyCap",
    label: "capacity pressureによる減点上限",
    description: "満員に近い輪であるほど関心scoreを下げる度合いの上限。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.alternativeInterest.capacityPressurePenaltyCap,
    set: (c, v) => ({ ...c, alternativeInterest: { ...c.alternativeInterest, capacityPressurePenaltyCap: v } }),
  },
  {
    key: "minTargetInterestScore",
    label: "target候補となる最低関心score",
    description: "この値未満の関心scoreでは、その輪はswitch先のtarget候補にならない。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.alternativeInterest.minTargetInterestScore,
    set: (c, v) => ({ ...c, alternativeInterest: { ...c.alternativeInterest, minTargetInterestScore: v } }),
  },
];

/**
 * Issue #202 (Phase 3): 現在クラスタ愛着・離脱配慮(`attachment`)の設定項目。#199のconfig型・validateに
 * 従い、`initialAttachment <= maxAttachment`の相互制約はsetter側でclampして常に維持する
 * (`circulationTendencyRangeMin/Max`と同じ方針)。
 */
const ATTACHMENT_FIELDS: NumberFieldDef[] = [
  {
    key: "initialAttachment",
    label: "愛着の初期値",
    description: "輪へ合流した時点での現在クラスタ愛着の初期値。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.attachment.initialAttachment,
    set: (c, v) => ({
      ...c,
      attachment: { ...c.attachment, initialAttachment: Math.min(v, c.attachment.maxAttachment) },
    }),
  },
  {
    key: "maxAttachment",
    label: "愛着の飽和値",
    description: "この値を超えて愛着は増え続けない上限。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.attachment.maxAttachment,
    set: (c, v) => ({
      ...c,
      attachment: { ...c.attachment, maxAttachment: Math.max(v, c.attachment.initialAttachment) },
    }),
  },
  {
    key: "attachmentGrowthPerTick",
    label: "愛着の形成速度",
    description: "1tickあたりに愛着が自然に増える量。",
    unit: "/tick",
    min: 0,
    max: 0.05,
    step: 0.001,
    decimals: 3,
    get: (c) => c.attachment.attachmentGrowthPerTick,
    set: (c, v) => ({ ...c, attachment: { ...c.attachment, attachmentGrowthPerTick: v } }),
  },
  {
    key: "memberTurnoverAttachmentLoss",
    label: "member入れ替わりによる愛着の低下量",
    description: "合流時から同席していたmemberが入れ替わった比率に応じて愛着が下がる量。",
    min: 0,
    max: 0.5,
    step: 0.01,
    decimals: 2,
    get: (c) => c.attachment.memberTurnoverAttachmentLoss,
    set: (c, v) => ({ ...c, attachment: { ...c.attachment, memberTurnoverAttachmentLoss: v } }),
  },
  {
    key: "newMemberDilution",
    label: "新規member参加による愛着の希釈量",
    description: "同じ輪に新しい参加者が1人増えるごとに愛着が薄まる量。",
    min: 0,
    max: 0.2,
    step: 0.01,
    decimals: 2,
    get: (c) => c.attachment.newMemberDilution,
    set: (c, v) => ({ ...c, attachment: { ...c.attachment, newMemberDilution: v } }),
  },
  {
    key: "clusterWouldDissolveConcern",
    label: "解散配慮の寄与係数",
    description: "自分が離脱するとこの輪が解散してしまう場合の、離脱抑制への寄与。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.attachment.clusterWouldDissolveConcern,
    set: (c, v) => ({ ...c, attachment: { ...c.attachment, clusterWouldDissolveConcern: v } }),
  },
  {
    key: "influenceAvoidanceGain",
    label: "influenceAvoidance寄与係数",
    description: "他者への影響を避けたい度合い(influenceAvoidance)が、解散・release配慮に乗る倍率。",
    min: 0,
    max: 4,
    step: 0.1,
    decimals: 1,
    get: (c) => c.attachment.influenceAvoidanceGain,
    set: (c, v) => ({ ...c, attachment: { ...c.attachment, influenceAvoidanceGain: v } }),
  },
  {
    key: "maxInhibition",
    label: "抑制の合計上限",
    description: "愛着・配慮を積み上げても、離脱確率へかかる抑制の合計はこの値を超えない(1未満に固定)。",
    min: 0,
    max: 0.95,
    step: 0.05,
    decimals: 2,
    get: (c) => c.attachment.maxInhibition,
    set: (c, v) => ({ ...c, attachment: { ...c.attachment, maxInhibition: v } }),
  },
];

/**
 * Issue #202 (Phase 3): 遷移decision・移動意図(`transition`)の設定項目。#200/#201のconfig型・validateに
 * 従い、`targetShareBase + targetShareGain <= 1`の相互制約はsetter側でclampして常に維持する。
 * `enabled`は数値ではないため`BOOLEAN_FIELDS`として別に定義する。
 */
const TRANSITION_BOOLEAN_FIELDS: BooleanFieldDef[] = [
  {
    key: "transitionEnabled",
    label: "他クラスタ関心・愛着配慮をdecisionへ反映する",
    description:
      "オフ(既定)の間は、Phase 2の離脱判定のみが使われ、他クラスタ関心・愛着・遷移decisionは一切参照されない(既存挙動と完全に同じ)。",
    get: (c) => c.transition.enabled,
    set: (c, v) => ({ ...c, transition: { ...c.transition, enabled: v } }),
  },
];

const TRANSITION_FIELDS: NumberFieldDef[] = [
  {
    key: "interestToDepartureGain",
    label: "他クラスタ関心のswitch寄与係数",
    description: "他クラスタ関心scoreが、離脱を後押しする駆動側へどれだけ乗るか。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.transition.interestToDepartureGain,
    set: (c, v) => ({ ...c, transition: { ...c.transition, interestToDepartureGain: v } }),
  },
  {
    key: "targetShareBase",
    label: "departAndExplore/switchToTargetClusterの配分(基礎値)",
    description: "target候補がある離脱のうち、最初から目的地ありで始まる基礎割合。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.transition.targetShareBase,
    set: (c, v) => ({
      ...c,
      transition: { ...c.transition, targetShareBase: Math.min(v, 1 - c.transition.targetShareGain) },
    }),
  },
  {
    key: "targetShareGain",
    label: "departAndExploreからswitchToTargetClusterへ寄る増分",
    description: "他クラスタ関心が強いほど、目的地ありの割合がさらに増える量(基礎値との合計は1以下)。",
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
    get: (c) => c.transition.targetShareGain,
    set: (c, v) => ({
      ...c,
      transition: { ...c.transition, targetShareGain: Math.min(v, 1 - c.transition.targetShareBase) },
    }),
  },
  {
    key: "pendingTransitionTtlTicks",
    label: "移動意図の有効tick",
    description: "目的地ありの移動意図(pending transition)が、targetへ到達しないまま失効するまでのtick数。",
    unit: "tick",
    min: 5,
    max: 100,
    step: 1,
    decimals: 0,
    get: (c) => c.transition.pendingTransitionTtlTicks,
    set: (c, v) => ({ ...c, transition: { ...c.transition, pendingTransitionTtlTicks: v } }),
  },
];

/**
 * standingParty選択時だけ表示する、Phase 2(会話満足度・クラスタ離脱判定・社交的回遊傾向分布)の
 * 詳細設定パネル。設定項目数が多いため常時展開せず`<details>`で折りたたむ(既存UI密度方針)。
 * すべて`resetRequired`(agent生成・FormationPolicy構築時にのみ使われるため、Resetまで現在の
 * 実行中stateには反映されない) ―― 既存の`RESET_REQUIRED_PARAM_KEYS`と同じ性質のバナーを
 * 呼び出し側(App.tsx)の`hasPendingResetChanges`が既に表示する。
 */
function renderNumberFields(
  fields: NumberFieldDef[],
  config: StandingPartyScenarioConfig,
  onConfigChange: (config: StandingPartyScenarioConfig) => void,
) {
  return (
    <div className="sliders">
      {fields.map((field) => {
        const value = field.get(config);
        return (
          <label className="field slider-field" key={field.key}>
            <span>
              {field.label}: {value.toFixed(field.decimals)}
              {field.unit ?? ""}
              <span className="apply-mode-badge apply-mode-badge--resetRequired">Resetで反映</span>
            </span>
            <span className="slider-description">{field.description}</span>
            <input
              type="range"
              min={field.min}
              max={field.max}
              step={field.step}
              value={value}
              onChange={(e) => onConfigChange(field.set(config, Number(e.target.value)))}
              data-testid={`standing-party-field-${field.key}`}
            />
          </label>
        );
      })}
    </div>
  );
}

function renderBooleanFields(
  fields: BooleanFieldDef[],
  config: StandingPartyScenarioConfig,
  onConfigChange: (config: StandingPartyScenarioConfig) => void,
) {
  return (
    <div className="sliders">
      {fields.map((field) => {
        const value = field.get(config);
        return (
          <label className="field checkbox-field" key={field.key}>
            <input
              type="checkbox"
              checked={value}
              onChange={(e) => onConfigChange(field.set(config, e.target.checked))}
              data-testid={`standing-party-field-${field.key}`}
            />
            <span>
              {field.label}
              <span className="apply-mode-badge apply-mode-badge--resetRequired">Resetで反映</span>
            </span>
            <span className="slider-description">{field.description}</span>
          </label>
        );
      })}
    </div>
  );
}

export function StandingPartyAdvancedSettings({ config, onConfigChange, hasPendingChanges }: Props) {
  return (
    <div className="panel standing-party-advanced-settings">
      <h2>詳細設定(立食パーティー)</h2>
      <p className="standing-party-advanced-settings-note">
        会話満足度・社交的回遊傾向・他クラスタ関心・愛着はいずれも、観察できる距離・構成・既存関係と
        現在の会話エピソードだけから導かれるシミュレーション内部の仮説的な値です。高低は性格の良し悪しや
        社交性の優劣を意味しません。愛着は今のエピソードに限る一時的な状態であり、人物間の長期的な好感度を
        表すものではありません。influenceAvoidance(自分の離脱が周囲に与える影響への配慮)も人格の良し悪しを
        示すものではなく、ObserverJoinerも他のagentと同じ連続値のdecisionを使います(booleanによる特別扱いはありません)。
      </p>
      {hasPendingChanges && <p className="reset-required-banner">一部の変更はReset後に反映されます</p>}
      <details className="standing-party-advanced-settings-details">
        <summary>Phase 2パラメータ({FIELDS.length}項目)</summary>
        {renderNumberFields(FIELDS, config, onConfigChange)}
      </details>
      <details className="standing-party-advanced-settings-details">
        <summary>他クラスタ関心({ALTERNATIVE_INTEREST_FIELDS.length}項目)</summary>
        {renderNumberFields(ALTERNATIVE_INTEREST_FIELDS, config, onConfigChange)}
      </details>
      <details className="standing-party-advanced-settings-details">
        <summary>現在クラスタ愛着・離脱配慮({ATTACHMENT_FIELDS.length}項目)</summary>
        {renderNumberFields(ATTACHMENT_FIELDS, config, onConfigChange)}
      </details>
      <details className="standing-party-advanced-settings-details">
        <summary>
          遷移decision・移動意図({TRANSITION_BOOLEAN_FIELDS.length + TRANSITION_FIELDS.length}項目)
        </summary>
        {renderBooleanFields(TRANSITION_BOOLEAN_FIELDS, config, onConfigChange)}
        {renderNumberFields(TRANSITION_FIELDS, config, onConfigChange)}
      </details>
    </div>
  );
}
