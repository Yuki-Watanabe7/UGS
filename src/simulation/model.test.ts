import { describe, expect, it } from "vitest";
import { createInitialAgents } from "./model";
import { DEFAULT_PARAMS, PRESETS, getPresetById } from "./presets";

describe("createInitialAgents", () => {
  it("is deterministic for the same seed", () => {
    const a = createInitialAgents(42, DEFAULT_PARAMS);
    const b = createInitialAgents(42, DEFAULT_PARAMS);
    expect(a).toEqual(b);
  });

  it("produces different layouts for different seeds", () => {
    const a = createInitialAgents(1, DEFAULT_PARAMS);
    const b = createInitialAgents(2, DEFAULT_PARAMS);
    expect(a).not.toEqual(b);
  });

  it("includes exactly one observerJoiner for a small population", () => {
    const agents = createInitialAgents(7, { ...DEFAULT_PARAMS, populationSize: 12 });
    const observers = agents.filter((a) => a.isObserverJoiner);
    expect(observers).toHaveLength(1);
    expect(observers[0].willingness).toBeCloseTo(0.8);
    expect(observers[0].initiative).toBeCloseTo(0.1);
  });

  it("applies observer-specific parameters to the observerJoiner agent", () => {
    const agents = createInitialAgents(3, {
      ...DEFAULT_PARAMS,
      populationSize: 10,
      observerAmbiguityTolerance: 0.1,
      observerInfluenceAvoidance: 0.95,
      observerLeaveEase: 0.7,
    });
    const observer = agents.find((a) => a.isObserverJoiner)!;
    expect(observer.ambiguityTolerance).toBeCloseTo(0.1);
    expect(observer.influenceAvoidance).toBeCloseTo(0.95);
    expect(observer.leaveThreshold).toBeCloseTo(0.3);
  });

  it("assigns more designated leaders when numLeaders is higher", () => {
    const withoutLeaders = createInitialAgents(9, { ...DEFAULT_PARAMS, populationSize: 16, numLeaders: 0 });
    const withLeaders = createInitialAgents(9, { ...DEFAULT_PARAMS, populationSize: 16, numLeaders: 3 });

    const highInitiativeCount = (agents: typeof withLeaders) =>
      agents.filter((a) => !a.isObserverJoiner && a.initiative > 0.65).length;

    expect(highInitiativeCount(withLeaders)).toBeGreaterThan(highInitiativeCount(withoutLeaders));
  });

  it("clusters agents into cliques when existingTieStrength is high", () => {
    const agents = createInitialAgents(5, { ...DEFAULT_PARAMS, populationSize: 16, existingTieStrength: 0.9 });
    const withClique = agents.filter((a) => a.cliqueId !== undefined);
    expect(withClique.length).toBeGreaterThan(0);
  });

  it("keeps every agent unaffiliated when existingTieStrength is low", () => {
    const agents = createInitialAgents(5, { ...DEFAULT_PARAMS, populationSize: 16, existingTieStrength: 0.1 });
    expect(agents.every((a) => a.cliqueId === undefined)).toBe(true);
  });
});

describe("presets", () => {
  it("exposes the five required afterParty scenario presets, plus the classroomPair preset (Issue #132)", () => {
    const afterPartyPresets = PRESETS.filter((p) => (p.formationScenarioId ?? "afterParty") === "afterParty");
    expect(afterPartyPresets).toHaveLength(5);
    expect(PRESETS.some((p) => p.formationScenarioId === "classroomPair")).toBe(true);
  });

  it("falls back to the first preset for an unknown id", () => {
    expect(getPresetById("does-not-exist").id).toBe(PRESETS[0].id);
  });
});
