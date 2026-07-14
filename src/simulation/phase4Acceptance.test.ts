import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { SeededRandom } from "./random";
import { PRESETS, DEFAULT_PARAMS } from "./presets";
import { buildSimulationSummary, buildPhase4RunSummary } from "./summary";
import { derivePrivateEvaluations, derivePublicExpressions, resolveSocialExpressionConfig } from "./socialExpression";
import type { SimParams, SimulationState } from "./types";
import type { InterventionRuntimeOptions } from "./interventions";

/**
 * Issue #120: Phase 4(本心/建前の三層モデル・#114、乖離反映発言・#115、trust更新・#116、
 * 関係性補正・#117)全体について、個別issueの単体テストでは保証できない統合レベルの受入条件を
 * まとめて検証する。個別ルールの単体テストは`socialExpression.test.ts`/`speechTrust.test.ts`/
 * `relationshipTie.test.ts`等が引き続き担い、ここでは「全プリセット×複数seed」の横断的な
 * 従来互換・再現性・因果追跡のみを扱う(`speechEffectsReproducibility.test.ts`、Issue #100と同じ設計)。
 */

type Phase4Options = {
  speechEffects: boolean;
  socialExpression: boolean;
  speechTrust: boolean;
  relationshipTie: boolean;
};

const ALL_OFF: Phase4Options = {
  speechEffects: false,
  socialExpression: false,
  speechTrust: false,
  relationshipTie: false,
};

const ALL_ON: Phase4Options = {
  speechEffects: true,
  socialExpression: true,
  speechTrust: true,
  relationshipTie: true,
};

const MAX_TICKS = 400;

function runCollecting(
  seed: number,
  params: SimParams,
  options?: Phase4Options,
  intervention?: InterventionRuntimeOptions,
): { states: SimulationState[]; rngProbe: number } {
  const rng = new SeededRandom(seed);
  const effects = options && { enabled: options.speechEffects };
  const social = options && { enabled: options.socialExpression };
  const trust = options && { enabled: options.speechTrust };
  const tie = options && { enabled: options.relationshipTie };

  let state = createInitialState(seed, params, intervention, effects, social, trust, tie);
  const states: SimulationState[] = [state];
  let ticks = 0;
  while (!state.finished && ticks < MAX_TICKS) {
    state = stepSimulation(state, params, rng, intervention, effects, social, trust, tie);
    states.push(state);
    ticks += 1;
  }
  return { states, rngProbe: rng.next() };
}

const SEEDS = [1, 2024, 999999];

describe("Phase4受入回帰テスト: 従来互換(全プリセット×複数seed)", () => {
  for (const preset of PRESETS) {
    for (const seed of SEEDS) {
      it(`preset="${preset.id}" seed=${seed}: config未指定と全機能明示OFFは状態系列・PRNG消費・summaryが完全一致する`, () => {
        const implicit = runCollecting(seed, preset.params);
        const explicitOff = runCollecting(seed, preset.params, ALL_OFF);

        expect(explicitOff.states.length).toBe(implicit.states.length);
        expect(explicitOff.states).toEqual(implicit.states);
        expect(explicitOff.rngProbe).toBe(implicit.rngProbe);

        const implicitSummary = buildSimulationSummary(implicit.states.at(-1)!);
        const explicitOffSummary = buildSimulationSummary(explicitOff.states.at(-1)!);
        expect(explicitOffSummary).toEqual(implicitSummary);

        // OFF状態ではPhase 3/4のいずれのログ・派生観測指標も一切生成されない
        const final = explicitOff.states.at(-1)!;
        expect(final.speechReceptionLog ?? []).toEqual([]);
        expect(final.speechInterpretationLog ?? []).toEqual([]);
        expect(final.speechEffectLog ?? []).toEqual([]);
        expect(final.speechTrustUpdateLog ?? []).toEqual([]);
        expect(final.speechTruthfulnessLog ?? []).toEqual([]);
        expect(final.relationshipTieUpdateLog ?? []).toEqual([]);
        expect(buildPhase4RunSummary(final)).toEqual({
          divergenceCount: 0,
          expressedSpeechCount: 0,
          trustChangeAmount: 0,
          tieChangeAmount: 0,
        });
      });
    }
  }
});

