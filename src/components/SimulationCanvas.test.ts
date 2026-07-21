import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SimulationCanvas } from "./SimulationCanvas";
import type { Agent, GroupCandidate } from "../simulation/types";

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

describe("SimulationCanvas speech bubbles", () => {
  const baseProps = { groupCandidates: [], width: 800, height: 520 };

  it("renders no speech-bubble markup when speeches is omitted", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, { ...baseProps, agents: [makeAgent({})] }),
    );
    expect(html).not.toContain("speech-bubble");
  });

  it("renders no speech-bubble markup when speeches is an empty array", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, { ...baseProps, agents: [makeAgent({})], speeches: [] }),
    );
    expect(html).not.toContain("speech-bubble");
  });

  it("renders a speech bubble anchored near the speaking agent when a speech is provided", () => {
    const agent = makeAgent({ id: "agent-a", x: 123, y: 200 });
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents: [agent],
        speeches: [{ agentId: "agent-a", text: "💬もう一軒行く?" }],
      }),
    );
    expect(html).toContain("speech-bubble-box");
    expect(html).toContain("もう一軒行く?");
  });

  it("silently skips a speech whose agentId no longer exists in agents", () => {
    const agent = makeAgent({ id: "agent-a" });
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents: [agent],
        speeches: [{ agentId: "agent-missing", text: "💬もう一軒行く?" }],
      }),
    );
    expect(html).not.toContain("speech-bubble");
  });

  it("renders both a thought bubble for one agent and a speech bubble for another simultaneously", () => {
    const agents = [
      makeAgent({ id: "agent-a", x: 200, y: 200 }),
      makeAgent({ id: "agent-b", x: 600, y: 400 }),
    ];
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents,
        thoughts: [{ agentId: "agent-a", text: "様子を見よう" }],
        speeches: [{ agentId: "agent-b", text: "💬もう一軒行く?" }],
      }),
    );
    expect(html).toContain("thought-bubble-box");
    expect(html).toContain("speech-bubble-box");
  });

  it("suppresses the thought bubble for an agent that also has an active speech bubble (speech takes priority)", () => {
    const agent = makeAgent({ id: "agent-a", x: 300, y: 260 });
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents: [agent],
        thoughts: [{ agentId: "agent-a", text: "様子を見よう" }],
        speeches: [{ agentId: "agent-a", text: "💬もう一軒行く?" }],
      }),
    );
    expect(html).toContain("speech-bubble-box");
    expect(html).not.toContain("thought-bubble-box");
    expect(html).toContain("もう一軒行く?");
    expect(html).not.toContain("様子を見よう");
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

describe("SimulationCanvas classroom pair progress", () => {
  const candidate = (overrides: Partial<GroupCandidate> = {}): GroupCandidate => ({
    id: "pair-candidate-a",
    x: 300,
    y: 220,
    memberIds: ["founder"],
    status: "forming",
    age: 1,
    minGroupSize: 2,
    maxGroupSize: 2,
    ...overrides,
  });
  const baseProps = { formationScenarioId: "classroomPair" as const, width: 800, height: 520 };

  it("shows a one-person candidate as waiting with its current/max count and open slot", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents: [makeAgent({ id: "founder", state: "forming" })],
        groupCandidates: [candidate()],
      }),
    );

    expect(html).toContain('data-candidate-state="waiting"');
    expect(html).toContain("相手待ち");
    expect(html).toContain("1/2・空き1");
  });

  it("shows an approaching agent, the target mapping line, and the approacher name", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents: [
          makeAgent({ id: "founder", state: "forming" }),
          makeAgent({ id: "joiner", label: "参加者B", state: "approaching", joinedGroupId: "pair-candidate-a" }),
        ],
        groupCandidates: [candidate()],
      }),
    );

    expect(html).toContain('data-candidate-state="approaching"');
    expect(html).toContain("接近者あり");
    expect(html).toContain("approach-link");
    expect(html).toContain("参加者Bからペア候補 pair-candidate-a への接近");
    expect(html).toContain("接近: 参加者B");
  });

  it("distinguishes full and resolved candidates", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents: [],
        groupCandidates: [
          candidate({ id: "full-pair", status: "confirmed", memberIds: ["a", "b"] }),
          candidate({ id: "expired-pair", status: "expired" }),
        ],
      }),
    );

    expect(html).toContain('data-candidate-state="full"');
    expect(html).toContain("ペア確定・満員");
    expect(html).toContain("2/2・空き0");
    expect(html).toContain('data-candidate-state="resolved"');
    expect(html).toContain("解消済み");
  });

  it("evacuates a confirmed full pair and its members into a numbered resolved-area slot", () => {
    const agents = [
      makeAgent({ id: "a", label: "生徒A", x: 295, y: 220, state: "joined", joinedGroupId: "full-pair" }),
      makeAgent({ id: "b", label: "生徒B", x: 305, y: 220, state: "joined", joinedGroupId: "full-pair" }),
    ];
    const candidates = [
      candidate({ id: "full-pair", x: 300, y: 220, status: "confirmed", memberIds: ["a", "b"] }),
    ];
    const before = JSON.stringify({ agents, candidates });
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents,
        groupCandidates: candidates,
        thoughts: [{ agentId: "a", text: "決まってよかった" }],
        speeches: [{ agentId: "b", text: "💬よろしくね" }],
      }),
    );

    expect(html).toContain("成立済みのペア");
    expect(html).toContain("相手を探している生徒");
    expect(html).toContain('data-evacuated="true"');
    expect(html).toContain('data-visual-slot="1"');
    expect(html).toContain('data-visual-candidate="full-pair"');
    expect(html).toContain("成立済み #1");
    expect(html).toContain("#1 full-pair");
    expect(html).toContain("決まってよかった");
    expect(html).toContain("よろしくね");
    expect(JSON.stringify({ agents, candidates })).toBe(before);
  });

  it("leaves a forming candidate and approaching link at simulation coordinates", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents: [
          makeAgent({ id: "founder", state: "forming" }),
          makeAgent({ id: "joiner", state: "approaching", x: 500, y: 300, joinedGroupId: "forming-pair" }),
        ],
        groupCandidates: [candidate({ id: "forming-pair", x: 300, y: 220 })],
      }),
    );

    expect(html).not.toContain('data-evacuated="true"');
    expect(html).toContain('cx="300" cy="220" r="54"');
    expect(html).toContain('x1="500" y1="300" x2="300" y2="220"');
  });

  it("visually labels searching-again and unassigned agents", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        ...baseProps,
        agents: [
          makeAgent({ id: "retry", state: "undecided", searchRestartCount: 1 }),
          makeAgent({ id: "unassigned", state: "unassigned" }),
        ],
        groupCandidates: [],
      }),
    );

    expect(html).toContain('data-agent-state="searching-again"');
    expect(html).toContain("再探索");
    expect(html).toContain('data-agent-state="unassigned"');
    expect(html).toContain("未割当");
  });

  it("keeps the after-party candidate display unchanged when the classroom scenario is not selected", () => {
    const html = renderToStaticMarkup(
      createElement(SimulationCanvas, {
        width: 800,
        height: 520,
        agents: [
          makeAgent({ id: "founder", state: "forming" }),
          makeAgent({ id: "after-party-retry", state: "undecided", searchRestartCount: 1 }),
        ],
        groupCandidates: [candidate()],
      }),
    );

    expect(html).toContain("形成中の輪 (1)");
    expect(html).not.toContain("canvas-pair-status");
    expect(html).not.toContain("相手待ち");
    expect(html).not.toContain('data-agent-state="searching-again"');
    expect(html).not.toContain("再探索");
  });
});
