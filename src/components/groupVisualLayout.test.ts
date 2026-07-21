import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, GroupCandidate } from "../simulation/types";
import { createInitialState, stepSimulation } from "../simulation/engine";
import { getPresetById } from "../simulation/presets";
import { SeededRandom } from "../simulation/random";
import { SimulationCanvas } from "./SimulationCanvas";
import {
  deriveGroupVisualLayout,
  isEvacuatedClassroomCandidate,
  reconcileGroupVisualSlots,
  updateGroupVisualSlotRegistry,
} from "./groupVisualLayout";

function makeAgent(id: string, x: number, y: number): Agent {
  return {
    id,
    label: id,
    x,
    y,
    vx: 0,
    vy: 0,
    willingness: 0.5,
    initiative: 0.5,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.5,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "joined",
    joinedGroupId: id.split("-member")[0],
    stress: 0,
  };
}

function makeCandidate(
  index: number,
  memberCount = 2,
  overrides: Partial<GroupCandidate> = {},
): GroupCandidate {
  return {
    id: `pair-${index}`,
    x: 350 + (index % 2) * 4,
    y: 250 + (index % 3) * 3,
    memberIds: Array.from({ length: memberCount }, (_, member) => `pair-${index}-member-${member}`),
    status: "confirmed",
    age: index,
    minGroupSize: memberCount,
    maxGroupSize: memberCount,
    ...overrides,
  };
}

function slotsFor(candidates: readonly GroupCandidate[]): Map<string, number> {
  return reconcileGroupVisualSlots(new Map(), candidates.map((candidate) => candidate.id));
}

function layoutFor(
  candidates: readonly GroupCandidate[],
  width = 800,
  height = 520,
  viewportWidth = width,
) {
  const agents = candidates.flatMap((candidate) =>
    candidate.memberIds.map((memberId, memberIndex) =>
      makeAgent(memberId, candidate.x + memberIndex * 8 - 4, candidate.y + 2),
    ),
  );
  return deriveGroupVisualLayout({
    agents,
    groupCandidates: candidates,
    width,
    height,
    formationScenarioId: "classroomPair",
    slotAssignments: slotsFor(candidates),
    viewportWidth,
  });
}

describe("group visual layout eligibility and slot stability", () => {
  it("evacuates only full confirmed classroom groups", () => {
    expect(isEvacuatedClassroomCandidate(makeCandidate(0), "classroomPair")).toBe(true);
    expect(
      isEvacuatedClassroomCandidate(makeCandidate(0, 1, { maxGroupSize: 2 }), "classroomPair"),
    ).toBe(false);
    expect(
      isEvacuatedClassroomCandidate(makeCandidate(0, 2, { status: "forming" }), "classroomPair"),
    ).toBe(false);
    expect(
      isEvacuatedClassroomCandidate(makeCandidate(0, 2, { status: "dissolving" }), "classroomPair"),
    ).toBe(false);
    expect(isEvacuatedClassroomCandidate(makeCandidate(0), "afterParty")).toBe(false);
  });

  it("resolves the fallback max group size from classroomGroupSize instead of always assuming 2 (Issue #155)", () => {
    // engine.tsは実運用でGroupCandidate.maxGroupSizeを書き込まないため、候補側にオーバーライドが
    // ない場合はclassroomGroupSizeへフォールバックする。classroomGroupSizeを渡し忘れると常に
    // 2人固定にフォールバックしてしまい(既存の後方互換の既定値)、3〜4人班の3人成立・空きあり
    // 状態が「満員」として誤って退避されてしまう。classroomGroupSizeを渡せばそれを正しく防げる。
    const threeMemberConfirmed = makeCandidate(0, 3, { minGroupSize: undefined, maxGroupSize: undefined });

    expect(isEvacuatedClassroomCandidate(threeMemberConfirmed, "classroomPair")).toBe(true);
    expect(
      isEvacuatedClassroomCandidate(threeMemberConfirmed, "classroomPair", { minGroupSize: 3, maxGroupSize: 4 }),
    ).toBe(false);
    expect(
      isEvacuatedClassroomCandidate(
        { ...threeMemberConfirmed, memberIds: ["m0", "m1", "m2", "m3"] },
        "classroomPair",
        { minGroupSize: 3, maxGroupSize: 4 },
      ),
    ).toBe(true);
    // classroomGroupSize省略時は既存どおり2人固定へフォールバックする(後方互換)
    expect(
      isEvacuatedClassroomCandidate(makeCandidate(0, 2, { minGroupSize: undefined, maxGroupSize: undefined }), "classroomPair"),
    ).toBe(true);
  });

  it("keeps existing slots across candidate reordering and does not reuse disappeared slots in one run", () => {
    const first = reconcileGroupVisualSlots(new Map(), ["pair-a", "pair-b"]);
    const reordered = reconcileGroupVisualSlots(first, ["pair-b", "pair-a", "pair-c"]);
    const afterDisappearance = reconcileGroupVisualSlots(reordered, ["pair-d"]);

    expect([...reordered.entries()]).toEqual([
      ["pair-a", 0],
      ["pair-b", 1],
      ["pair-c", 2],
    ]);
    expect(afterDisappearance.get("pair-d")).toBe(3);
    expect(reconcileGroupVisualSlots(new Map(), ["pair-d"]).get("pair-d")).toBe(0);
  });

  it("resets assignments when runId/scenario reset key changes", () => {
    const firstRun = updateGroupVisualSlotRegistry(
      { resetKey: "classroomPair:1", assignments: new Map() },
      "classroomPair:1",
      ["pair-a", "pair-b"],
    );
    const secondRun = updateGroupVisualSlotRegistry(
      firstRun,
      "classroomPair:2",
      ["pair-b"],
    );

    expect(firstRun.assignments.get("pair-b")).toBe(1);
    expect([...secondRun.assignments.entries()]).toEqual([["pair-b", 0]]);
  });

  it("keeps an existing slot coordinate unchanged when later groups become confirmed", () => {
    const firstCandidate = makeCandidate(0);
    const one = layoutFor([firstCandidate]);
    const ten = layoutFor(Array.from({ length: 10 }, (_, index) => makeCandidate(index)));

    expect(ten.candidates.get(firstCandidate.id)?.center).toEqual(
      one.candidates.get(firstCandidate.id)?.center,
    );
  });
});

