import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InformationPropagationPanel } from "./InformationPropagationPanel";
import { DEFAULT_INFORMATION_PROPAGATION_CONFIG } from "../simulation/informationState";
import type { Agent, SimulationState } from "../simulation/types";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "a", label: "A", x: 40, y: 40, vx: 0, vy: 0, willingness: 0.5, initiative: 0.5,
    ambiguityTolerance: 0.5, influenceAvoidance: 0.5, conformity: 0.5, leaveThreshold: 0.5,
    isObserverJoiner: false, state: "undecided", stress: 0, ...overrides,
  };
}

function state(): SimulationState {
  return {
    tick: 0, seed: 1, agents: [agent({}), agent({ id: "oj", label: "OJ", isObserverJoiner: true })],
    groupCandidates: [], log: [], width: 800, height: 520, finished: false, formationScenarioId: "standingParty",
  };
}

describe("InformationPropagationPanel (Issue #234)", () => {
  it("有効runで共通filter、Inspector、network、lineage、timeline、statisticsの入口を描画する", () => {
    const html = renderToStaticMarkup(createElement(InformationPropagationPanel, {
      state: state(), config: { ...DEFAULT_INFORMATION_PROPAGATION_CONFIG, enabled: true },
    }));
    expect(html).toContain('data-testid="information-propagation"');
    expect(html).toContain('data-testid="information-propagation-filters"');
    expect(html).toContain('data-testid="information-propagation-inspector"');
    expect(html).toContain("接触networkの線は「同席」");
    expect(html).toContain("未接触（状態recordなし）");
  });

  it("無効runではPhase 5 eventが生成されないことを明示する", () => {
    const html = renderToStaticMarkup(createElement(InformationPropagationPanel, {
      state: state(), config: DEFAULT_INFORMATION_PROPAGATION_CONFIG,
    }));
    expect(html).toContain('data-testid="information-propagation-disabled"');
    expect(html).toContain("情報状態・伝播eventは生成されていません");
  });
});
