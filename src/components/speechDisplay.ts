import type { SpeechEvent, SpeechIntent } from "../simulation/speech";
import { resolveSpeechEventText } from "../simulation/speechTemplates";
import { formatTick } from "../simulation/time";
import type { Agent } from "../simulation/types";

/** `SpeechIntent`の日本語ラベル。状態ログ・Inspectorの両方で使う */
const INTENT_LABEL: Record<SpeechIntent, string> = {
  invite: "誘う",
  welcome: "歓迎",
  greet: "挨拶",
  decline: "辞退",
};

export function speechIntentLabel(intent: SpeechIntent): string {
  return INTENT_LABEL[intent];
}

/** agentId → labelの検索用マップを組み立てる(EventLog/ObserverJoinerInspectorで共有) */
export function buildAgentLabelMap(agents: Agent[]): Map<string, string> {
  return new Map(agents.map((agent) => [agent.id, agent.label]));
}

/** agentId → 表示ラベルの解決。EventLog/ObserverJoinerInspectorに加え、speechEffectsDisplayでも共有する */
export function resolveLabel(agentId: string, labelById: Map<string, string>): string {
  return labelById.get(agentId) ?? agentId;
}

/**
 * 発言の宛先を表す短い日本語句を返す。target(1:1)とaudience(周囲全体)は排他なので、
 * どちらも無ければundefined(このモデルには現状存在しないが将来の拡張に備える)。
 */
export function formatSpeechDestination(event: SpeechEvent, labelById: Map<string, string>): string | undefined {
  if (event.target) {
    return `${resolveLabel(event.target, labelById)}さんへ`;
  }
  if (event.audience === "nearby") {
    return "周囲へ";
  }
  return undefined;
}

/**
 * 「誰が・誰に・何の意図で発言したか」を1行で読み取れる人間向けの短い表示文を組み立てる。
 * 構造化されたSpeechEventの主要属性(speaker/target・audience/intent)をこの文言だけから
 * 追跡できることが目的(Issue #81の受け入れ条件)。
 */
export function formatSpeechLogMessage(event: SpeechEvent, labelById: Map<string, string>): string {
  const speakerLabel = resolveLabel(event.speakerId, labelById);
  const destination = formatSpeechDestination(event, labelById);
  const text = resolveSpeechEventText(event);
  return `${formatTick(event.tick)} ${speakerLabel}さんが${destination ?? ""}「${text}」と発言(${speechIntentLabel(event.intent)})`;
}

/**
 * デバッグ用途の補足行。人間向けの短い表示文(`formatSpeechLogMessage`)と
 * `SpeechEvent`の主要属性(intent/reason/speaker/target/audience)を対応付けられるようにする。
 */
export function formatSpeechDebugMeta(event: SpeechEvent, labelById: Map<string, string>): string {
  const parts = [`intent: ${event.intent}`, `reason: ${event.reason}`, `speaker: ${resolveLabel(event.speakerId, labelById)}`];
  if (event.target) parts.push(`target: ${resolveLabel(event.target, labelById)}`);
  if (event.audience) parts.push(`audience: ${event.audience}`);
  return parts.join(" / ");
}
