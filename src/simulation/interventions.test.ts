import { describe, expect, it } from "vitest";
import {
  applyInterventionParamAdjustments,
  getInterventionById,
  INTERVENTION_SCENARIOS,
} from "./interventions";
import { DEFAULT_PARAMS } from "./presets";
import type { SimParams } from "./types";

describe("INTERVENTION_SCENARIOS", () => {
  it("has no duplicate ids", () => {
    const ids = INTERVENTION_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes a 'none' scenario", () => {
    const none = INTERVENTION_SCENARIOS.find((s) => s.id === "none");
    expect(none).toBeDefined();
  });

  it("gives every scenario a name, description, and expectedEffect", () => {
    for (const scenario of INTERVENTION_SCENARIOS) {
      expect(scenario.name.length).toBeGreaterThan(0);
      expect(scenario.description.length).toBeGreaterThan(0);
      expect(scenario.expectedEffect.length).toBeGreaterThan(0);
    }
  });

  it("includes the 6 candidate scenarios named in the roadmap issue", () => {
    const ids = INTERVENTION_SCENARIOS.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "explicit-meeting-point",
        "late-join-ok",
        "light-observer-invitation",
        "short-ambiguity-window",
        "predecided-venue",
        "anonymous-low-pressure-intent",
      ]),
    );
  });
});

describe("getInterventionById", () => {
  it("returns the matching scenario", () => {
    expect(getInterventionById("late-join-ok").id).toBe("late-join-ok");
  });

  it("falls back to 'none' for an unknown id", () => {
    expect(getInterventionById("unknown-id" as never).id).toBe("none");
  });
});

describe("applyInterventionParamAdjustments", () => {
  it("does not mutate the input params", () => {
    const params: SimParams = { ...DEFAULT_PARAMS };
    const snapshot = { ...params };
    const intervention = getInterventionById("late-join-ok");

    applyInterventionParamAdjustments(params, intervention);

    expect(params).toEqual(snapshot);
  });

  it("returns params unchanged (by value) for the 'none' intervention", () => {
    const result = applyInterventionParamAdjustments(DEFAULT_PARAMS, getInterventionById("none"));
    expect(result).toEqual(DEFAULT_PARAMS);
  });

  it("applies additive adjustments on top of the given params", () => {
    const result = applyInterventionParamAdjustments(DEFAULT_PARAMS, getInterventionById("late-join-ok"));
    expect(result.lateJoinEase).toBeCloseTo(DEFAULT_PARAMS.lateJoinEase + 0.3);
  });

  it("clamps unit-range fields to [0, 1] after adjustment", () => {
    const nearMax: SimParams = { ...DEFAULT_PARAMS, lateJoinEase: 0.95 };
    const result = applyInterventionParamAdjustments(nearMax, getInterventionById("late-join-ok"));
    expect(result.lateJoinEase).toBe(1);
  });
});
