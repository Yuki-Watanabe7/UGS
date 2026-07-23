import type { QuantileSummary } from "./types";

/**
 * Issue #170: Monte Carlo集計へ中央値(p50)・上位分位点(p90)を追加するための共通の純粋関数。
 *
 * 入力契約: `values`はNaN/undefinedを含まない有限数値の配列であること(呼び出し側でフィルタ済みで
 * あることを前提とする。この関数自体は値の妥当性を検証しない)。空配列は「対象データなし」を意味し、
 * 呼び出し側が`undefined`として扱いたい場合は`values.length === 0`を別途チェックすること
 * (この関数自体は常に有限の数値を返し、`NaN`を返さない)。
 *
 * 補間方式: 線形補間(R-7、`Array.prototype.sort`の数値比較でソート後、
 * `rank = p/100 * (n-1)`の位置を上下2値から線形補間する)。1件のみの配列は常にその値を返す。
 */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const clampedP = Math.min(100, Math.max(0, p));
  const rank = (clampedP / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const weight = rank - lowerIndex;
  return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * weight;
}

/** `values`からp50/p90をまとめて算出する(`quantile`の入力契約をそのまま引き継ぐ) */
export function computeQuantileSummary(values: readonly number[]): QuantileSummary {
  return { p50: quantile(values, 50), p90: quantile(values, 90) };
}
