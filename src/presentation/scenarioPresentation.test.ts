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
  normalizeInterventionForPresentation,
  resolveScenarioLogMessage,
} from "./scenarioPresentation";

const FORBIDDEN_CLASSROOM_TERMS = ["二次会", "もう一軒", "店", "会場", "帰宅", "途中参加"];

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

describe("scenario presentation: classroom rendering audit", () => {
  it("does not render after-party-only vocabulary or intervention controls on the classroom route", () => {
    const html = renderToStaticMarkup(
      createElement(Router, { initialPathname: "/simulate/classroom" }),
    );

    expectNoClassroomForbiddenTerms(html);
    expect(html).toContain("生徒数");
    expect(html).toContain("ペアの人数: 2人固定");
    expect(html).toContain("自発的に相手を探す意欲");
    expect(html).not.toContain("介入シナリオ");
    expect(html).not.toContain("介入なしとの比較");
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

  it("keeps the existing after-party vocabulary on the after-party route", () => {
    const html = renderToStaticMarkup(
      createElement(Router, { initialPathname: "/simulate/after-party" }),
    );

    expect(html).toContain("二次会成立に必要な人数");
    expect(html).toContain("全体の二次会意欲");
    expect(html).toContain("介入シナリオ");
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
});
