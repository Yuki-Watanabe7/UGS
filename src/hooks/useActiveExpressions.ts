import { useEffect, useRef, useState } from "react";
import type { SimulationState } from "../simulation/types";
import { deriveExpressionEvents } from "../simulation/expression";
import { resolveExpressionEventText } from "../simulation/expressionTemplates";
import {
  applyExpressionEvents,
  createActiveExpressionsState,
  toExpressionBubbleCandidate,
  type ActiveExpressionsState,
} from "../simulation/activeExpressions";
import type { ThoughtBubbleDisplay } from "../components/SimulationCanvas";
import type { FormationScenarioId } from "../simulation/formationPolicy";

/**
 * `SimulationState`の変化からExpressionEventを導出し、寿命・競合・混雑制御(`activeExpressions.ts`)
 * を経てSimulationCanvasへ渡す表示リストへ変換する薄いReactラッパー。
 *
 * - タイマー/subscriptionは一切持たない。すべてtick(`simState`の変化)駆動であるため、
 *   Pause中(`simState`が変化しない間)は実時間だけで吹き出しが消えることはなく、
 *   アンマウント時にも特別なcleanupを必要としない。
 * - `resetKey`が変わったら(Reset・プリセット変更・seed変更・再実行)、蓄積していた
 *   アクティブ/キュー状態を破棄して空から始める。
 */
export type UseActiveExpressionsOptions = {
  /** falseの間は導出・競合制御を一切行わず、表示を空にする(表示設定「心の声OFF」用) */
  enabled?: boolean;
  maxConcurrent?: number;
  scenarioId?: FormationScenarioId;
};

/**
 * `useActiveExpressions`が保持する状態一式。フック本体はこれを`useRef`で保持し、
 * `advanceExpressionDisplay`にすべての分岐ロジックを委譲する。React/DOMに依存しないため、
 * Pause/Step/Reset/seed変更・preset変更といったライフサイクル挙動をReactレンダリングなしに
 * 単体テストできる(`useActiveExpressions.test.ts`参照)。
 */
export type ExpressionDisplayDriverState = {
  resetKey: unknown;
  prevSimState: SimulationState;
  expressions: ActiveExpressionsState;
  displayed: ThoughtBubbleDisplay[];
};

export function createExpressionDisplayDriverState(
  simState: SimulationState,
  resetKey: unknown,
): ExpressionDisplayDriverState {
  return { resetKey, prevSimState: simState, expressions: createActiveExpressionsState(), displayed: [] };
}

/**
 * `simState`/`resetKey`の変化を1回分だけ反映した新しいdriver状態を返す純粋関数。
 * 変化がない(Pause中の再呼び出し等)場合は`driver`をそのまま返す(参照が同じであることを
 * 呼び出し側が「再レンダリング不要」の判定に使えるようにするため)。
 */
export function advanceExpressionDisplay(
  driver: ExpressionDisplayDriverState,
  simState: SimulationState,
  resetKey: unknown,
  seed: number,
  options: UseActiveExpressionsOptions = {},
): ExpressionDisplayDriverState {
  const { enabled = true, maxConcurrent, scenarioId } = options;

  if (driver.resetKey !== resetKey) {
    return createExpressionDisplayDriverState(simState, resetKey);
  }

  // Pause中(simStateが変化していない)は何もしない。実時間だけで吹き出しが消えることはない。
  if (driver.prevSimState === simState) return driver;

  if (!enabled) {
    // OFF中はderiveExpressionEvents自体を呼ばない(不要な処理の抑制)。prevSimStateだけは
    // 進めておくことで、再度ONにした際にOFF中の全tick分のイベントが一気に噴き出すのを防ぐ。
    return {
      ...driver,
      prevSimState: simState,
      displayed: driver.displayed.length === 0 ? driver.displayed : [],
    };
  }

  const events = deriveExpressionEvents(driver.prevSimState, simState, { seed });

  const candidates = events.map((event) => {
    const agent = simState.agents.find((a) => a.id === event.agentId);
    const isObserverJoiner = agent?.isObserverJoiner ?? false;
    return toExpressionBubbleCandidate(
      event,
      resolveExpressionEventText(event, isObserverJoiner, scenarioId),
      isObserverJoiner,
    );
  });

  const expressions = applyExpressionEvents(driver.expressions, candidates, simState.tick, { maxConcurrent });
  const displayed = Array.from(expressions.active.entries()).map(([agentId, bubble]) => ({
    agentId,
    text: bubble.text,
    isObserverJoiner: bubble.isObserverJoiner,
    intent: bubble.intent,
  }));

  return { resetKey, prevSimState: simState, expressions, displayed };
}

export function useActiveExpressions(
  simState: SimulationState,
  seed: number,
  resetKey: unknown,
  options: UseActiveExpressionsOptions = {},
): ThoughtBubbleDisplay[] {
  const { enabled, maxConcurrent, scenarioId } = options;
  const driverRef = useRef<ExpressionDisplayDriverState>(createExpressionDisplayDriverState(simState, resetKey));
  const [displayed, setDisplayed] = useState<ThoughtBubbleDisplay[]>(driverRef.current.displayed);

  useEffect(() => {
    const next = advanceExpressionDisplay(driverRef.current, simState, resetKey, seed, {
      enabled,
      maxConcurrent,
      scenarioId,
    });
    if (next !== driverRef.current) {
      driverRef.current = next;
      setDisplayed(next.displayed);
    }
  }, [simState, seed, resetKey, enabled, maxConcurrent, scenarioId]);

  return displayed;
}
