import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Router from "../Router";
import { getSlidersForPresentation } from "../components/sliderConfig";
import { EventLog } from "../components/EventLog";
import { ObserverJoinerInspector } from "../components/ObserverJoinerInspector";
import { SimulationCanvas } from "../components/SimulationCanvas";
import { SimulationSummaryPanel } from "../components/SimulationSummaryPanel";
import { createInitialState, stepSimulation } from "../simulation/engine";
import type { ExpressionReason } from "../simulation/expression";
import { resolveExpressionVariants } from "../simulation/expressionTemplates";
import type { SpeechReason } from "../simulation/speech";
import { resolveSpeechText } from "../simulation/speechTemplates";
import type { LogEntry } from "../simulation/types";
import { getPresetById } from "../simulation/presets";
import { SeededRandom } from "../simulation/random";
import {
  AFTER_PARTY_PRESENTATION,
  CLASSROOM_PRESENTATION,
  STANDING_PARTY_PRESENTATION,
  getScenarioPresentation,
  normalizeInterventionForPresentation,
  resolveClassroomPresentation,
  resolveScenarioLogMessage,
} from "./scenarioPresentation";

const FORBIDDEN_CLASSROOM_TERMS = ["二次会", "もう一軒", "店", "会場", "帰宅", "途中参加"];

// Issue #174 受入条件: 立食パーティー画面に二次会・学校固有の主要文言を表示しない
const FORBIDDEN_STANDING_PARTY_TERMS = [
  "二次会に行く",
  "もう一軒行く",
  "先生が",
  "締切到達",
  "先生がペア",
  "先生が班",
];

const SPEECH_REASONS: SpeechReason[] = [
  "initiativeFormedCore",
  "cliqueFormedCore",
  "formingGroupRecruitment",
  "approachWelcome",
  "joinGreeting",
  "leaveDeclaration",
  "lightObserverInvitation",
];

const EXPRESSION_REASONS: ExpressionReason[] = [
  "initiativeFormedCore",
  "cliqueFormedCore",
  "approachedFormingGroup",
  "approachedConfirmedGroup",
  "arrivedAtFormingGroup",
  "arrivedAtConfirmedGroup",
  "ambiguityStressExceeded",
  "reachedScreenEdge",
  "receivedLightInvitation",
  "stressCrossedRisingThreshold",
  "stressNearLeaveThreshold",
  "nearbyGroupUnapproached",
  "noJoinableGroupNearby",
];

function expectNoClassroomForbiddenTerms(text: string): void {
  for (const term of FORBIDDEN_CLASSROOM_TERMS) {
    expect(text, `学校表示に禁止語「${term}」が含まれています`).not.toContain(term);
  }
}

function expectNoStandingPartyForbiddenTerms(text: string): void {
  for (const term of FORBIDDEN_STANDING_PARTY_TERMS) {
    expect(text, `立食パーティー表示に禁止語「${term}」が含まれています`).not.toContain(term);
  }
}

