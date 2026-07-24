import { describe, expect, it } from "vitest";
import {
  getPresetForScenario,
  getPresetsForScenario,
  getScenarioById,
} from "./scenarios";

describe("scenario category configuration", () => {
  it("keeps after-party, classroom, and standing-party presets separated", () => {
    const afterParty = getScenarioById("after-party");
    const classroom = getScenarioById("classroom");
    const standingParty = getScenarioById("standing-party");

    expect(getPresetsForScenario(afterParty).map((preset) => preset.id)).toEqual([
      "natural",
      "ambiguous-dissolve",
      "strong-leader",
      "late-join-culture",
      "leftover-free-grouping",
    ]);
    expect(getPresetsForScenario(classroom).map((preset) => preset.id)).toEqual([
      "classroom-pair",
      "classroom-group-3",
      "classroom-group-4",
      "classroom-group-3-4",
    ]);
    expect(getPresetsForScenario(standingParty).map((preset) => preset.id)).toEqual(["standing-party"]);
  });

  it("uses category-specific initial presets and rejects a contradictory preset", () => {
    const afterParty = getScenarioById("after-party");
    const classroom = getScenarioById("classroom");
    const standingParty = getScenarioById("standing-party");

    expect(getPresetForScenario(afterParty, afterParty.initialPresetId).id).toBe("natural");
    expect(getPresetForScenario(classroom, classroom.initialPresetId).id).toBe("classroom-pair");
    expect(getPresetForScenario(classroom, "natural").id).toBe("classroom-pair");
    expect(getPresetForScenario(standingParty, standingParty.initialPresetId).id).toBe("standing-party");
    // 未対応プリセットidを渡しても、そのシナリオの初期プリセットへフォールバックする
    expect(getPresetForScenario(standingParty, "natural").id).toBe("standing-party");
  });

  it("resolves standing-party's own formation policy (not silently aliased to afterParty)", () => {
    const standingParty = getScenarioById("standing-party");
    const preset = getPresetForScenario(standingParty, standingParty.initialPresetId);
    expect(preset.formationScenarioId).toBe("standingParty");
    expect(standingParty.presentation.id).toBe("standingParty");
  });
});
