import { describe, expect, it } from "vitest";
import { createInitialState, stepSimulation } from "./engine";
import { deriveExpressionEvents } from "./expression";
import { resolveExpressionEventText } from "./expressionTemplates";
import { SeededRandom } from "./random";
import { PRESETS } from "./presets";
import type { SimParams } from "./types";

// 心の声の生成・表示に関わるソース一式を`?raw`(Viteの生テキストimport、`vite/client`の
// `declare module '*?raw'`で型付けされる)で読み込み、Math.random等の非決定的APIに
// 依存していないことを静的に検証する(node:fsは`src`のtsconfig(ブラウザ向け)に
// Node型定義が無いため使わない)。
import expressionSource from "./expression.ts?raw";
import expressionTemplatesSource from "./expressionTemplates.ts?raw";
import activeExpressionsSource from "./activeExpressions.ts?raw";
import thoughtBubbleLayoutSource from "../components/thoughtBubbleLayout.ts?raw";
import thoughtBubbleSource from "../components/ThoughtBubble.tsx?raw";
import simulationCanvasSource from "../components/SimulationCanvas.tsx?raw";
import expressionDisplayFilterSource from "../components/expressionDisplayFilter.ts?raw";
import expressionDisplaySettingsSource from "../components/ExpressionDisplaySettings.tsx?raw";
import useActiveExpressionsSource from "../hooks/useActiveExpressions.ts?raw";

/**
 * Issue #67「表現の再現性テスト」の受入テスト。
 * `expression.ts`/`expressionTemplates.ts`は`ExpressionDerivationContext.seed`から決定的に
 * バリエーションを選ぶ設計(engine.tsからは参照されず、本体のSeededRandomも受け取らない)。
 * ここでは個別ルールの単体テスト(expression.test.ts)ではなく、実際のシミュレーション全体を
 * 通したときに「同じseedなら同じ表現系列」「seedを変えると変わり得る」ことを確認する。
 */

type TextEvent = { tick: number; agentId: string; textKey: string; text: string };

function collectExpressionSequence(simSeed: number, contextSeed: number, params: SimParams): TextEvent[] {
  const rng = new SeededRandom(simSeed);
  let state = createInitialState(simSeed, params);
  const sequence: TextEvent[] = [];
  let ticks = 0;
  while (!state.finished && ticks < 400) {
    const next = stepSimulation(state, params, rng);
    const events = deriveExpressionEvents(state, next, { seed: contextSeed });
    for (const event of events) {
      const agent = next.agents.find((a) => a.id === event.agentId);
      const isObserverJoiner = agent?.isObserverJoiner ?? false;
      sequence.push({
        tick: event.tick,
        agentId: event.agentId,
        textKey: event.textKey,
        text: resolveExpressionEventText(event, isObserverJoiner),
      });
    }
    state = next;
    ticks += 1;
  }
  return sequence;
}

describe("表現の再現性: 同じseed・tick・agentId・intentでは同じ表現系列が得られる", () => {
  for (const preset of PRESETS) {
    it(`preset="${preset.id}": 同一seedを2回実行すると完全に同じ表現系列(tick/agentId/textKey/text)を得る`, () => {
      const first = collectExpressionSequence(777, 777, preset.params);
      const second = collectExpressionSequence(777, 777, preset.params);

      expect(second).toEqual(first);
      expect(first.length).toBeGreaterThan(0);
    });
  }

  it("Reset相当(新しいSeededRandom/新しいstateから同一seedで再実行)しても同一の表現系列を得る", () => {
    const preset = PRESETS[2];
    const before = collectExpressionSequence(2024, 2024, preset.params);
    // Resetは「新しいSeededRandomインスタンス + createInitialStateからやり直す」ことと等価
    const afterReset = collectExpressionSequence(2024, 2024, preset.params);

    expect(afterReset).toEqual(before);
  });

  it("表現文脈のseedだけを変えると、発生順序は保ったままtextKey(バリエーション)が変わり得る", () => {
    const preset = PRESETS[0];
    const withContextSeedA = collectExpressionSequence(555, 1, preset.params);
    const withContextSeedB = collectExpressionSequence(555, 2, preset.params);

    // 本体シミュレーションseedは同じなので、どのtick・どのagentで何が起きるかの順序自体は変わらない
    expect(withContextSeedA.map((e) => `${e.tick}:${e.agentId}`)).toEqual(
      withContextSeedB.map((e) => `${e.tick}:${e.agentId}`),
    );
    // が、テキストキー(バリエーション選択)は少なくとも一部で異なり得る(仕様どおり)
    const anyDifferentTextKey = withContextSeedA.some((e, i) => e.textKey !== withContextSeedB[i].textKey);
    expect(anyDifferentTextKey).toBe(true);
  });

  it("本体シミュレーションseedを変えると、状態遷移自体が変わるため表現系列が一致しなくなり得る", () => {
    const preset = PRESETS[0];
    const withSeedA = collectExpressionSequence(1, 1, preset.params);
    const withSeedB = collectExpressionSequence(2, 2, preset.params);

    expect(withSeedA).not.toEqual(withSeedB);
  });
});

describe("表現生成はMath.random等の非決定的APIに依存していない", () => {
  const SOURCES: [string, string][] = [
    ["simulation/expression.ts", expressionSource],
    ["simulation/expressionTemplates.ts", expressionTemplatesSource],
    ["simulation/activeExpressions.ts", activeExpressionsSource],
    ["components/thoughtBubbleLayout.ts", thoughtBubbleLayoutSource],
    ["components/ThoughtBubble.tsx", thoughtBubbleSource],
    ["components/SimulationCanvas.tsx", simulationCanvasSource],
    ["components/expressionDisplayFilter.ts", expressionDisplayFilterSource],
    ["components/ExpressionDisplaySettings.tsx", expressionDisplaySettingsSource],
    ["hooks/useActiveExpressions.ts", useActiveExpressionsSource],
  ];

  const FORBIDDEN: [RegExp, string][] = [
    [/Math\.random\s*\(/, "Math.random()"],
    [/crypto\.getRandomValues/, "crypto.getRandomValues"],
    [/new Date\s*\(/, "new Date()"],
    [/Date\.now\s*\(/, "Date.now()"],
  ];

  it.each(SOURCES)("%sにMath.random/crypto.getRandomValues/new Date()/Date.now()呼び出しが存在しない", (_name, source) => {
    const offenders = FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);
    expect(offenders).toEqual([]);
  });
});
