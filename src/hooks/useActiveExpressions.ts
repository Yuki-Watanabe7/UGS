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
};

export function useActiveExpressions(
  simState: SimulationState,
  seed: number,
  resetKey: unknown,
  options: UseActiveExpressionsOptions = {},
): ThoughtBubbleDisplay[] {
  const { enabled = true, maxConcurrent } = options;
  const prevSimStateRef = useRef(simState);
  const resetKeyRef = useRef(resetKey);
  const expressionsRef = useRef<ActiveExpressionsState>(createActiveExpressionsState());
  const [displayed, setDisplayed] = useState<ThoughtBubbleDisplay[]>([]);

  useEffect(() => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      expressionsRef.current = createActiveExpressionsState();
      prevSimStateRef.current = simState;
      setDisplayed([]);
      return;
    }

    if (prevSimStateRef.current === simState) return;

    if (!enabled) {
      // OFF中はderiveExpressionEvents自体を呼ばない(不要な処理の抑制)。prevSimStateRefだけは
      // 進めておくことで、再度ONにした際にOFF中の全tick分のイベントが一気に噴き出すのを防ぐ。
      prevSimStateRef.current = simState;
      setDisplayed((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const events = deriveExpressionEvents(prevSimStateRef.current, simState, { seed });
    prevSimStateRef.current = simState;

    const candidates = events.map((event) => {
      const agent = simState.agents.find((a) => a.id === event.agentId);
      const isObserverJoiner = agent?.isObserverJoiner ?? false;
      return toExpressionBubbleCandidate(event, resolveExpressionEventText(event, isObserverJoiner), isObserverJoiner);
    });

    expressionsRef.current = applyExpressionEvents(expressionsRef.current, candidates, simState.tick, {
      maxConcurrent,
    });
    setDisplayed(
      Array.from(expressionsRef.current.active.entries()).map(([agentId, bubble]) => ({
        agentId,
        text: bubble.text,
        isObserverJoiner: bubble.isObserverJoiner,
        intent: bubble.intent,
      })),
    );
  }, [simState, seed, resetKey, enabled, maxConcurrent]);

  return displayed;
}
