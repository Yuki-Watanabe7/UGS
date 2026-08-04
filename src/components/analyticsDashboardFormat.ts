/**
 * Issue #217: 統計ダッシュボード向けの表示フォーマット。
 * 0と「非該当/未完了」を混同しない。人格評価・人気表現は使わない。
 */
import type { DistributionSummary, RateWithDenominator } from "../simulation/types";

export function formatNumber(value: number | undefined, digits = 2): string {
  if (value === undefined || Number.isNaN(value)) return "非該当";
  if (!Number.isFinite(value)) return "非該当";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(digits);
}

export function formatRate(rate: RateWithDenominator): string {
  if (rate.denominator === 0) return `非該当 (0/${rate.denominator})`;
  if (rate.rate === undefined) return `非該当 (${rate.numerator}/${rate.denominator})`;
  return `${(rate.rate * 100).toFixed(1)}% (${rate.numerator}/${rate.denominator})`;
}

export function formatDistribution(summary: DistributionSummary): string {
  if (summary.count === 0) return "件数0 (中央値・分位点は非該当)";
  return [
    `n=${summary.count}`,
    `median=${formatNumber(summary.median)}`,
    `p25=${formatNumber(summary.p25)}`,
    `p75=${formatNumber(summary.p75)}`,
    `mean=${formatNumber(summary.mean)}`,
  ].join(" / ");
}

export function formatOptionalCount(value: number | undefined, absentLabel: string): string {
  if (value === undefined) return absentLabel;
  return String(value);
}

/** 長時間run向けの時系列間引き。最終tickは#214側が必ず保持する */
export function chooseSeriesSampleInterval(fromTick: number, toTick: number): number {
  const horizon = Math.max(0, toTick - fromTick);
  if (horizon <= 240) return 1;
  return Math.max(1, Math.ceil(horizon / 120));
}
