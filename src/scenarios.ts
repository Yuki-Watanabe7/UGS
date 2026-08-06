import { PRESETS, type ScenarioPreset } from "./simulation/presets";
import {
  AFTER_PARTY_PRESENTATION,
  CLASSROOM_PRESENTATION,
  STANDING_PARTY_PRESENTATION,
  getScenarioPresentation,
  type ScenarioPresentation,
} from "./presentation/scenarioPresentation";
import type { ScenarioIntroSection } from "./components/scenarioIntroductionContent";

export type ScenarioCategoryId = "after-party" | "classroom" | "standing-party";

export type ScenarioConfig = {
  id: ScenarioCategoryId;
  routePath: `/simulate/${string}`;
  pageTitle: string;
  homeTitle: string;
  homeDescription: string;
  observationTargets: string;
  availableScenarios: string;
  /** 初期表示で常時表示する、1〜2文の説明。 */
  introSummary: string;
  /** 必要なときだけ開く、モデルの仕組み・見方・注意事項。 */
  introDetails?: readonly ScenarioIntroSection[];
  presetIds: readonly string[];
  initialPresetId: string;
  presentation: ScenarioPresentation;
};

export const SCENARIOS: readonly ScenarioConfig[] = [
  {
    id: "after-party",
    routePath: "/simulate/after-party",
    pageTitle: "二次会のグループ形成シミュレーション",
    homeTitle: "二次会のグループ形成",
    homeDescription:
      "一次会のあと、誰が声を上げ、誰が様子を見て、どのように次のグループが生まれるかを観察します。",
    observationTargets: "主導者、様子見、後からの合流、離脱",
    availableScenarios: "自然な成立、曖昧な解散、強い主導者など5種類",
    introSummary:
      "二次会に行くかどうかがその場の空気で決まる、曖昧な移行場面でのグループ形成過程を可視化します。",
    introDetails: [
      {
        id: "after-party-process",
        title: "このシミュレーションで起こること",
        body: "誰かが声を上げること、周囲が様子を見ること、後から合流すること、離脱することが重なりながら、次のグループが生まれる過程を観察できます。",
      },
      {
        id: "after-party-observer-joiner",
        title: "ObserverJoinerについて",
        body: "オレンジ色のagentは「行きたいが、自分の意思で場を動かしたくない人 (observerJoiner)」を表します。これはその場での行動傾向を表すモデル上の役割です。",
      },
    ],
    presetIds: [
      "natural",
      "ambiguous-dissolve",
      "strong-leader",
      "late-join-culture",
      "leftover-free-grouping",
    ],
    initialPresetId: "natural",
    presentation: AFTER_PARTY_PRESENTATION,
  },
  {
    id: "classroom",
    routePath: "/simulate/classroom",
    pageTitle: "学校のペア・班作りシミュレーション",
    homeTitle: "学校のペア・班作り",
    homeDescription:
      "教室で自由に相手を探すとき、ペアや班が並行して成立し、再探索や未割当がどう生じるかを観察します。",
    observationTargets: "ペア・班の成立、再探索、待機、未割当",
    availableScenarios: "ペア(2人固定)、3人班、4人班、3〜4人班の4種類",
    introSummary:
      "教室で自由にペア・班を作るとき、複数の組がどう成立し、再探索や未割当がどう生じるかを観察します。",
    introDetails: [
      {
        id: "classroom-process",
        title: "このシミュレーションで起こること",
        body: "先生が自由にペア・班を作るよう促した教室で、複数の組が並行して形成されます。誘う側と待つ側、満員になった組からの再探索、締切時の未割当を観察できます。",
      },
      {
        id: "classroom-capacity",
        title: "班の定員の見方",
        body: "3〜4人班のような可変定員では、「成立済みだがまだ空きがある班」と「満員の班」の違いも確認できます。",
      },
    ],
    presetIds: [
      "classroom-pair",
      "classroom-group-3",
      "classroom-group-4",
      "classroom-group-3-4",
    ],
    initialPresetId: "classroom-pair",
    presentation: CLASSROOM_PRESENTATION,
  },
  {
    id: "standing-party",
    routePath: "/simulate/standing-party",
    pageTitle: "立食パーティーの会話クラスタ形成シミュレーション",
    homeTitle: "立食パーティーの会話クラスタ形成",
    homeDescription:
      "会場のあちこちで複数の会話の輪が並行して形成される立食パーティーで、誰がどの輪を見つけ、誰が輪を探し続けるかを観察します。",
    observationTargets:
      "複数の輪の並行形成、輪への接近、様子見、会話満足度・社交的回遊傾向・他クラスタ関心・愛着による輪の離脱と目的地付き移動",
    availableScenarios: "標準・ネットワーキング型・懇親型・交流先へ移りやすい場・今の輪への配慮が強い場の5種類",
    introSummary:
      "会場のあちこちで複数の会話の輪が生まれ、人が輪を移りながら会話を続ける過程を観察します。輪の形成後も離脱・再探索・再参加と、縮小・解散が起こります。",
    introDetails: [
      {
        id: "standing-party-process",
        title: "このシミュレーションで起こること",
        body: "立食パーティーの会場で、複数の会話の輪が同時並行に生まれます。輪が成立した後も、人はその輪から離脱して別の輪を再探索・再参加し、輪自体も人数が減れば縮小・解散します。",
      },
      {
        id: "standing-party-departure",
        title: "離脱・移動の要因",
        body: "離脱には、今の会話への満足度が下がること(会話満足度)、不満がなくてもより多くの人と交流したいこと(社交的回遊傾向)、別の輪が気になること(他クラスタ関心)が関わります。今の輪への愛着や、自分の離脱による影響への配慮がそれを抑えることもあります。",
      },
      {
        id: "standing-party-observer-joiner",
        title: "ObserverJoinerについて",
        body: "オレンジ色のagentは「輪に入りたいが、自分の意思で場を動かしたくない人 (observerJoiner)」を表します。これはその場での行動傾向を表すモデル上の役割です。",
      },
      {
        id: "standing-party-interpretation",
        title: "値の解釈上の注意",
        body: "満足度・愛着は現在の会話エピソードに対するシミュレーション内部の仮説的な値です。回遊傾向・関心・愛着の高低や観察される移動の多さは、性格の良し悪しや人格診断を意味しません。",
      },
      {
        id: "standing-party-operation",
        title: "実行方法",
        body: "他クラスタ関心が強いdecisionでは、目的地を決めてそこへ向かう移動意図(pending transition)が生じることがあります。この動的な循環は決まった終了条件を持たないため、区切りたいタイミングで一時停止してください。",
      },
      {
        id: "standing-party-future-extension",
        title: "今後の拡張",
        body: "Phase 5で話題や情報伝播のモデルを追加する場合も、この説明内で前提と観察ポイントを補足します。現在は会話の輪の形成・離脱・移動を主な観察対象としています。",
      },
    ],
    presetIds: [
      "standing-party",
      "standing-party-networking",
      "standing-party-intimate",
      "standing-party-outward-interest",
      "standing-party-current-circle",
    ],
    initialPresetId: "standing-party",
    presentation: STANDING_PARTY_PRESENTATION,
  },
] as const;

