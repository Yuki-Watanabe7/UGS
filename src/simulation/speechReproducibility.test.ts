import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { PRESETS } from "./presets";
import type { SimParams, SimulationState } from "./types";
import type { SpeechEvent } from "./speech";

/**
 * Issue #83「SpeechEventの再現性・決定性・非介入性テスト」の受入テスト。
 * `speechGeneration.test.ts`/`speech.test.ts`が個別ルールを単体テストするのに対し、
 * ここでは`expressionReproducibility.test.ts`(心の声)と同じ考え方で、実際のシミュレーション
 * 全体を通した`speechLog`の再現性・決定性(件数・内容・順序が同一seedで一致すること)を検証する。
 */

function runToCompletion(seed: number, params: SimParams): SimulationState {
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params);
  let ticks = 0;
  while (!state.finished && ticks < 400) {
    state = stepSimulation(state, params, rng);
    ticks += 1;
  }
  return state;
}

describe("SpeechEventの再現性: 同一seed・同一paramsなら speechLog が完全一致する", () => {
  for (const preset of PRESETS) {
    it(`preset="${preset.id}": 同一seedを2回実行すると件数・内容・順序が完全一致する`, () => {
      const first = runToCompletion(2024, preset.params);
      const second = runToCompletion(2024, preset.params);

      expect(second.speechLog).toEqual(first.speechLog);
    });
  }

  it("新しいSeededRandom/新しいstateから同一seedで再実行(Reset相当)しても同一のspeechLogを得る", () => {
    const preset = PRESETS[2];
    const before = runToCompletion(777, preset.params);
    const afterReset = runToCompletion(777, preset.params);

    expect(afterReset.speechLog).toEqual(before.speechLog);
  });

  it("seedを変えるとspeechLogが変わり得る(常に同一系列に潰れているわけではない)", () => {
    const preset = PRESETS[0];
    const withSeedA = runToCompletion(1, preset.params);
    const withSeedB = runToCompletion(2, preset.params);

    expect(withSeedA.speechLog).not.toEqual(withSeedB.speechLog);
  });

  it("複数シードでspeechLogのtickが常に非減少(発生順序が安定している)", () => {
    const seeds = [1, 42, 12345, 2024, 99999];
    for (const preset of PRESETS) {
      for (const seed of seeds) {
        const finalState = runToCompletion(seed, preset.params);
        const ticks = (finalState.speechLog ?? []).map((e) => e.tick);
        for (let i = 1; i < ticks.length; i++) {
          expect(
            ticks[i],
            `preset=${preset.id} seed=${seed} でspeechLogのtick順が乱れている(index ${i})`,
          ).toBeGreaterThanOrEqual(ticks[i - 1]);
        }
      }
    }
  });
});

describe("SpeechEventの非介入性: speechLogの生成が既存の状態遷移・rng消費に影響しない", () => {
  // speechLogはagents/groupCandidates/logと同じstepSimulation呼び出しの副産物として
  // 生成される(deriveSpeechEventsはrngもSimulationStateもmutationしない純粋関数)。
  // 「同一seed・同一paramsを2回実行してagents/groupCandidates/logが完全一致する」ことは
  // 既に他のintegrityテストが保証しているが、ここではspeechLogを含めた全フィールドが
  // 同時に完全一致すること(=speechLog生成が他のフィールドの決定性に副作用を及ぼしていないこと)
  // を明示的に確認する。
  const seeds = [1, 42, 12345];

  for (const preset of PRESETS) {
    for (const seed of seeds) {
      it(`preset="${preset.id}" seed=${seed}: agents/groupCandidates/log/speechLogが2回の実行で完全一致する`, () => {
        const runA = runToCompletion(seed, preset.params);
        const runB = runToCompletion(seed, preset.params);

        expect(runA.agents).toEqual(runB.agents);
        expect(runA.groupCandidates).toEqual(runB.groupCandidates);
        expect(runA.log).toEqual(runB.log);
        expect(runA.speechLog).toEqual(runB.speechLog);
      });
    }
  }

  it("rngの消費量がspeechLogの有無に関わらず一致する(speechLogを読み捨てても最終rng状態が変わらない)", () => {
    const preset = PRESETS[0];
    const seed = 555;

    const rngA = new SeededRandom(seed);
    let stateA = createInitialState(seed, preset.params);
    let ticks = 0;
    while (!stateA.finished && ticks < 400) {
      stateA = stepSimulation(stateA, preset.params, rngA);
      // speechLogを都度捨てても以降のtickのrng消費・状態遷移には影響しないはず
      stateA = { ...stateA, speechLog: [] };
      ticks += 1;
    }

    const rngB = new SeededRandom(seed);
    let stateB = createInitialState(seed, preset.params);
    ticks = 0;
    while (!stateB.finished && ticks < 400) {
      stateB = stepSimulation(stateB, preset.params, rngB);
      ticks += 1;
    }

    expect(rngA.next()).toBe(rngB.next());
    expect(stateA.agents).toEqual(stateB.agents);
    expect(stateA.groupCandidates).toEqual(stateB.groupCandidates);
    expect(stateA.log).toEqual(stateB.log);
  });
});

describe("SpeechEventの一意性・整合性: speechLog全体が満たすべき不変条件", () => {
  const seeds = [1, 42, 12345, 2024, 99999];

  const REASON_TO_INTENT: Record<SpeechEvent["reason"], SpeechEvent["intent"]> = {
    initiativeFormedCore: "invite",
    cliqueFormedCore: "invite",
    formingGroupRecruitment: "invite",
    approachWelcome: "welcome",
    joinGreeting: "greet",
    leaveDeclaration: "decline",
    lightObserverInvitation: "invite",
  };

  for (const preset of PRESETS) {
    for (const seed of seeds) {
      it(`preset="${preset.id}" seed=${seed}: id重複がなく、speakerId/targetが実在するagentを指し、target/audienceが排他で、intentがreasonと矛盾しない`, () => {
        const finalState = runToCompletion(seed, preset.params);
        const speechLog = finalState.speechLog ?? [];
        const knownAgentIds = new Set(finalState.agents.map((a) => a.id));

        const ids = speechLog.map((e) => e.id);
        expect(new Set(ids).size, `preset=${preset.id} seed=${seed} でid重複: ${ids.join(",")}`).toBe(ids.length);

        for (const event of speechLog) {
          expect(knownAgentIds.has(event.speakerId), `speakerId ${event.speakerId} が存在しない`).toBe(true);
          if (event.target !== undefined) {
            expect(knownAgentIds.has(event.target), `target ${event.target} が存在しない`).toBe(true);
          }

          // target と audience は排他: どちらか一方のみが定義される
          const hasTarget = event.target !== undefined;
          const hasAudience = event.audience !== undefined;
          expect(
            hasTarget !== hasAudience,
            `event ${event.id} はtarget/audienceの排他制約を満たさない(target=${event.target}, audience=${event.audience})`,
          ).toBe(true);

          expect(event.intent, `event ${event.id} のintentがreason "${event.reason}"と対応しない`).toBe(
            REASON_TO_INTENT[event.reason],
          );
        }
      });
    }
  }
});