describe("Phase4受入回帰テスト: 再現性(全機能ON、全プリセット×複数seed)", () => {
  for (const preset of PRESETS) {
    for (const seed of SEEDS) {
      it(`preset="${preset.id}" seed=${seed}: 同一seed・同一設定なら状態系列・全ログ・PRNG消費が完全に再現される`, () => {
        const first = runCollecting(seed, preset.params, ALL_ON);
        const second = runCollecting(seed, preset.params, ALL_ON);

        expect(second.states).toEqual(first.states);
        expect(second.rngProbe).toBe(first.rngProbe);

        const firstFinal = first.states.at(-1)!;
        const secondFinal = second.states.at(-1)!;
        expect(secondFinal.speechLog).toEqual(firstFinal.speechLog);
        expect(secondFinal.speechTrustUpdateLog).toEqual(firstFinal.speechTrustUpdateLog);
        expect(secondFinal.speechTruthfulnessLog).toEqual(firstFinal.speechTruthfulnessLog);
        expect(secondFinal.speechTrust).toEqual(firstFinal.speechTrust);
        expect(secondFinal.tieHistory).toEqual(firstFinal.tieHistory);
        expect(secondFinal.relationshipTieUpdateLog).toEqual(firstFinal.relationshipTieUpdateLog);
      });
    }
  }

  it("導出専用の観察層(PrivateEvaluation/PublicExpression)も、状態系列に持つ情報だけから2回の独立実行で完全に再現される", () => {
    // socialExpression.tsのderive*はSimulationStateに保持されない観察スナップショットのため、
    // 状態系列(states)が一致するだけでは「毎tick呼び出しても再現されるか」は保証されない。
    // ここでは捕捉した各tickのstateに対して独立に導出し直し、2回の実行間で系列が一致することを見る。
    const config = resolveSocialExpressionConfig({ enabled: true });
    const preset = PRESETS[0];

    const deriveLayer = (states: SimulationState[]) =>
      states.map((state) => {
        const privateEvaluations = derivePrivateEvaluations(state, preset.params, config);
        const publicExpressions = derivePublicExpressions(privateEvaluations, state, preset.params, config);
        return { privateEvaluations, publicExpressions };
      });

    const first = runCollecting(7, preset.params, ALL_ON);
    const second = runCollecting(7, preset.params, ALL_ON);

    expect(deriveLayer(second.states)).toEqual(deriveLayer(first.states));
  });
});

