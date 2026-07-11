import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EventLog } from "./EventLog";
import { createSpeechEvent } from "../simulation/speech";
import type { Agent, LogEntry, SimulationState } from "../simulation/types";

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
  return renderToStaticMarkup(createElement(EventLog, { state }));
}

describe("EventLog", () => {
  it("shows the empty message when there is no log or speech history", () => {
    const html = render(makeState({}));

    expect(html).toContain("まだイベントはありません");
  });

  it("renders state log messages as before", () => {
    const log: LogEntry[] = [{ tick: 1, message: "00:03 参加者が集まり始めた", tags: ["simulation"] }];
    const html = render(makeState({ log }));

    expect(html).toContain("00:03 参加者が集まり始めた");
  });

  it("renders speech log entries with a speech-specific class and structured meta line", () => {
    const founder = makeAgent({ id: "founder", label: "A" });
    const event = createSpeechEvent({
      tick: 5,
      speakerId: "founder",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
    });
    const html = render(makeState({ agents: [founder], speechLog: [event] }));

    expect(html).toContain("event-log-entry--speech");
    expect(html).toContain("Aさん");
    expect(html).toContain("もう一軒行く?");
    expect(html).toContain("intent: invite");
    expect(html).toContain("reason: initiativeFormedCore");
  });

  it("interleaves state log and speech log entries in tick order", () => {
    const founder = makeAgent({ id: "founder", label: "A" });
    const log: LogEntry[] = [
      { tick: 1, message: "tick1 state entry", tags: ["simulation"] },
      { tick: 5, message: "tick5 state entry", tags: ["simulation"] },
    ];
    const event = createSpeechEvent({
      tick: 3,
      speakerId: "founder",
      intent: "invite",
      reason: "initiativeFormedCore",
      audience: "nearby",
    });
    const html = render(makeState({ agents: [founder], log, speechLog: [event] }));

    const tick1Index = html.indexOf("tick1 state entry");
    const speechIndex = html.indexOf("もう一軒行く?");
    const tick5Index = html.indexOf("tick5 state entry");

    expect(tick1Index).toBeGreaterThanOrEqual(0);
    expect(speechIndex).toBeGreaterThan(tick1Index);
    expect(tick5Index).toBeGreaterThan(speechIndex);
  });

  it("offers a '発言のみ' filter option in the select", () => {
    const html = render(makeState({}));

    expect(html).toContain("発言のみ");
  });

  it("uses a single compact <select> for filtering (mobile-friendly, no button row)", () => {
    const html = render(makeState({}));

    expect((html.match(/<select/g) ?? []).length).toBe(1);
  });
});
