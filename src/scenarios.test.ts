import { describe, expect, it } from "vitest";
import {
  getPresetForScenario,
  getPresetsForScenario,
  getScenarioById,
} from "./scenarios";

describe("scenario category configuration", () => {
  it("keeps after-party and classroom presets separated", () => {
    const afterParty = getScenarioById("after-party");
    const classroom = getScenarioById("classroom");

    expect(getPresetsForScenario(afterParty).map((preset) => preset.id)).toEqual([
      "natural",
      "ambiguous-dissolve",
      "strong-leader",
      "late-join-culture",
      "leftover-free-grouping",
    ]);
    expect(getPresetsForScenario(classroom).map((preset) => preset.id)).toEqual([
      "classroom-pair",
    ]);
  });

  it("uses category-specific initial presets and rejects a contradictory preset", () => {
    const afterParty = getScenarioById("after-party");
    const classroom = getScenarioById("classroom");

    expect(getPresetForScenario(afterParty, afterParty.initialPresetId).id).toBe("natural");
    expect(getPresetForScenario(classroom, classroom.initialPresetId).id).toBe("classroom-pair");
    expect(getPresetForScenario(classroom, "natural").id).toBe("classroom-pair");
  });
});
