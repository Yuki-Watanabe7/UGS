import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulationCanvas } from "./SimulationCanvas";
import type { Agent } from "../simulation/types";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-a",
    label: "A",
    x: 400,
    y: 260,
    vx: 0,
    vy: 0,
    willingness: 0.5,
    initiative: 0.3,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.3,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "undecided",
    stress: 0,
    ...overrides,
  };
}

describe("SimulationCanvas thought bubbles", () => {
  const baseProps = { groupCandidates: [], width: 800, height: 520 };

  it("renders no thought-bubble markup when thoughts is omitted", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, { ...baseProps, agents: [makeAgent({})] }),
    );
    expect(html).not.toContain("thought-bubble");
  });

  it("renders no thought-bubble markup when thoughts is an empty array", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, { ...baseProps, agents: [makeAgent({})], thoughts: [] }),
    );
    expect(html).not.toContain("thought-bubble");
  });

  it("renders a bubble anchored near the target agent when a thought is provided", () => {
    const agent = makeAgent({ id: "agent-a", x: 123, y: 200 });
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents: [agent],
        thoughts: [{ agentId: "agent-a", text: "もう帰ろう" }],
      }),
    );
    expect(html).toContain("thought-bubble");
    expect(html).toContain("もう帰ろう");
  });

  it("silently skips a thought whose agentId no longer exists in agents", () => {
    const agent = makeAgent({ id: "agent-a" });
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents: [agent],
        thoughts: [{ agentId: "agent-missing", text: "もう帰ろう" }],
      }),
    );
    expect(html).not.toContain("thought-bubble");
  });
});
