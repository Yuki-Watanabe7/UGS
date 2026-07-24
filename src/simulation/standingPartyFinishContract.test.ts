import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { runSimulationToEnd, DEFAULT_MAX_TICKS } from "./monteCarlo";
import { SeededRandom } from "./random";
import { getPresetById } from "./presets";
import type { FormationRuntimeOptions } from "./formationPolicy";

/**
 * Issue #175 (Phase 1): 立食パーティー(standingParty)の終了契約を検証する。
 * - semantic finish(FormationPolicy由来の自然終了)を持たない: 全員が輪へ所属/離脱しても、
 *   afterParty相当のtick数を超えても、それ自体では終了しない(engine.tsが`state.finished`を
 *   trueにしない = `stepSimulation`が今後もtickを進め続けられる)。
 * - observation horizon(`observationHorizonTick`)を明示すれば、そのtickでのみ独立した理由
 *   ("observationHorizonReached")で終了する。
 * - 既存シナリオ(afterParty/classroomPair)は無指定なら一切影響を受けず、明示してもsemantic finish
 *   が先に成立していればそちらが優先される。
 */

const STANDING_PARTY_FORMATION: FormationRuntimeOptions = { scenarioId: "standingParty" };

describe("standingParty: 継続実行(semantic finishを持たない) (Issue #175)", () => {
  it("全員が輪へ所属/帰宅しても、afterPartyのMAX_SIMULATION_TICKS(400)を大きく超えても終了しない", () => {
    const preset = getPresetById("standing-party");
    const rng = new SeededRandom(1);
    let state = createInitialState(
      1,
      preset.params,
      { interventionId: "none" },
      undefined,
      undefined,
      undefined,
      undefined,
      STANDING_PARTY_FORMATION,
    );

    for (let i = 0; i < 600; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
      expect(state.finished).toBe(false);
    }

    expect(state.tick).toBe(600);
    // 「継続してもよい」だけでなく、実際にこのpresetでは十分な時間内に誰かが所属/離脱まで至っている
    // ことを確認し、afterPartyであれば`allSettled`が成立していたはずの状況で終了しないことを保証する。
    const settledCount = state.agents.filter((a) => a.state === "joined" || a.state === "left").length;
    expect(settledCount).toBeGreaterThan(0);
    expect(state.log.some((entry) => entry.eventType === "simulationFinished")).toBe(false);
  });

  it("会話の輪(GroupCandidate)が一時的に0件になっても終了しない", () => {
    const rng = new SeededRandom(2);
    let state = createInitialState(2, getPresetById("standing-party").params, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
    // 序盤はまだ誰も輪を作っていない(=groupCandidatesが空)tickが必ず存在する
    expect(state.groupCandidates).toHaveLength(0);
    expect(state.finished).toBe(false);

    for (let i = 0; i < 10; i++) {
      state = stepSimulation(state, getPresetById("standing-party").params, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION);
      expect(state.finished).toBe(false);
    }
  });
});

describe("standingParty: observation horizon (Issue #175)", () => {
  const HORIZON = 50;

  it("horizon到達前はfinishedにならず、horizon到達tickでfinishReason: 'observationHorizonReached'として終了する", () => {
    const preset = getPresetById("standing-party");
    const rng = new SeededRandom(3);
    let state = createInitialState(
      3,
      preset.params,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      STANDING_PARTY_FORMATION,
      HORIZON,
    );
    expect(state.observationHorizonTick).toBe(HORIZON);

    for (let i = 1; i < HORIZON; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, undefined, HORIZON);
      expect(state.finished).toBe(false);
      expect(state.tick).toBe(i);
    }

    state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, undefined, HORIZON);
    expect(state.tick).toBe(HORIZON);
    expect(state.finished).toBe(true);

    const finishEntry = state.log.find((entry) => entry.eventType === "simulationFinished");
    expect(finishEntry).toBeDefined();
    expect(finishEntry?.metadata?.finishReason).toBe("observationHorizonReached");
    // 受入条件: 「全員の行動が確定した」「グループ形成が完了した」等の誤解を招く文言を使用しない
    expect(finishEntry?.message).not.toMatch(/確定|完了/);

    // 終了後はstepSimulationが引き続きno-opであることも確認する(既存の`if (state.finished) return state;`)
    const afterFinish = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, undefined, HORIZON);
    expect(afterFinish).toBe(state);
  });

  it("同一seed・同一horizonであれば最終状態が再現される", () => {
    const preset = getPresetById("standing-party");
    const run = () => {
      const rng = new SeededRandom(9);
      let state = createInitialState(9, preset.params, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION, HORIZON);
      for (let i = 0; i < HORIZON; i++) {
        state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, STANDING_PARTY_FORMATION, HORIZON);
      }
      return state;
    };

    const a = run();
    const b = run();
    expect(a.finished).toBe(true);
    expect(a.agents).toEqual(b.agents);
    expect(a.groupCandidates).toEqual(b.groupCandidates);
    expect(a.log).toEqual(b.log);
  });

  it("semantic finish(afterPartyのallSettled/maxTicksReached)がhorizonより先に成立する場合は、そちらを優先する", () => {
    const preset = getPresetById("natural");
    const rng = new SeededRandom(1000);
    // afterPartyは無指定でも自然終了する。horizonを非常に大きく設定しても、自然終了の理由が優先される。
    let state = createInitialState(1000, preset.params, undefined, undefined, undefined, undefined, undefined, undefined, 10_000);
    for (let i = 0; i < 400 && !state.finished; i++) {
      state = stepSimulation(state, preset.params, rng, undefined, undefined, undefined, undefined, undefined, undefined, 10_000);
    }
    expect(state.finished).toBe(true);
    const finishEntry = state.log.find((entry) => entry.eventType === "simulationFinished");
    expect(finishEntry?.metadata?.finishReason).not.toBe("observationHorizonReached");
    expect(["allSettled", "maxTicksReached"]).toContain(finishEntry?.metadata?.finishReason);
  });
});

