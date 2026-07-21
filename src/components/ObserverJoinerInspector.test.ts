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

  it("shows an empty-state message for active speech effects when none are active", () => {
    const observer = makeAgent({ id: "observer", label: "Observer", isObserverJoiner: true });
    const html = render(makeState({ agents: [observer] }));

    expect(html).toContain("現在作用中の発言効果はありません");
  });

  it("renders the Phase 3 causal detail block (reception/interpretation/effect) for a related speech event", () => {
    const observer = makeAgent({ id: "observer", label: "Observer", isObserverJoiner: true });
    const helper = makeAgent({ id: "helper", label: "Helper" });
    const event = createSpeechEvent({
      tick: 5,
      speakerId: "helper",
      intent: "invite",
      reason: "lightObserverInvitation",
      target: "observer",
    });
    const state = makeState({
      agents: [observer, helper],
      speechLog: [event],
      speechReceptionLog: [
        {
          id: "reception-1",
          speechEventId: event.id,
          tick: 5,
          receiverId: "observer",
          relation: "target",
          distance: 10,
          threshold: 200,
          heard: true,
          reason: "withinRange",
        },
      ],
      speechInterpretationLog: [
        {
          id: "interpretation-1",
          speechEventId: event.id,
          receptionEventId: "reception-1",
          tick: 5,
          receiverId: "observer",
          intent: "invite",
          relation: "target",
          valence: "positive",
          intensity: 0.5,
          factors: [{ key: "conformity", rawValue: 0.5, normalizedValue: 0.5, contribution: 0.75 }],
        },
      ],
      speechEffectLog: [
        {
          id: "effect-1",
          speechEventId: event.id,
          interpretationEventId: "interpretation-1",
          receiverId: "observer",
          speakerId: "helper",
          intent: "invite",
          reason: "lightObserverInvitation",
          occurredTick: 5,
          appliedTick: 5,
          dimension: "approachProbability",
          outputValue: 0.2,
          durationTicks: 5,
        },
      ],
      activeSpeechEffects: [
        {
          id: "active-effect-1",
          speechEffectEventId: "effect-1",
          speechEventId: event.id,
          speakerId: "helper",
          intent: "invite",
          receiverId: "observer",
          dimension: "approachProbability",
          startedAtTick: 5,
          expiresAtTick: 10,
          initialStrength: 0.2,
          currentStrength: 0.15,
          decay: "linear",
        },
      ],
      tick: 7,
    });

    const html = render(state);

    expect(html).toContain("発言効果の詳細");
    expect(html).toContain("届いた");
    expect(html).toContain("同調傾向");
    expect(html).toContain("接近確率");
    expect(html).toContain("残り3tick");
    expect(html).toContain("現在作用中の発言効果");
  });
});

describe("ObserverJoinerInspector classroom assignment history", () => {
  it("shows every agent with approach target, failure/restart counts, and the last failure reason", () => {
    const founder = makeAgent({ id: "founder", label: "発起人", state: "forming" });
    const joiner = makeAgent({
      id: "joiner",
      label: "参加者B",
      state: "approaching",
      joinedGroupId: "pair-candidate-a",
      searchRestartCount: 2,
      capacityFailureCount: 1,
    });
    const html = render(
      makeState({
        formationScenarioId: "classroomPair",
        agents: [founder, joiner],
        groupCandidates: [
          {
            id: "pair-candidate-a",
            x: 100,
            y: 100,
            memberIds: ["founder"],
            status: "forming",
            age: 1,
            minGroupSize: 2,
            maxGroupSize: 2,
          },
        ],
        log: [
          {
            tick: 7,
            message: "参加者Bが満員により再探索した",
            tags: ["joinFailure"],
            eventType: "joinFailedCapacity",
            metadata: { agentId: "joiner", reason: "capacityFull" },
          },
        ],
      }),
    );

    expect(html).toContain("エージェントインスペクター");
    expect(html).toContain("発起人");
    expect(html).toContain("参加者B");
    expect(html).toContain("pair-candidate-a");
    expect(html).toContain("参加失敗");
    expect(html).toContain("1回");
    expect(html).toContain("再探索");
    expect(html).toContain("2回");
    expect(html).toContain("満員（tick 7）");
  });

  it("shows current/min/max size and forming/confirmed-vacancy/full for a variable-capacity (3-4) group (Issue #155)", () => {
    const inThree = makeAgent({ id: "in-three", label: "参加者C", state: "joined", joinedGroupId: "group-3" });
    const inFour = makeAgent({ id: "in-four", label: "参加者D", state: "joined", joinedGroupId: "group-4" });
    const html = render(
      makeState({
        formationScenarioId: "classroomPair",
        formationClassroomGroupSize: { minGroupSize: 3, maxGroupSize: 4 },
        agents: [inThree, inFour],
        groupCandidates: [
          { id: "group-3", x: 0, y: 0, memberIds: ["in-three", "x1", "x2"], status: "confirmed", age: 5 },
          { id: "group-4", x: 0, y: 0, memberIds: ["in-four", "y1", "y2", "y3"], status: "confirmed", age: 5 },
        ],
      }),
    );

    expect(html).toContain("班の人数・容量");
    expect(html).toContain("現在3人 / 最小3人 / 最大4人・成立済み・空きあり");
    expect(html).toContain("現在4人 / 最小3人 / 最大4人・確定・満員");
    expect(html).not.toContain("ペアの人数・容量");
  });

  it("keeps the after-party inspector limited to observerJoiners", () => {
    const observer = makeAgent({ id: "observer", label: "Observer", isObserverJoiner: true });
    const plain = makeAgent({ id: "plain", label: "Plain" });
    const html = render(makeState({ formationScenarioId: "afterParty", agents: [observer, plain] }));

    expect(html).toContain("observerJoinerインスペクター");
    expect(html).toContain("Observer");
    expect(html).not.toContain("Plain");
    expect(html).not.toContain("エージェントインスペクター");
  });
});