describe("Phase4受入回帰テスト: 因果追跡(乖離要因→SpeechEvent→認知・解釈・効果→trust/関係性更新)", () => {
  // 発言・乖離・trust更新・tie更新が十分な頻度で起こりうるプリセット×複数seedを横断して
  // 因果チェーンの構造整合性を検証する。乖離が0件のrunがあっても失敗にはしない(発生数は
  // ヒューリスティックに依存するため)。全チェーンを通しての完全な具体例が最低1件見つかることを
  // 別途アサートする。
  const CHAIN_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("SpeechEvent.expressionのpublicExpressionId/privateEvaluationIdは常に`public-${tick}-${speakerId}`/`private-${tick}-${speakerId}`と一致する(決定的な再導出可能性)", () => {
    for (const preset of PRESETS) {
      for (const seed of CHAIN_SEEDS.slice(0, 3)) {
        const { states } = runCollecting(seed, preset.params, ALL_ON);
        const final = states.at(-1)!;
        for (const event of final.speechLog ?? []) {
          if (!event.expression) continue;
          expect(event.expression.publicExpressionId).toBe(`public-${event.tick}-${event.speakerId}`);
          expect(event.expression.privateEvaluationId).toBe(`private-${event.tick}-${event.speakerId}`);
        }
      }
    }
  });

  it("speechReceptionLog/speechInterpretationLog/speechEffectLog/speechTrustUpdateLog/relationshipTieUpdateLogの各idは、必ずspeechLog内の実在するSpeechEventへ遡れる", () => {
    for (const preset of PRESETS) {
      for (const seed of CHAIN_SEEDS.slice(0, 3)) {
        const { states } = runCollecting(seed, preset.params, ALL_ON);
        const final = states.at(-1)!;
        const speechIds = new Set((final.speechLog ?? []).map((e) => e.id));
        const receptionIds = new Set((final.speechReceptionLog ?? []).map((e) => e.id));
        const interpretationIds = new Set((final.speechInterpretationLog ?? []).map((e) => e.id));

        for (const reception of final.speechReceptionLog ?? []) {
          expect(speechIds.has(reception.speechEventId)).toBe(true);
        }
        for (const interpretation of final.speechInterpretationLog ?? []) {
          expect(speechIds.has(interpretation.speechEventId)).toBe(true);
          expect(receptionIds.has(interpretation.receptionEventId)).toBe(true);
        }
        for (const effect of final.speechEffectLog ?? []) {
          expect(speechIds.has(effect.speechEventId)).toBe(true);
          expect(interpretationIds.has(effect.interpretationEventId)).toBe(true);
        }
        for (const truthfulness of final.speechTruthfulnessLog ?? []) {
          expect(speechIds.has(truthfulness.speechEventId)).toBe(true);
        }
        for (const trustUpdate of final.speechTrustUpdateLog ?? []) {
          expect(speechIds.has(trustUpdate.speechEventId)).toBe(true);
        }
        for (const tieUpdate of final.relationshipTieUpdateLog ?? []) {
          expect(speechIds.has(tieUpdate.speechEventId)).toBe(true);
        }
      }
    }
  });

  it("少なくとも1件、乖離した発言(divergent)がSpeechEvent→真実性記録→trust更新→関係性補正更新まで同一speechEventIdで一貫して辿れる具体例が見つかる", () => {
    type FullChainExample = {
      presetId: string;
      seed: number;
      speechEventId: string;
      divergent: boolean;
      hasTruthfulness: boolean;
      hasTrustUpdate: boolean;
      hasTieUpdate: boolean;
    };

    const examples: FullChainExample[] = [];

    for (const preset of PRESETS) {
      for (const seed of CHAIN_SEEDS) {
        const { states } = runCollecting(seed, preset.params, ALL_ON);
        const final = states.at(-1)!;
        const truthfulnessBySpeech = new Map((final.speechTruthfulnessLog ?? []).map((r) => [r.speechEventId, r]));
        const trustUpdatesBySpeech = new Set((final.speechTrustUpdateLog ?? []).map((u) => u.speechEventId));
        const tieUpdatesBySpeech = new Set((final.relationshipTieUpdateLog ?? []).map((u) => u.speechEventId));

        for (const event of final.speechLog ?? []) {
          if (!event.expression?.divergent) continue;
          const truthfulness = truthfulnessBySpeech.get(event.id);
          examples.push({
            presetId: preset.id,
            seed,
            speechEventId: event.id,
            divergent: event.expression.divergent,
            hasTruthfulness: truthfulness !== undefined,
            hasTrustUpdate: trustUpdatesBySpeech.has(event.id),
            hasTieUpdate: tieUpdatesBySpeech.has(event.id),
          });
        }
      }
    }

    // 乖離した発言自体は複数見つかるはず(乖離判定の主要な受入条件は各モジュールの単体テストで別途保証済み)
    expect(examples.length).toBeGreaterThan(0);
    expect(examples.every((e) => e.hasTruthfulness)).toBe(true);

    // trust/tie更新まで到達する例(受け手が認知し、話者がその後決定的な遷移を行った場合のみ発生する)
    // が少なくとも1件ずつ見つかることを確認する(因果チェーンが実際に最後まで機能する具体例の存在)。
    expect(examples.some((e) => e.hasTrustUpdate)).toBe(true);
    expect(examples.some((e) => e.hasTieUpdate)).toBe(true);
  });
});

