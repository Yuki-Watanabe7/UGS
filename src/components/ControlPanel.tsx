import type { SimParams } from "../simulation/types";
import { PRESETS } from "../simulation/presets";

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
};

type SliderDef = {
  key: keyof SimParams;
  label: string;
  min: number;
  max: number;
  step: number;
};

const SLIDERS: SliderDef[] = [
  { key: "populationSize", label: "人数", min: 5, max: 30, step: 1 },
  { key: "groupConfirmSize", label: "二次会成立に必要な人数", min: 2, max: 8, step: 1 },
  { key: "numLeaders", label: "主導者の人数", min: 0, max: 4, step: 1 },
  { key: "overallWillingness", label: "全体の二次会意欲", min: 0, max: 1, step: 0.05 },
  { key: "ambiguityDuration", label: "曖昧な時間の長さ(耐えられる長さ)", min: 0.3, max: 2, step: 0.1 },
  { key: "lateJoinEase", label: "後乗り参加のしやすさ", min: 0, max: 1, step: 0.05 },
  { key: "existingTieStrength", label: "既存関係性の強さ", min: 0, max: 1, step: 0.05 },
  { key: "observerAmbiguityTolerance", label: "observerJoinerの曖昧さ耐性", min: 0, max: 1, step: 0.05 },
  { key: "observerInfluenceAvoidance", label: "observerJoinerの影響回避度", min: 0, max: 1, step: 0.05 },
  { key: "observerLeaveEase", label: "observerJoinerの帰宅しやすさ", min: 0, max: 1, step: 0.05 },
];

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
}: Props) {
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

      <div className="sliders">
        {SLIDERS.map((slider) => (
          <label className="field slider-field" key={slider.key}>
            <span>
              {slider.label}: {params[slider.key].toFixed(slider.step < 1 ? 2 : 0)}
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
    </div>
  );
}
