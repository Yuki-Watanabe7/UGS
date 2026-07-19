import type { ExpressionEvent, ExpressionReason } from "./expression";
import type { FormationScenarioId } from "./formationPolicy";
import { getScenarioPresentation } from "../presentation/scenarioPresentation";

/**
 * `ExpressionReason`ごとの心の声テンプレート集。文言そのものはこのモジュールでのみ保持し、
 * `expression.ts`はここから取得した`variantCount`をもとに決定的にインデックスを選ぶだけで、
 * 文言の中身には関与しない(UI側も同様、テキストの再解釈はしない)。
 *
 * `observerJoiner`はobserverJoiner専用の言い回しがある場合のみ上書きに使う。
 * 未指定ならgeneralを共有する(一般エージェントとの言い回しの区別は、必要な局面にだけ設ける)。
 *
 * 文言は状態と矛盾しないこと、断定的な性格診断に見えないことを優先し、
 * 吹き出し内で読み切れる短さに留めている。
 */
/** `reason`に対応するテンプレート配列を返す。observerJoiner専用の言い回しがなければgeneralを返す */
export function resolveExpressionVariants(
  reason: ExpressionReason,
  isObserverJoiner: boolean,
  scenarioId?: FormationScenarioId,
): readonly string[] {
  const entry = getScenarioPresentation(scenarioId).expressionTemplates[reason];
  return isObserverJoiner && entry.observerJoiner ? entry.observerJoiner : entry.general;
}

/** `pickTextVariant`が決定的にインデックスを選ぶための、実際に存在するバリエーション数 */
export function getExpressionVariantCount(
  reason: ExpressionReason,
  isObserverJoiner: boolean,
  scenarioId?: FormationScenarioId,
): number {
  return resolveExpressionVariants(reason, isObserverJoiner, scenarioId).length;
}

/** `reason`+`variantIndex`から実際の表示文言を解決する。`ExpressionEvent.textKey`の解決に使う想定 */
export function resolveExpressionText(
  reason: ExpressionReason,
  isObserverJoiner: boolean,
  variantIndex: number,
  scenarioId?: FormationScenarioId,
): string {
  const variants = resolveExpressionVariants(reason, isObserverJoiner, scenarioId);
  return variants[variantIndex % variants.length];
}

const TEXT_KEY_VARIANT_PATTERN = /\.v(\d+)$/;

/**
 * `ExpressionEvent`から実際の表示文言を解決する。`textKey`(`thought.${reason}.v${variant}`)から
 * バリアント番号を取り出し、`event.reason`と合わせて`resolveExpressionText`に渡すだけの薄いラッパー。
 * 表示側(UI)がtextKeyの文字列構造を直接パースしなくて済むようにする。
 */
export function resolveExpressionEventText(
  event: ExpressionEvent,
  isObserverJoiner: boolean,
  scenarioId?: FormationScenarioId,
): string {
  const match = TEXT_KEY_VARIANT_PATTERN.exec(event.textKey);
  const variantIndex = match ? Number(match[1]) : 0;
  return resolveExpressionText(event.reason, isObserverJoiner, variantIndex, scenarioId);
}