describe("standingParty: バッチ/Monte Carlo実行 (Issue #175)", () => {
  it("runSimulationToEndはDEFAULT_MAX_TICKSをobservation horizonとして使い、'observationHorizonReached'で必ず停止する", () => {
    const preset = getPresetById("standing-party");
    const { summary, finishedTick } = runSimulationToEnd(1, preset.params, {
      formation: STANDING_PARTY_FORMATION,
    });

    expect(summary.finished).toBe(true);
    expect(summary.finishReason).toBe("observationHorizonReached");
    expect(finishedTick).toBe(DEFAULT_MAX_TICKS);
  });

  it("明示的なmaxTicksをhorizonとしてそのまま使う", () => {
    const preset = getPresetById("standing-party");
    const { summary, finishedTick } = runSimulationToEnd(1, preset.params, {
      formation: STANDING_PARTY_FORMATION,
      maxTicks: 60,
    });

    expect(summary.finished).toBe(true);
    expect(summary.finishReason).toBe("observationHorizonReached");
    expect(finishedTick).toBe(60);
  });

  it("同一seed・同一maxTicksで最終summaryが再現される", () => {
    const preset = getPresetById("standing-party");
    const run = () => runSimulationToEnd(42, preset.params, { formation: STANDING_PARTY_FORMATION, maxTicks: 80 });

    const a = run();
    const b = run();
    expect(a.summary).toEqual(b.summary);
    expect(a.finishedTick).toBe(b.finishedTick);
  });

  it("既存のafterParty/classroomPairプリセットのMonte Carlo挙動には回帰がない(既定maxTicks=1000内で自然終了する)", () => {
    const natural = getPresetById("natural");
    const naturalResult = runSimulationToEnd(1000, natural.params);
    expect(["allSettled", "maxTicksReached"]).toContain(naturalResult.summary.finishReason);

    const pair = getPresetById("classroom-pair");
    const pairResult = runSimulationToEnd(1, pair.params, {
      formation: {
        scenarioId: "classroomPair",
        formationDeadlineTick: pair.formationDeadlineTick,
        classroomGroupSize: pair.formationClassroomGroupSize,
      },
    });
    expect(["allAssigned", "deadlineReached"]).toContain(pairResult.summary.finishReason);
  });
});
