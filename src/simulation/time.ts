/**
 * tick数を mm:ss 形式に変換する(1tick = 3秒換算)。状態ログ(engine.ts)と
 * 発言ログ表示(components/speechDisplay.ts)の両方から参照する共通フォーマッタ。
 */
export function formatTick(tick: number): string {
  const totalSeconds = tick * 3;
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
