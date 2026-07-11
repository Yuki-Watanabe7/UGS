import { describe, expect, it } from "vitest";
import { createInitialState, isJoinable, stepSimulation } from "./engine";
import { PRESETS } from "./presets";
import { SeededRandom } from "./random";
import { buildSimulationSummary } from "./summary";
import type { InterventionScenarioId } from "./interventions";
import type { SimParams, SimulationState } from "./types";

/**
 * プリセットを終了まで走らせ、最終Stateを返す。
 * App.tsx と同じく tick を跨いで単一の SeededRandom を共有する。
 */
function runPresetToCompletion(
  seed: number,
  params: SimParams,
  interventionId: InterventionScenarioId = "none",
): SimulationState {
  const rng = new SeededRandom(seed);
  let state = createInitialState(seed, params, { interventionId });
  // 通常はallSettledかtick>=400で必ず終了する。無限ループ保険として上限を設ける。
  let guard = 0;
  while (!state.finished && guard < 1000) {
    state = stepSimulation(state, params, rng, { interventionId });
    guard += 1;
  }
  return state;
}

/**
 * 「参加済み(joined)」と数えられているのに、実際には所属先の輪が
 * 消滅している/成立していないエージェント(=孤立参加者)を洗い出す。
 * サマリーの joinedCount はこの不整合をそのまま含んでしまうため、
 * ここでは「joined なら実在する joinable なグループに属している」ことを不変条件とする。
 */
function findOrphanedJoinedAgents(state: SimulationState): string[] {
  const orphans: string[] = [];
  for (const agent of state.agents) {
    if (agent.state !== "joined") continue;
    const candidate = state.groupCandidates.find((c) => c.id === agent.joinedGroupId);
    if (!candidate || !isJoinable(candidate) || !candidate.memberIds.includes(agent.id)) {
      orphans.push(agent.label);
    }
  }
  return orphans;
}

describe("joined状態の整合性: 輪が消えたら参加済みに数え続けない", () => {
  // 既定設定(seed 12345 / natural プリセット / 介入なし)で、Kさんが一度Aさんの
  // できかけの輪に joined したあとその輪が期限切れになり、孤立したまま joined として
  // 残ってしまう既知の再現ケース。修正後はKが joined のまま取り残されないこと。
  it("既定設定でKさんが孤立したまま参加済みに残らない (Issue: orphaned joined)", () => {
    const finalState = runPresetToCompletion(12345, PRESETS[0].params, "none");
    expect(finalState.finished).toBe(true);

    const orphans = findOrphanedJoinedAgents(finalState);
    expect(orphans).toEqual([]);
  });

  // 個別ケースに依存しない一般不変条件として、全プリセット x 複数シードで
  // 「joined を名乗るなら実在する joinable なグループに属している」ことを保証する。
  it("全プリセット・複数シードで孤立参加者が発生しない", () => {
    const seeds = [1, 42, 12345, 2024, 99999];
    for (const preset of PRESETS) {
      for (const seed of seeds) {
        const finalState = runPresetToCompletion(seed, preset.params, "none");
        const orphans = findOrphanedJoinedAgents(finalState);
        expect(orphans, `preset=${preset.id} seed=${seed} に孤立参加者: ${orphans.join(",")}`).toEqual([]);

        // サマリーの joinedCount が「実際に輪に属している人数」と一致することも確認する。
        const summary = buildSimulationSummary(finalState);
        const actuallyInGroup = finalState.agents.filter((agent) => {
          if (agent.state !== "joined") return false;
          const candidate = finalState.groupCandidates.find((c) => c.id === agent.joinedGroupId);
          return candidate !== undefined && isJoinable(candidate) && candidate.memberIds.includes(agent.id);
        }).length;
        expect(summary.joinedCount, `preset=${preset.id} seed=${seed} で joinedCount が実態と不一致`).toBe(
          actuallyInGroup,
        );
      }
    }
  });
});