describe("group visual layout collision avoidance", () => {
  it("handles zero and one confirmed group", () => {
    const empty = layoutFor([]);
    const one = layoutFor([makeCandidate(0)]);

    expect(empty.resolvedRegion).toBeUndefined();
    expect(one.resolvedRegion?.overflowCount).toBe(0);
    expect(one.candidates.get("pair-0")).toMatchObject({
      slotIndex: 0,
      isEvacuated: true,
      isVisible: true,
    });
  });

  it("places ten pairs on PC width with safe, in-bounds, non-intersecting rings", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => makeCandidate(index));
    const layout = layoutFor(candidates);
    const visible = candidates.map((candidate) => layout.candidates.get(candidate.id)!);

    expect(layout.resolvedRegion).toMatchObject({ columns: 10, overflowCount: 0 });
    for (const candidate of visible) {
      expect(candidate.isVisible).toBe(true);
      expect(candidate.center.x - candidate.displayRadius).toBeGreaterThanOrEqual(0);
      expect(candidate.center.x + candidate.displayRadius).toBeLessThanOrEqual(800);
      expect(candidate.center.y - candidate.displayRadius).toBeGreaterThanOrEqual(0);
      expect(candidate.center.y + candidate.displayRadius).toBeLessThanOrEqual(520);
    }
    for (let first = 0; first < visible.length; first += 1) {
      for (let second = first + 1; second < visible.length; second += 1) {
        const a = visible[first];
        const b = visible[second];
        expect(Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)).toBeGreaterThanOrEqual(
          a.displayRadius + b.displayRadius + 12,
        );
      }
    }
  });

  it("wraps ten groups on narrow width without leaving overlapping rings", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => makeCandidate(index, 4));
    const layout = layoutFor(candidates, 320, 520, 320);
    const visible = candidates.map((candidate) => layout.candidates.get(candidate.id)!);

    expect(layout.resolvedRegion).toMatchObject({ columns: 4, overflowCount: 0 });
    expect(new Set(visible.map((candidate) => candidate.center.y)).size).toBe(3);
    for (let first = 0; first < visible.length; first += 1) {
      const a = visible[first];
      expect(a.center.x - a.displayRadius).toBeGreaterThanOrEqual(0);
      expect(a.center.x + a.displayRadius).toBeLessThanOrEqual(320);
      for (let second = first + 1; second < visible.length; second += 1) {
        const b = visible[second];
        expect(Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y)).toBeGreaterThanOrEqual(
          a.displayRadius + b.displayRadius + 11.9,
        );
      }
    }
  });

  it("expands three/four-member group rings within their safe slot bounds", () => {
    const pair = layoutFor([makeCandidate(0, 2)]).candidates.get("pair-0")!;
    const triple = layoutFor([makeCandidate(0, 3)]).candidates.get("pair-0")!;
    const quartet = layoutFor([makeCandidate(0, 4)]).candidates.get("pair-0")!;

    expect(triple.displayRadius).toBeGreaterThan(pair.displayRadius);
    expect(quartet.displayRadius).toBeGreaterThanOrEqual(triple.displayRadius);
  });

  it("uses an explicit overflow fallback instead of drawing beyond safe capacity", () => {
    const candidates = Array.from({ length: 41 }, (_, index) => makeCandidate(index));
    const layout = layoutFor(candidates);

    expect(layout.resolvedRegion).toMatchObject({ visibleCapacity: 40, overflowCount: 1 });
    expect(layout.candidates.get("pair-40")?.isVisible).toBe(false);
    expect(layout.agents.get("pair-40-member-0")?.isVisible).toBe(false);
  });
});

