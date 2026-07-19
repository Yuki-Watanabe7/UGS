import type { SpeechEvent } from "../simulation/speech";
import { resolveSpeechEventText, type SpeechTextContext } from "../simulation/speechTemplates";
import { formatSpeechDestination } from "./speechDisplay";

/**
 * `SpeechEvent`をCanvas上の発言吹き出し用の1本のテキストへ組み立てる。
 *
 * - 先頭に💬を付け、色に頼らず「これは発言(心の声ではない)」と分かる手がかりを
 *   テキスト自体にも埋め込む(`EventLog`が発言行に💬を使っているのと表記を揃える)。
 * - `target`/`audience`がある場合は`formatSpeechDestination`(EventLog/Inspectorと共通)で
 *   宛先の補助表現を組み立て、末尾に「→」付きで付与する。どちらも無ければ本文のみ。
 * - 折り返し・吹き出し内での配置は`thoughtBubbleLayout.ts`の既存関数(`wrapThoughtText`
 *   経由)をそのまま再利用するため、ここでは1本の文字列を返すだけでよい。
 */
export function formatSpeechBubbleText(
  event: SpeechEvent,
  labelById: Map<string, string>,
  context?: SpeechTextContext,
): string {
  const destination = formatSpeechDestination(event, labelById);
  const text = resolveSpeechEventText(event, context);
  return `💬${text}${destination ? `→${destination}` : ""}`;
}