function requirePreset(id: string): ScenarioPreset {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new Error(`Unknown scenario preset: ${id}`);
  }
  return preset;
}

export function getScenarioById(id: ScenarioCategoryId): ScenarioConfig {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`Unknown scenario category: ${id}`);
  }
  return scenario;
}

export function getPresetsForScenario(scenario: ScenarioConfig): ScenarioPreset[] {
  return scenario.presetIds.map(requirePreset);
}

export function getPresetForScenario(scenario: ScenarioConfig, presetId: string): ScenarioPreset {
  const allowedPresetId = scenario.presetIds.includes(presetId)
    ? presetId
    : scenario.initialPresetId;
  return requirePreset(allowedPresetId);
}

/**
 * Issue #155 (Phase 4): 選択中のプリセットに紐づく班人数設定(`preset.formationClassroomGroupSize`)
 * から、そのプリセット向けの表示語彙(ペア/班)を解決する。`scenario.presentation`は
 * シナリオカテゴリ単位の静的な既定値(二次会シナリオではこれをそのまま使う)であり、
 * 学校シナリオではプリセットごとに動的解決した結果を優先する。
 */
export function resolvePresentationForPreset(
  scenario: ScenarioConfig,
  preset: ScenarioPreset,
): ScenarioPresentation {
  if (scenario.id !== "classroom") return scenario.presentation;
  return getScenarioPresentation(preset.formationScenarioId ?? "afterParty", preset.formationClassroomGroupSize);
}