describe("Phase4受入回帰テスト: 数値安全性(全機能ON)", () => {
  it("全プリセットで、trust/tie補正・真実性の値がいずれも定義域内に収まる", () => {
    for (const preset of PRESETS) {
      const { states } = runCollecting(7, preset.params, ALL_ON);
      const final = states.at(-1)!;

      for (const record of final.speechTruthfulnessLog ?? []) {
        expect(record.truthfulness).toBeGreaterThanOrEqual(0);
        expect(record.truthfulness).toBeLessThanOrEqual(1);
      }
      for (const update of final.speechTrustUpdateLog ?? []) {
        expect(update.newTrust).toBeGreaterThanOrEqual(0);
        expect(update.newTrust).toBeLessThanOrEqual(1);
      }
      for (const [, trust] of Object.entries(final.speechTrust ?? {})) {
        expect(trust).toBeGreaterThanOrEqual(0);
        expect(trust).toBeLessThanOrEqual(1);
      }
    }
  });

  it("全プリセットで、personality基礎値(willingness/initiative/ambiguityTolerance/influenceAvoidance/conformity/leaveThreshold)とcliqueIdはPhase4実行でも初期値から一切変化しない", () => {
    for (const preset of PRESETS) {
      const initial = createInitialState(
        7,
        preset.params,
        undefined,
        { enabled: true },
        { enabled: true },
        { enabled: true },
        { enabled: true },
      );
      const { states } = runCollecting(7, preset.params, ALL_ON);
      const final = states.at(-1)!;
      const initialById = new Map(initial.agents.map((a) => [a.id, a]));

      for (const agent of final.agents) {
        const before = initialById.get(agent.id)!;
        expect(agent.willingness).toBe(before.willingness);
        expect(agent.initiative).toBe(before.initiative);
        expect(agent.ambiguityTolerance).toBe(before.ambiguityTolerance);
        expect(agent.influenceAvoidance).toBe(before.influenceAvoidance);
        expect(agent.conformity).toBe(before.conformity);
        expect(agent.leaveThreshold).toBe(before.leaveThreshold);
        expect(agent.cliqueId).toBe(before.cliqueId);
      }
    }
  });
});

describe("Phase4受入回帰テスト: プリセット5のobserverJoiner孤立が維持される(Phase4全機能ON、複数seed)", () => {
  it("プリセット5(leftover-free-grouping)は、Phase4全機能ONでも複数seedで全observerJoinerが必ず合流するわけではない", () => {
    const preset5 = PRESETS.find((p) => p.id === "leftover-free-grouping");
    expect(preset5).toBeDefined();

    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const results = seeds.map((seed) => {
      const { states } = runCollecting(seed, preset5!.params, ALL_ON);
      const final = states.at(-1)!;
      return final.agents.filter((a) => a.isObserverJoiner).map((a) => a.state === "joined");
    });

    const alwaysAllJoined = results.every((joinedFlags) => joinedFlags.length > 0 && joinedFlags.every(Boolean));
    expect(alwaysAllJoined).toBe(false);
  });
});

describe("DEFAULT_PARAMSでの回帰(健全性チェック)", () => {
  it("DEFAULT_PARAMSでもimplicit/explicit-OFFの一致・全機能ONの決定性が保たれる", () => {
    const implicit = runCollecting(2024, DEFAULT_PARAMS);
    const explicitOff = runCollecting(2024, DEFAULT_PARAMS, ALL_OFF);
    expect(explicitOff.states).toEqual(implicit.states);

    const onFirst = runCollecting(2024, DEFAULT_PARAMS, ALL_ON);
    const onSecond = runCollecting(2024, DEFAULT_PARAMS, ALL_ON);
    expect(onSecond.states).toEqual(onFirst.states);
  });
});
