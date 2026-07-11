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

  it("renders one bubble per agent when multiple thoughts are provided simultaneously", () => {
    const agents = [
      makeAgent({ id: "agent-a", x: 200, y: 200 }),
      makeAgent({ id: "agent-b", x: 600, y: 400, isObserverJoiner: true }),
    ];
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents,
        thoughts: [
          { agentId: "agent-a", text: "様子を見よう" },
          { agentId: "agent-b", text: "もう帰ろう" },
        ],
      }),
    );
    expect(html.split("thought-bubble-box").length - 1).toBe(2);
    expect(html).toContain("様子を見よう");
    expect(html).toContain("もう帰ろう");
  });
});

describe("SimulationCanvas responsive rendering", () => {
  const baseProps = { groupCandidates: [], width: 800, height: 520 };

  it("renders the SVG at width=100% (scales with its container instead of a fixed pixel width, avoiding horizontal scroll on narrow/iPhone-width screens)", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, { ...baseProps, agents: [makeAgent({})] }),
    );
    expect(html).toContain('width="100%"');
    expect(html).toContain(`viewBox="0 0 ${baseProps.width} ${baseProps.height}"`);
  });

  it("keeps the same width=100%/viewBox contract regardless of the number of active thought bubbles", () => {
    const agents = [
      makeAgent({ id: "agent-a", x: 50, y: 50 }),
      makeAgent({ id: "agent-b", x: 750, y: 470, isObserverJoiner: true }),
    ];
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents,
        thoughts: [
          { agentId: "agent-a", text: "近くに輪が見当たらないな" },
          { agentId: "agent-b", text: "そろそろ潮時かもしれない" },
        ],
      }),
    );
    expect(html).toContain('width="100%"');
  });
});