describe("scenario presentation: classroom rendering audit", () => {
  it("does not render after-party-only vocabulary, and shows the group-formation comparison panel (not the after-party one) on the classroom route", () => {
    const html = renderToStaticMarkup(
      createElement(Router, { initialPathname: "/simulate/classroom" }),
    );

    expectNoClassroomForbiddenTerms(html);
    expect(html).toContain("生徒数");
    expect(html).toContain("ペアの人数: 2人固定");
    expect(html).toContain("自発的に相手を探す意欲");
    // Issue #157: 学校向け低圧介入(近くの人への声かけ促進/空きのある班の参加可能表示)を選べるよう、
    // 介入選択UI自体は表示するようになった。
    expect(html).toContain("介入シナリオ");
    expect(html).toContain("近くの人への声かけ促進");
    expect(html).toContain("空きのある班の参加可能表示");
    // Issue #160: 学校route専用の班形成・教師介入比較パネル(`GroupFormationComparisonPanel`)が表示される。
    // 二次会専用の`InterventionComparisonPanel`(見出し文言が完全一致する「介入なしとの比較」のみ)は
    // `showInterventionComparison: false`のまま据え置かれ、学校routeでは表示されない。
    expect(html).toContain("介入なしとの比較(班形成・教師介入)");
    expect(html).not.toMatch(/介入なしとの比較(?!\()/);
  });

  it("audits the dynamic classroom logs, speech inspector, canvas, and summary after a full run", () => {
    const preset = getPresetById("classroom-pair");
    const seed = 12345;
    const formation = {
      scenarioId: "classroomPair" as const,
      formationDeadlineTick: preset.formationDeadlineTick,
    };
    const rng = new SeededRandom(seed);
    let state = createInitialState(
      seed,
      preset.params,
      { interventionId: "none" },
      { enabled: true },
      { enabled: true },
      { enabled: true },
      { enabled: true },
      formation,
    );
    while (!state.finished && state.tick < 500) {
      state = stepSimulation(
        state,
        preset.params,
        rng,
        { interventionId: "none" },
        undefined,
        undefined,
        undefined,
        undefined,
        formation,
      );
    }

    const html = [
      renderToStaticMarkup(
        createElement(EventLog, {
          state,
          presentation: CLASSROOM_PRESENTATION,
          seed,
          presetId: preset.id,
        }),
      ),
      renderToStaticMarkup(
        createElement(ObserverJoinerInspector, {
          state,
          params: preset.params,
          seed,
          presetId: preset.id,
        }),
      ),
      renderToStaticMarkup(createElement(SimulationSummaryPanel, { state })),
      renderToStaticMarkup(
        createElement(SimulationCanvas, {
          agents: state.agents,
          groupCandidates: state.groupCandidates,
          width: state.width,
          height: state.height,
          formationScenarioId: state.formationScenarioId,
        }),
      ),
    ].join("\n");

    expect(state.finished).toBe(true);
    expect(state.interventionId).toBe("none");
    expectNoClassroomForbiddenTerms(html);
  });

  it("audits a full 3〜4-person variable-capacity (classroom-group-3-4) run with 班 vocabulary end to end", () => {
    const preset = getPresetById("classroom-group-3-4");
    const seed = 12345;
    const formation = {
      scenarioId: "classroomPair" as const,
      formationDeadlineTick: preset.formationDeadlineTick,
      classroomGroupSize: preset.formationClassroomGroupSize,
    };
    const presentation = resolveClassroomPresentation(preset.formationClassroomGroupSize!);
    const rng = new SeededRandom(seed);
    let state = createInitialState(
      seed,
      preset.params,
      { interventionId: "none" },
      { enabled: true },
      { enabled: true },
      { enabled: true },
      { enabled: true },
      formation,
    );
    while (!state.finished && state.tick < 500) {
      state = stepSimulation(
        state,
        preset.params,
        rng,
        { interventionId: "none" },
        undefined,
        undefined,
        undefined,
        undefined,
        formation,
      );
    }

    const html = [
      renderToStaticMarkup(
        createElement(EventLog, { state, presentation, seed, presetId: preset.id }),
      ),
      renderToStaticMarkup(
        createElement(ObserverJoinerInspector, { state, params: preset.params, seed, presetId: preset.id }),
      ),
      renderToStaticMarkup(createElement(SimulationSummaryPanel, { state, params: preset.params })),
      renderToStaticMarkup(
        createElement(SimulationCanvas, {
          agents: state.agents,
          groupCandidates: state.groupCandidates,
          width: state.width,
          height: state.height,
          formationScenarioId: state.formationScenarioId,
          formationClassroomGroupSize: state.formationClassroomGroupSize,
        }),
      ),
    ].join("\n");

    expect(state.finished).toBe(true);
    // 学校向けFormationPolicy(#154)が正しく3〜4人可変定員へ配線されていることの確認
    expect(state.groupCandidates.every((c) => c.memberIds.length <= 4)).toBe(true);
    expect(html).toContain("班");
    expect(html).not.toContain("2人固定");
    expectNoClassroomForbiddenTerms(html);
  });

  it("keeps the existing after-party vocabulary on the after-party route", () => {
    const html = renderToStaticMarkup(
      createElement(Router, { initialPathname: "/simulate/after-party" }),
    );

    expect(html).toContain("二次会成立に必要な人数");
    expect(html).toContain("全体の二次会意欲");
    expect(html).toContain("介入シナリオ");
  });
});

describe("scenario presentation: standing party rendering audit (Issue #174)", () => {
  it("does not render after-party- or classroom-only vocabulary on the standing-party route, and only offers the 'none' intervention", () => {
    const html = renderToStaticMarkup(
      createElement(Router, { initialPathname: "/simulate/standing-party" }),
    );

    expectNoStandingPartyForbiddenTerms(html);
    expect(html).toContain("立食パーティー");
    expect(html).toContain("会話の輪の成立に必要な人数");
    expect(html).toContain("全体の参加意欲");
    // Issue #174: Phase 1時点で立食パーティー向けに実装済みの介入は存在しないため、
    // 二次会・学校向け介入名(「介入なしとの比較」以外の具体的な介入名)は表示されない
    expect(html).not.toContain("集合場所の明示");
    expect(html).not.toContain("近くの人への声かけ促進");
  });

  it("audits the dynamic standing-party logs, speech inspector, canvas, and summary after a full run", () => {
    const preset = getPresetById("standing-party");
    const seed = 12345;
    const formation = { scenarioId: "standingParty" as const };
    // Issue #175: standingPartyは意味論的な自然終了を持たないため、監査用のスナップショットを
    // 決定的に取得するには明示的なobservation horizonが必要(受入条件: 全員所属/全クラスタ成立でも
    // 自動終了しない。ここでの終了は`observationHorizonReached`によるものであり、
    // 「立食パーティーという社会過程が終わった」ことを意味しない)。
    const observationHorizonTick = 500;
    const rng = new SeededRandom(seed);
    let state = createInitialState(
      seed,
      preset.params,
      { interventionId: "none" },
      { enabled: true },
      { enabled: true },
      { enabled: true },
      { enabled: true },
      formation,
      observationHorizonTick,
    );
    while (!state.finished) {
      state = stepSimulation(
        state,
        preset.params,
        rng,
        { interventionId: "none" },
        undefined,
        undefined,
        undefined,
        undefined,
        formation,
        observationHorizonTick,
      );
      // 受入条件: 初期化後と複数tick更新後でformationScenarioId === "standingParty"が維持される
      expect(state.formationScenarioId).toBe("standingParty");
    }

    const html = [
      renderToStaticMarkup(
        createElement(EventLog, {
          state,
          presentation: STANDING_PARTY_PRESENTATION,
          seed,
          presetId: preset.id,
        }),
      ),
      renderToStaticMarkup(
        createElement(ObserverJoinerInspector, {
          state,
          params: preset.params,
          seed,
          presetId: preset.id,
        }),
      ),
      renderToStaticMarkup(createElement(SimulationSummaryPanel, { state, params: preset.params })),
      renderToStaticMarkup(
        createElement(SimulationCanvas, {
          agents: state.agents,
          groupCandidates: state.groupCandidates,
          width: state.width,
          height: state.height,
          formationScenarioId: state.formationScenarioId,
        }),
      ),
    ].join("\n");

    expect(state.finished).toBe(true);
    expect(state.interventionId).toBe("none");
    expect(state.formationScenarioId).toBe("standingParty");
    expectNoStandingPartyForbiddenTerms(html);
  });
});

describe("scenario presentation: operation and intervention contract", () => {
  it("shows the fixed pair size but hides parameters that have no classroom meaning", () => {
    const sliders = getSlidersForPresentation(CLASSROOM_PRESENTATION);
    const byKey = new Map(sliders.map((slider) => [slider.key, slider]));

    expect(byKey.get("groupConfirmSize")).toMatchObject({
      editable: false,
      fixedValueLabel: "2人固定",
    });
    expect(byKey.has("lateJoinEase")).toBe(false);
    expect(byKey.has("observerLeaveEase")).toBe(false);
  });

  it("forces unavailable classroom interventions to none while preserving after-party selections", () => {
    expect(normalizeInterventionForPresentation("predecided-venue", CLASSROOM_PRESENTATION)).toBe("none");
    expect(normalizeInterventionForPresentation("late-join-ok", CLASSROOM_PRESENTATION)).toBe("none");
    expect(normalizeInterventionForPresentation("late-join-ok", AFTER_PARTY_PRESENTATION)).toBe("late-join-ok");
  });

  it("forces every after-party/classroom-only intervention to none on the standing-party presentation (Issue #174)", () => {
    expect(STANDING_PARTY_PRESENTATION.availableInterventionIds).toEqual(["none"]);
    expect(normalizeInterventionForPresentation("late-join-ok", STANDING_PARTY_PRESENTATION)).toBe("none");
    expect(normalizeInterventionForPresentation("nearby-peer-prompt", STANDING_PARTY_PRESENTATION)).toBe("none");
    expect(normalizeInterventionForPresentation("none", STANDING_PARTY_PRESENTATION)).toBe("none");
  });
});

describe("scenario presentation: speech and thought resolution", () => {
  it("resolves every SpeechReason with scenario-appropriate text", () => {
    for (const reason of SPEECH_REASONS) {
      const afterParty = resolveSpeechText(reason, "afterParty");
      const classroom = resolveSpeechText(reason, "classroomPair");
      expect(afterParty.length).toBeGreaterThan(0);
      expect(classroom.length).toBeGreaterThan(0);
      expectNoClassroomForbiddenTerms(classroom);
    }

    expect(resolveSpeechText("initiativeFormedCore", "afterParty")).toBe("もう一軒行く?");
    expect(resolveSpeechText("initiativeFormedCore", "classroomPair")).toBe("一緒にペアを作らない?");
  });

  it("resolves every thought reason without classroom-forbidden vocabulary", () => {
    for (const reason of EXPRESSION_REASONS) {
      for (const isObserverJoiner of [false, true]) {
        const variants = resolveExpressionVariants(reason, isObserverJoiner, "classroomPair");
        expect(variants.length).toBeGreaterThan(0);
        variants.forEach(expectNoClassroomForbiddenTerms);
      }
    }
  });
});

describe("scenario presentation: structured state log resolution", () => {
  it("renders the same structured event with school vocabulary without mutating the stored message", () => {
    const entry: LogEntry = {
      tick: 3,
      message: '00:09 Aさんが「もう一軒行く?」と発言し、核を作り始めた',
      tags: ["nucleus"],
      eventType: "nucleusCreated",
      metadata: { agentId: "a", agentLabel: "A", groupId: "group-3-a" },
    };

    const classroomText = resolveScenarioLogMessage(entry, CLASSROOM_PRESENTATION);
    expect(classroomText).toContain("一緒にペアを作らない?");
    expectNoClassroomForbiddenTerms(classroomText);
    expect(resolveScenarioLogMessage(entry, AFTER_PARTY_PRESENTATION)).toBe(entry.message);
    expect(entry.message).toContain("もう一軒");
  });

  it("renders group-flavored (班) vocabulary for a group event once resolveClassroomPresentation switches the unit word", () => {
    const entry: LogEntry = {
      tick: 8,
      message: "",
      tags: ["groupConfirmed"],
      eventType: "joinFailedCapacity",
      metadata: { agentId: "a", agentLabel: "A", groupId: "group-3-a" },
    };
    const groupPresentation = resolveClassroomPresentation({ minGroupSize: 3, maxGroupSize: 4 });

    const text = resolveScenarioLogMessage(entry, groupPresentation);
    expect(text).toContain("班候補 group-3-a");
    expect(text).toContain("既に定員に達していたため組めなかった");
    expect(text).not.toContain("2人決まっていた");
  });
});

describe("scenario presentation: dynamic classroom group-size resolution (Issue #155)", () => {
  it("returns the exact static CLASSROOM_PRESENTATION for the default 2-person pair (backward compatible)", () => {
    expect(resolveClassroomPresentation({ minGroupSize: 2, maxGroupSize: 2 })).toBe(CLASSROOM_PRESENTATION);
    expect(getScenarioPresentation("classroomPair")).toBe(CLASSROOM_PRESENTATION);
    expect(getScenarioPresentation("classroomPair", { minGroupSize: 2, maxGroupSize: 2 })).toBe(
      CLASSROOM_PRESENTATION,
    );
  });

  it("switches to 班 vocabulary and a fixed capacity label for a fixed 3-person group", () => {
    const presentation = resolveClassroomPresentation({ minGroupSize: 3, maxGroupSize: 3 });

    expect(presentation.groupUnit).toMatchObject({
      unitWord: "班",
      isVariableCapacity: false,
      capacityLabel: "3人固定",
    });
    expect(presentation.parameters.groupConfirmSize.fixedValueLabel).toBe("3人固定");
    expect(presentation.parameters.lateJoinEase.visible).toBe(false);
    expect(presentation.canvas.confirmedCandidate).toBe("成立した班");
    expect(presentation.summary.confirmedCount).toBe("成立班数");
    expect(presentation.monteCarlo.confirmedUnit).toBe("班");
    expect(presentation.agentStateLabels.joined).toBe("班成立済み");
  });

  it("switches to 班 vocabulary and a range capacity label for a variable 3-4 person group, and reveals lateJoinEase", () => {
    const presentation = resolveClassroomPresentation({ minGroupSize: 3, maxGroupSize: 4 });

    expect(presentation.groupUnit).toMatchObject({
      unitWord: "班",
      isVariableCapacity: true,
      capacityLabel: "3〜4人",
    });
    expect(presentation.parameters.groupConfirmSize.fixedValueLabel).toBe("3〜4人");
    // 3〜4人班では、成立済みだが空きのある班への参加しやすさとして意味を持つため表示する
    expect(presentation.parameters.lateJoinEase.visible).toBe(true);
    expect(presentation.parameters.lateJoinEase.editable).toBe(true);
    expect(presentation.monteCarlo.showLateJoinMetric).toBe(true);
  });

  it("leaves the static CLASSROOM_PRESENTATION and AFTER_PARTY_PRESENTATION untouched", () => {
    expect(CLASSROOM_PRESENTATION.groupUnit).toEqual({
      minGroupSize: 2,
      maxGroupSize: 2,
      unitWord: "ペア",
      isVariableCapacity: false,
      capacityLabel: "2人固定",
    });
    expect(AFTER_PARTY_PRESENTATION.groupUnit).toBeUndefined();
  });

  it("resolves getScenarioPresentation('standingParty') to STANDING_PARTY_PRESENTATION, not AFTER_PARTY_PRESENTATION (Issue #174)", () => {
    expect(getScenarioPresentation("standingParty")).toBe(STANDING_PARTY_PRESENTATION);
    expect(STANDING_PARTY_PRESENTATION.id).toBe("standingParty");
    expect(STANDING_PARTY_PRESENTATION).not.toBe(AFTER_PARTY_PRESENTATION);
  });
});
