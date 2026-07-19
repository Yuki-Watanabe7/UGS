import { PRESETS, type ScenarioPreset } from "./simulation/presets";
import {
  AFTER_PARTY_PRESENTATION,
  CLASSROOM_PRESENTATION,
  type ScenarioPresentation,
} from "./presentation/scenarioPresentation";

export type ScenarioCategoryId = "after-party" | "classroom";

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
      "教室で自由に相手を探すとき、ペアが並行して成立し、再探索や未割当がどう生じるかを観察します。",
    observationTargets: "ペア成立、再探索、待機、未割当",
    availableScenarios: "自由にペアを作る教室シナリオ",
    introText:
      "先生が自由にペアを作るよう促した教室で、2人組が並行して形成される過程を可視化します。誘う側と待つ側、満員になったペアからの再探索、締切時の未割当を観察できます。",
    presetIds: ["classroom-pair"],
    initialPresetId: "classroom-pair",
    presentation: CLASSROOM_PRESENTATION,
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