describe("group visual layout non-interference", () => {
  it("is reproducible and does not mutate agents or candidates", () => {
    const candidates = Array.from({ length: 4 }, (_, index) => makeCandidate(index));
    const agents = candidates.flatMap((candidate) =>
      candidate.memberIds.map((memberId, memberIndex) =>
        makeAgent(memberId, candidate.x + memberIndex * 8 - 4, candidate.y),
      ),
    );
    const before = JSON.stringify({ agents, candidates });
    const input = {
      agents,
      groupCandidates: candidates,
      width: 800,
      height: 520,
      formationScenarioId: "classroomPair" as const,
      slotAssignments: slotsFor(candidates),
    };

    expect(deriveGroupVisualLayout(input)).toEqual(deriveGroupVisualLayout(input));
    expect(JSON.stringify({ agents, candidates })).toBe(before);
  });

  it("applies the candidate offset to nearby members and keeps them inside the visual ring", () => {
    const candidate = makeCandidate(0, 2, { x: 400, y: 260 });
    const near = makeAgent(candidate.memberIds[0], 394, 263);
    const far = makeAgent(candidate.memberIds[1], 700, 500);
    const layout = deriveGroupVisualLayout({
      agents: [near, far],
      groupCandidates: [candidate],
      width: 800,
      height: 520,
      formationScenarioId: "classroomPair",
      slotAssignments: slotsFor([candidate]),
    });
    const candidateLayout = layout.candidates.get(candidate.id)!;
    const nearVisual = layout.agents.get(near.id)!;
    const farVisual = layout.agents.get(far.id)!;

    expect(nearVisual.offset).toEqual(candidateLayout.offset);
    expect(
      Math.hypot(farVisual.x - candidateLayout.center.x, farVisual.y - candidateLayout.center.y),
    ).toBeLessThan(candidateLayout.displayRadius);
  });

  it("leaves every after-party visual coordinate and radius unchanged", () => {
    const candidate = makeCandidate(0);
    const agent = makeAgent(candidate.memberIds[0], 123, 234);
    const layout = deriveGroupVisualLayout({
      agents: [agent],
      groupCandidates: [candidate],
      width: 800,
      height: 520,
      formationScenarioId: "afterParty",
      slotAssignments: slotsFor([candidate]),
    });

    expect(layout.resolvedRegion).toBeUndefined();
    expect(layout.candidates.get(candidate.id)).toMatchObject({
      center: { x: candidate.x, y: candidate.y },
      displayRadius: 54,
      isEvacuated: false,
    });
    expect(layout.agents.get(agent.id)).toMatchObject({ x: 123, y: 234, isEvacuated: false });
  });

  it("keeps the classroom state series, finish tick, and PRNG consumption identical with Canvas rendering on/off", () => {
    const preset = getPresetById("classroom-pair");
    const formation = {
      scenarioId: "classroomPair" as const,
      formationDeadlineTick: preset.formationDeadlineTick,
    };
    const run = (renderCanvas: boolean) => {
      const seed = 149;
      const rng = new SeededRandom(seed);
      let state = createInitialState(
        seed,
        preset.params,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        formation,
      );
      const states = [state];
      while (!state.finished && state.tick < 400) {
        if (renderCanvas) {
          renderToStaticMarkup(
            createElement(SimulationCanvas, {
              agents: state.agents,
              groupCandidates: state.groupCandidates,
              width: state.width,
              height: state.height,
              formationScenarioId: state.formationScenarioId,
              runId: 1,
            }),
          );
        }
        state = stepSimulation(
          state,
          preset.params,
          rng,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          formation,
        );
        states.push(state);
      }
      return { states, rngProbe: rng.next() };
    };

    const withoutCanvas = run(false);
    const withCanvas = run(true);
    expect(withCanvas.states).toEqual(withoutCanvas.states);
    expect(withCanvas.states.at(-1)?.tick).toBe(withoutCanvas.states.at(-1)?.tick);
    expect(withCanvas.rngProbe).toBe(withoutCanvas.rngProbe);
  });
});
