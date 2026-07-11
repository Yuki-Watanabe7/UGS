import type { SpeechBubbleDisplaySettingsState } from "./speechBubbleDisplayFilter";

type Props = {
  settings: SpeechBubbleDisplaySettingsState;
  onSettingsChange: (settings: SpeechBubbleDisplaySettingsState) => void;
};

/**
 * 発言吹き出しの表示設定(ON/OFF)。`ExpressionDisplaySettings`(心の声)と対になる、
 * 独立したcheckbox 1つだけのコンパクトな設定パネル。ここでの変更はApp.tsx側で
 * SimulationCanvasへ渡す表示リストを空にする/戻すだけで、シミュレーションstate・ログ・
 * 最終結果には一切影響しない(心の声設定と同じ非介入の保証)。
 */
export function SpeechBubbleDisplaySettings({ settings, onSettingsChange }: Props) {
  return (
    <div className="panel speech-bubble-display-settings">
      <h2>発言表示</h2>
      <p className="speech-bubble-display-note">
        「発言」は他のエージェントへ向けて実際に発せられたセリフです。
        この表示設定を変えてもシミュレーションの結果は変わりません。
      </p>

      <label className="field speech-bubble-display-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => onSettingsChange({ ...settings, enabled: e.target.checked })}
        />
        <span>発言吹き出しを表示する</span>
      </label>
    </div>
  );
}
