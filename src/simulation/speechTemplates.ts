import type { Agent } from "./types";
import type { SpeechEvent, SpeechReason } from "./speech";
import { resolveDivergentExpression } from "./divergenceTemplates";
import type { FormationScenarioId } from "./formationPolicy";
import { getScenarioPresentation } from "../presentation/scenarioPresentation";

/**
 * `SpeechReason`ごとの発言テンプレート文言。文言そのものはこのモジュールでのみ保持し、
 * `speech.ts`(発言生成境界)はここを参照しない(`textKey`の組み立てのみ担当)。
 * engine.tsの状態ログで既に使われている引用文言と表記を揃えている。
 *
 * Issue #118: 乖離場面(本心と対外表現がずれた発言)では、`resolveSpeechEventText`に表示コンテキストを
 * 渡すことで、建前側(発言)の文言を`divergenceTemplates.ts`の乖離専用テンプレートから解決する。
 * コンテキストなし(既存の呼び出し元)では従来どおりreasonごとの1文言を返す(後方互換)。
 */
/** `reason`から実際の発言文言を解決する */
export function resolveSpeechText(reason: SpeechReason, scenarioId?: FormationScenarioId): string {
  return getScenarioPresentation(scenarioId).speechTemplates[reason];
}

/**
 * `resolveSpeechEventText`が乖離場面の建前文言を解決するための表示コンテキスト(Issue #118)。
 * 省略時は従来の非乖離テンプレートを使う(後方互換)。
 */
export type SpeechTextContext = {
  /** 発言の話者(アーキタイプ分類に使う) */
  agent?: Agent;
  /** シナリオ別バリエーション選択に使うプリセットID */
  presetId?: string;
  /** 決定的バリエーション選択の種(本体`SeededRandom`とは独立) */
  seed?: number;
  /** 表示語彙を解決するシナリオ。省略時は二次会表示を維持する */
  scenarioId?: FormationScenarioId;
};

/**
 * `SpeechEvent`から実際の発言文言を解決する。表示側(UI)が`textKey`の文字列構造を
 * 直接パースしなくて済むようにする薄いラッパー(`resolveExpressionEventText`と同じ設計)。
 *
 * Issue #118: `context`が渡され、かつその発言が乖離場面(`event.expression`があり
 * `resolveDivergentExpression`が場面を返す)であれば、建前側の乖離専用文言を返す。
 * それ以外(コンテキストなし・非乖離発言・話者IDの不一致)は従来どおりreasonごとの1文言を返す。
 */
export function resolveSpeechEventText(event: SpeechEvent, context?: SpeechTextContext): string {
  if (
    context?.agent &&
    context.presetId !== undefined &&
    context.seed !== undefined &&
    event.expression &&
    context.agent.id === event.speakerId
  ) {
    const resolution = resolveDivergentExpression({
      link: event.expression,
      intent: event.intent,
      agent: context.agent,
      presetId: context.presetId,
      seed: context.seed,
      tick: event.tick,
      scenarioId: context.scenarioId,
    });
    if (resolution) return resolution.speech;
  }
  return resolveSpeechText(event.reason, context?.scenarioId);
}
