import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ObserverJoinerInspector } from "./ObserverJoinerInspector";
import { createSpeechEvent } from "../simulation/speech";
import { DEFAULT_PARAMS } from "../simulation/presets";
import type { Agent, SimulationState } from "../simulation/types";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    label: "X",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    willingness: 0.5,
    initiative: 0.5,
    ambiguityTolerance: 0.5,
    influenceAvoidance: 0.5,
    conformity: 0.5,
    leaveThreshold: 0.5,
    isObserverJoiner: false,
    state: "undecided",
    stress: 0,
    ...overrides,
  };
}

function makeState(overrides: Partial<SimulationState>): SimulationState {
  return {
    tick: 0,
    agents: [],
    groupCandidates: [],
    log: [],
    width: 800,
    height: 520,
    finished: false,
    ...overrides,
  };
}

function render(state: SimulationState) {
  return renderToStaticMarkup(createElement(ObserverJoinerInspector, { state, params: DEFAULT_PARAMS }));
}

describe("ObserverJoinerInspector speech history", () => {
  it("shows an empty-state message when the observerJoiner has no related speech yet", () => {
    const observer = makeAgent({ id: "observer", label: "Observer", isObserverJoiner: true });
    const html = render(makeState({ agents: [observer] }));

    expect(html).toContain("まだ関連する発言はありません");
  });

  it("renders a speech entry where the observerJoiner is the speaker, tagged as 話者", () => {
    const observer = makeAgent({ id: "observer", label: "Observer", isObserverJoiner: true });
    const event = createSpeechEvent({
      tick: 3,
      speakerId: "observer",
      intent: "greet",
      reason: "joinGreeting",
      audience: "nearby",
    });
    const html = render(makeState({ agents: [observer], speechLog: [event] }));

    expect(html).toContain("話者");
    expect(html).toContain("合流できた、よろしく!");
  });

  it("renders a speech entry where the observerJoiner is the explicit target, tagged as 対象", () => {
    const observer = makeAgent({ id: "observer", label: "Observer", isObserverJoiner: true });
    const helper = makeAgent({ id: "helper", label: "Helper" });
    const event = createSpeechEvent({
      tick: 4,
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "observer",
    });
    const html = render(makeState({ agents: [observer, helper], speechLog: [event] }));

    expect(html).toContain("対象");
    expect(html).toContain("Helper");
  });

  it("does not show speech events unrelated to the observerJoiner", () => {
    const observer = makeAgent({ id: "observer", label: "Observer", isObserverJoiner: true });
    const event = createSpeechEvent({
      tick: 4,
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "someone-else",
    });
    const html = render(makeState({ agents: [observer], speechLog: [event] }));

    expect(html).toContain("まだ関連する発言はありません");
  });
});
