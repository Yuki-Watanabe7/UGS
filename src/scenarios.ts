import { PRESETS, type ScenarioPreset } from "./simulation/presets";
import {
  AFTER_PARTY_PRESENTATION,
  CLASSROOM_PRESENTATION,
  STANDING_PARTY_PRESENTATION,
  getScenarioPresentation,
  type ScenarioPresentation,
} from "./presentation/scenarioPresentation";

export type ScenarioCategoryId = "after-party" | "classroom" | "standing-party";

export type ScenarioConfig = {
  id: ScenarioCategoryId;
  routePath: `/simulate/${string}`;
  pageTitle: string;
  homeTitle: string;
  homeDescription: string;
  observationTargets: string;
  availableScenarios: string;
  introText: string;
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
    introText:
      "二次会に行くかどうかがその場の空気で決まるような、曖昧な移行場面でのグループ形成過程を可視化します。オレンジ色のエージェントは「行きたいが、自分の意思で場を動かしたくない人 (observerJoiner)」です。",
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
    introText:
      "先生が自由にペア・班を作るよう促した教室で、複数の組が並行して形成される過程を可視化します。" +
      "誘う側と待つ側、満員になった組からの再探索、締切時の未割当に加え、3〜4人班のような可変定員では" +
      "「成立済みだがまだ空きがある班」と「満員の班」の違いも観察できます。",
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
    observationTargets: "複数の輪の並行形成、輪への接近、様子見",
    availableScenarios: "立食パーティー(標準)の1種類",
    introText:
      "立食パーティーの会場で、複数の会話の輪が同時並行に生まれていく過程を可視化します。オレンジ色のエージェントは「輪に入りたいが、自分の意思で場を動かしたくない人 (observerJoiner)」です。" +
      "会話の輪からの離脱・再探索・再参加そのものの実装は今後のアップデートで追加予定です。",
    presetIds: ["standing-party"],
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
