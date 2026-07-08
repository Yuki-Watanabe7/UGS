import type { SimParams } from "../simulation/types";
import { PRESETS } from "../simulation/presets";
import { APPLY_MODE_LABEL, SLIDERS } from "./sliderConfig";

type Props = {
  running: boolean;
  seed: number;
  presetId: string;
  params: SimParams;
  onStartPause: () => void;
  onReset: () => void;
  onStep: () => void;
  onSeedChange: (seed: number) => void;
  onPresetChange: (presetId: string) => void;
  onParamsChange: (params: SimParams) => void;
  hasPendingResetChanges: boolean;
  // スマホ幅では詳細パラメータを折りたたんで、基本操作を優先表示する
  collapseSliders?: boolean;
};

export function ControlPanel({
  running,
  seed,
  presetId,
  params,
  onStartPause,
  onReset,
  onStep,
  onSeedChange,
  onPresetChange,
  onParamsChange,
  hasPendingResetChanges,
  collapseSliders = false,
}: Props) {
  const sliders = (
    <div className="sliders">
      {SLIDERS.map((slider) => (
        <label className="field slider-field" key={slider.key}>
          <span>
            {slider.label}: {params[slider.key].toFixed(slider.step < 1 ? 2 : 0)}
            <span className={`apply-mode-badge apply-mode-badge--${slider.applyMode}`}>
              {APPLY_MODE_LABEL[slider.applyMode]}
            </span>
          </span>
          <input
            type="range"
            min={slider.min}
            max={slider.max}
            step={slider.step}
            value={params[slider.key]}
            onChange={(e) =>
              onParamsChange({ ...params, [slider.key]: Number(e.target.value) })
            }
          />
        </label>
      ))}
    </div>
  );

  return (
    <div className="panel control-panel">
      <h2>操作パネル</h2>
      <div className="control-buttons">
        <button type="button" onClick={onStartPause}>
          {running ? "Pause" : "Start"}
        </button>
        <button type="button" onClick={onStep} disabled={running}>
          Step 1 tick
        </button>
        <button type="button" onClick={onReset}>
          Reset
        </button>
      </div>

      <label className="field">
        <span>Seed</span>
        <input
          type="number"
          value={seed}
          onChange={(e) => onSeedChange(Number(e.target.value) || 0)}
        />
      </label>

      <label className="field">
        <span>シナリオプリセット</span>
        <select value={presetId} onChange={(e) => onPresetChange(e.target.value)}>
          {PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>
      <p className="preset-description">
        {PRESETS.find((p) => p.id === presetId)?.description}
      </p>

      {hasPendingResetChanges && (
        <p className="reset-required-banner">
          一部の変更はReset後に反映されます
        </p>
      )}

      {collapseSliders ? (
        <details className="sliders-details">
          <summary>詳細パラメータ</summary>
          {sliders}
        </details>
      ) : (
        sliders
      )}
    </div>
  );
}
