import type { ExpressionDisplayDensity, ExpressionDisplaySettingsState, ExpressionDisplayTarget } from "./expressionDisplayFilter";

type Props = {
  settings: ExpressionDisplaySettingsState;
  onSettingsChange: (settings: ExpressionDisplaySettingsState) => void;
};

const TARGET_OPTIONS: Array<{ value: ExpressionDisplayTarget; label: string }> = [
  { value: "all", label: "全エージェント" },
  { value: "observerJoiner", label: "observerJoinerのみ" },
  { value: "important", label: "重要イベントのみ" },
];

const DENSITY_OPTIONS: Array<{ value: ExpressionDisplayDensity; label: string }> = [
  { value: "few", label: "少なめ" },
  { value: "standard", label: "標準" },
  { value: "many", label: "多め" },
];

/**
 * 心の声吹き出しの表示設定(ON/OFF・表示対象・表示密度)。常設ボタンを並べず、
 * checkbox 1つ + select 2つのみのコンパクトな構成にする(Issue #66「設定UIをコンパクトにする」)。
 * ここでの変更はApp.tsx側でSimulationCanvasへ渡す表示リストを絞り込むだけで、
 * シミュレーションstate・ログ・最終結果には一切影響しない。
 */
export function ExpressionDisplaySettings({ settings, onSettingsChange }: Props) {
  return (
    <div className="panel expression-display-settings">
      <h2>心の声表示</h2>
      <p className="expression-display-note">
        「心の声」は観察者にだけ見える非介入の表現で、エージェント本人の発言ではありません。
        この表示設定を変えてもシミュレーションの結果は変わりません。
      </p>

      <label className="field expression-display-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => onSettingsChange({ ...settings, enabled: e.target.checked })}
        />
        <span>心の声を表示する</span>
      </label>

      {settings.enabled && (
        <>
          <label className="field">
            <span>表示対象</span>
            <select
              value={settings.target}
              onChange={(e) =>
                onSettingsChange({ ...settings, target: e.target.value as ExpressionDisplayTarget })
              }
            >
              {TARGET_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>表示密度</span>
            <select
              value={settings.density}
              onChange={(e) =>
                onSettingsChange({ ...settings, density: e.target.value as ExpressionDisplayDensity })
              }
            >
              {DENSITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}
