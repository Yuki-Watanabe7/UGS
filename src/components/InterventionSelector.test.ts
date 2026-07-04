import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InterventionSelector } from "./InterventionSelector";
import { INTERVENTION_SCENARIOS } from "../simulation/interventions";

describe("InterventionSelector", () => {
  it("renders an option for every intervention scenario, including none", () => {
    const html = renderToStaticMarkup(
      createElement(InterventionSelector, {
        interventionId: "none",
        onInterventionChange: () => {},
      }),
    );

    for (const scenario of INTERVENTION_SCENARIOS) {
      expect(html).toContain(scenario.name);
    }
    expect(html).toContain('value="none"');
  });

  it("shows only the description (no expected effect) when none is selected", () => {
    const html = renderToStaticMarkup(
      createElement(InterventionSelector, {
        interventionId: "none",
        onInterventionChange: () => {},
      }),
    );

    expect(html).toContain("場の設計に対する介入を何も行わない");
    expect(html).not.toContain("期待される効果");
  });

  it("shows the description, expected effect, and likely metrics for a selected scenario", () => {
    const html = renderToStaticMarkup(
      createElement(InterventionSelector, {
        interventionId: "light-observer-invitation",
        onInterventionChange: () => {},
      }),
    );

    expect(html).toContain("observerJoinerへの軽い声かけ");
    expect(html).toContain("期待される効果");
    expect(html).toContain("効きやすい観察指標");
  });
});
