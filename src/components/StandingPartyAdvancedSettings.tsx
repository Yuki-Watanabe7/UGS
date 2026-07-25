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
 * standingParty選択時だけ表示する、Phase 2(会話満足度・クラスタ離脱判定・社交的回遊傾向分布)の
 * 詳細設定パネル。設定項目数が多いため常時展開せず`<details>`で折りたたむ(既存UI密度方針)。
 * すべて`resetRequired`(agent生成・FormationPolicy構築時にのみ使われるため、Resetまで現在の
 * 実行中stateには反映されない) ―― 既存の`RESET_REQUIRED_PARAM_KEYS`と同じ性質のバナーを
 * 呼び出し側(App.tsx)の`hasPendingResetChanges`が既に表示する。
 */
export function StandingPartyAdvancedSettings({ config, onConfigChange, hasPendingChanges }: Props) {
  return (
    <div className="panel standing-party-advanced-settings">
      <h2>詳細設定(立食パーティー)</h2>
      <p className="standing-party-advanced-settings-note">
        会話満足度は現在の会話エピソードに対するシミュレーション内部の仮説的な値です。社交的回遊傾向が高い人は、
        不満がなくても交流範囲を広げるため輪を移ることがあります。高低はいずれも性格の良し悪しを意味しません。
        他の輪の魅力度比較やobserverJoiner固有の遠慮はまだ扱っていません。
      </p>
      {hasPendingChanges && <p className="reset-required-banner">一部の変更はReset後に反映されます</p>}
      <details className="standing-party-advanced-settings-details">
        <summary>Phase 2パラメータ({FIELDS.length}項目)</summary>
        <div className="sliders">
          {FIELDS.map((field) => {
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
                />
              </label>
            );
          })}
        </div>
      </details>
    </div>
  );
}
