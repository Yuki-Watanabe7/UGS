import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { ControlPanel } from "./components/ControlPanel";
import { RESET_REQUIRED_PARAM_KEYS } from "./components/sliderConfig";
import { EventLog } from "./components/EventLog";
import { AgentLegend } from "./components/AgentLegend";
import { InterventionSelector } from "./components/InterventionSelector";
import { MonteCarloPanel } from "./components/MonteCarloPanel";
import { InterventionComparisonPanel } from "./components/InterventionComparisonPanel";
import { SpeechEffectsComparisonPanel } from "./components/SpeechEffectsComparisonPanel";
import { SimulationCanvas } from "./components/SimulationCanvas";
import { ObserverJoinerInspector } from "./components/ObserverJoinerInspector";
import { SimulationSummaryPanel } from "./components/SimulationSummaryPanel";
import { ExpressionDisplaySettings } from "./components/ExpressionDisplaySettings";
import {
  DEFAULT_EXPRESSION_DISPLAY_SETTINGS,
  EXPRESSION_DISPLAY_DENSITY_MAX_CONCURRENT,
  filterThoughtsForDisplay,
  type ExpressionDisplaySettingsState,
} from "./components/expressionDisplayFilter";
import { SpeechBubbleDisplaySettings } from "./components/SpeechBubbleDisplaySettings";
import {
  DEFAULT_SPEECH_BUBBLE_DISPLAY_SETTINGS,
  type SpeechBubbleDisplaySettingsState,
} from "./components/speechBubbleDisplayFilter";
import { createInitialState, stepSimulation } from "./simulation/engine";
import { SeededRandom } from "./simulation/random";
import { getPresetById } from "./simulation/presets";
import { getInterventionById } from "./simulation/interventions";
import type { InterventionScenarioId } from "./simulation/interventions";
import type { FormationRuntimeOptions } from "./simulation/formationPolicy";
import type { SimParams, SimulationState } from "./simulation/types";
import { useActiveExpressions } from "./hooks/useActiveExpressions";
import { useActiveSpeechBubbles } from "./hooks/useActiveSpeechBubbles";
import { useIsMobile } from "./hooks/useIsMobile";
import { AppLink } from "./components/AppLink";
import {
  getPresetForScenario,
  getPresetsForScenario,
  type ScenarioConfig,
} from "./scenarios";
import { normalizeInterventionForPresentation } from "./presentation/scenarioPresentation";

const TICK_INTERVAL_MS = 250;
const INITIAL_SEED = 12345;

/** Issue #132: 選択中のプリセットに紐づくFormationPolicyの実行時オプションを組み立てる */
function formationOptionsForPreset(presetId: string): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: preset.formationScenarioId ?? "afterParty",
    formationDeadlineTick: preset.formationDeadlineTick,
  };
}

type Props = {
  scenario: ScenarioConfig;
};

function SimulationApp({ scenario }: Props) {
  const isMobile = useIsMobile();
  const scenarioPresets = useMemo(() => getPresetsForScenario(scenario), [scenario]);
  const initialPreset = getPresetForScenario(scenario, scenario.initialPresetId);
  const [presetId, setPresetId] = useState(initialPreset.id);
  const [params, setParams] = useState<SimParams>(initialPreset.params);
  const [seed, setSeed] = useState(INITIAL_SEED);
  const [interventionId, setInterventionId] = useState<InterventionScenarioId>("none");
  const activeInterventionId = normalizeInterventionForPresentation(
    interventionId,
    scenario.presentation,
  );
  const [running, setRunning] = useState(false);
  // Issue #98/#119: 状態ログ・observerJoiner Inspector・CanvasでPhase 3(発言効果)およびPhase 4
  // (本心/建前の乖離・動的trust・関係性補正)の因果を確認できるようにするため、ここでまとめて
  // デフォルト有効化する。以後のstepSimulation呼び出しは各`*Enabled`フラグをstateから引き継ぐ
  // (engine.ts参照)ので、都度渡し直す必要はない。表示層(Inspector/Canvas/EventLog)はこれらを
  // 読み取って可視化するだけで、有効/無効の切り替えやシミュレーション本体の状態遷移には関与しない。
  const [simState, setSimState] = useState<SimulationState>(() =>
    createInitialState(
      INITIAL_SEED,
      initialPreset.params,
      { interventionId: "none" },
      { enabled: true },
      { enabled: true },
      { enabled: true },
      { enabled: true },
      formationOptionsForPreset(initialPreset.id),
    ),
  );
  // 現在のsimStateの生成に実際に使われたparams。Reset必須パラメータが
  // これとparamsとで食い違っている間は、変更がまだ反映されていないとみなす。
  const [appliedParams, setAppliedParams] = useState<SimParams>(initialPreset.params);
  // Reset・プリセット変更・seed変更・再実行のたびにインクリメントする。useActiveExpressionsは
  // この値の変化を「新しい実行が始まった」シグナルとして扱い、古い心の声吹き出しを破棄する。
  const [runId, setRunId] = useState(0);
  // 心の声の表示設定(ON/OFF・表示対象・表示密度)。表示層だけの設定であり、
  // Reset・プリセット変更・seed変更のいずれでもリセットされない(Issue #66の完了条件)。
  const [expressionDisplaySettings, setExpressionDisplaySettings] = useState<ExpressionDisplaySettingsState>(
    DEFAULT_EXPRESSION_DISPLAY_SETTINGS,
  );
  // 発言吹き出しの表示設定(ON/OFF)。心の声と同様、表示層だけの設定でありReset・プリセット変更・
  // seed変更のいずれでもリセットされない。
  const [speechBubbleDisplaySettings, setSpeechBubbleDisplaySettings] = useState<SpeechBubbleDisplaySettingsState>(
    DEFAULT_SPEECH_BUBBLE_DISPLAY_SETTINGS,
  );

  const rngRef = useRef(new SeededRandom(seed));

  const resetSimulation = useCallback(
    (
      nextSeed: number,
      nextParams: SimParams,
      nextInterventionId: InterventionScenarioId,
      nextPresetId: string,
    ) => {
      rngRef.current = new SeededRandom(nextSeed);
      const initialState = createInitialState(
        nextSeed,
        nextParams,
        { interventionId: nextInterventionId },
        { enabled: true },
        { enabled: true },
        { enabled: true },
        { enabled: true },
        formationOptionsForPreset(nextPresetId),
      );
      setSimState(initialState);
      setAppliedParams(nextParams);
      setRunId((id) => id + 1);
      setRunning(false);
    },
    [],
  );

  const activeThoughts = useActiveExpressions(simState, seed, runId, {
    enabled: expressionDisplaySettings.enabled,
    maxConcurrent: EXPRESSION_DISPLAY_DENSITY_MAX_CONCURRENT[expressionDisplaySettings.density],
    scenarioId: scenario.presentation.id,
  });
  const visibleThoughts = filterThoughtsForDisplay(activeThoughts, expressionDisplaySettings.target);

  const visibleSpeeches = useActiveSpeechBubbles(simState, runId, {
    enabled: speechBubbleDisplaySettings.enabled,
    // Issue #119: 乖離場面で発言(建前)と対に本心(心の声)を同時表示するための決定的選択の種・プリセット
    seed,
    presetId,
    scenarioId: scenario.presentation.id,
  });

  const hasPendingResetChanges = RESET_REQUIRED_PARAM_KEYS.some(
    (key) => params[key] !== appliedParams[key],
  );

  // Issue #132: 現在選択中のプリセットに紐づくformationPolicyの実行時オプション。presetIdが変わらない
  // 限り同一参照を保つ(useCallback/useEffectの依存配列に含めても不要な再生成を起こさないため)。
  const formation = useMemo(() => formationOptionsForPreset(presetId), [presetId]);

  const handleStep = useCallback(() => {
    setSimState((prev) =>
      stepSimulation(
        prev,
        params,
        rngRef.current,
        { interventionId: activeInterventionId },
        undefined,
        undefined,
        undefined,
        undefined,
        formation,
      ),
    );
  }, [params, activeInterventionId, formation]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setSimState((prev) => {
        if (prev.finished) {
          setRunning(false);
          return prev;
        }
        return stepSimulation(
          prev,
          params,
          rngRef.current,
          { interventionId: activeInterventionId },
          undefined,
          undefined,
          undefined,
          undefined,
          formation,
        );
      });
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [running, params, activeInterventionId, formation]);

  const handleStartPause = useCallback(() => {
    if (simState.finished) return;
    setRunning((r) => !r);
  }, [simState.finished]);

  const handlePauseForMonteCarlo = useCallback(() => {
    setRunning(false);
  }, []);

  const handleReset = useCallback(() => {
    resetSimulation(seed, params, activeInterventionId, presetId);
  }, [resetSimulation, seed, params, activeInterventionId, presetId]);

  const handleSeedChange = useCallback(
    (nextSeed: number) => {
      setSeed(nextSeed);
      resetSimulation(nextSeed, params, activeInterventionId, presetId);
    },
    [resetSimulation, params, activeInterventionId, presetId],
  );

  const handlePresetChange = useCallback(
    (nextPresetId: string) => {
      const preset = getPresetForScenario(scenario, nextPresetId);
      setPresetId(preset.id);
      setParams(preset.params);
      resetSimulation(seed, preset.params, activeInterventionId, preset.id);
    },
    [resetSimulation, scenario, seed, activeInterventionId],
  );

  const handleInterventionChange = useCallback(
    (nextInterventionId: InterventionScenarioId) => {
      const normalized = normalizeInterventionForPresentation(
        nextInterventionId,
        scenario.presentation,
      );
      setInterventionId(normalized);
      resetSimulation(seed, params, normalized, presetId);
    },
    [resetSimulation, seed, params, presetId, scenario.presentation],
  );

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="app-header-navigation">
          <AppLink to="/" className="back-to-home-link">
            ← シナリオ選択へ
          </AppLink>
          <span className="scenario-category-label">{scenario.homeTitle}</span>
        </div>
        <h1>{scenario.pageTitle}</h1>
        {isMobile ? (
          <details className="app-intro-details">
            <summary>このシミュレーターについて</summary>
            <p>{scenario.introText}</p>
          </details>
        ) : (
          <p>{scenario.introText}</p>
        )}
        <p className="tick-status">
          Tick: {simState.tick} {simState.finished ? "(終了)" : running ? "(実行中)" : "(一時停止)"}
        </p>
        <p className="current-condition">
          プリセット: {getPresetById(presetId).name} / seed: {seed}
          {scenario.presentation.showInterventionControls
            ? ` / 介入: ${getInterventionById(activeInterventionId).name}`
            : ""}
        </p>
      </header>

      <main className="app-main">
        <aside className="sidebar-left">
          <ControlPanel
            running={running}
            seed={seed}
            presetId={presetId}
            params={params}
            onStartPause={handleStartPause}
            onReset={handleReset}
            onStep={handleStep}
            onSeedChange={handleSeedChange}
            onPresetChange={handlePresetChange}
            onParamsChange={setParams}
            hasPendingResetChanges={hasPendingResetChanges}
            collapseSliders={isMobile}
            presets={scenarioPresets}
            presentation={scenario.presentation}
          />
          <ExpressionDisplaySettings
            settings={expressionDisplaySettings}
            onSettingsChange={setExpressionDisplaySettings}
          />
          <SpeechBubbleDisplaySettings
            settings={speechBubbleDisplaySettings}
            onSettingsChange={setSpeechBubbleDisplaySettings}
          />
          {scenario.presentation.showInterventionControls && (
            <InterventionSelector
              interventionId={activeInterventionId}
              onInterventionChange={handleInterventionChange}
              availableInterventionIds={scenario.presentation.availableInterventionIds}
            />
          )}
          <AgentLegend presentation={scenario.presentation} />
          <MonteCarloPanel
            presetId={presetId}
            params={params}
            seed={seed}
            interventionId={activeInterventionId}
            singleSimRunning={running}
            onBeforeRun={handlePauseForMonteCarlo}
            formation={formation}
            presentation={scenario.presentation}
          />
          {scenario.presentation.showInterventionControls && (
            <InterventionComparisonPanel
              presetId={presetId}
              params={params}
              seed={seed}
              interventionId={activeInterventionId}
              singleSimRunning={running}
              onBeforeRun={handlePauseForMonteCarlo}
            />
          )}
          <SpeechEffectsComparisonPanel
            presetId={presetId}
            params={params}
            seed={seed}
            interventionId={activeInterventionId}
            singleSimRunning={running}
            onBeforeRun={handlePauseForMonteCarlo}
            formation={formation}
            presentation={scenario.presentation}
          />
        </aside>

        <section className="center-stage">
          <SimulationCanvas
            agents={simState.agents}
            groupCandidates={simState.groupCandidates}
            width={simState.width}
            height={simState.height}
            formationScenarioId={simState.formationScenarioId}
            runId={runId}
            thoughts={visibleThoughts}
            speeches={visibleSpeeches}
          />
        </section>

        <aside className="sidebar-right">
          <ObserverJoinerInspector state={simState} params={params} seed={seed} presetId={presetId} />
          <SimulationSummaryPanel state={simState} />
          <EventLog
            state={simState}
            presentation={scenario.presentation}
            seed={seed}
            presetId={presetId}
          />
        </aside>
      </main>
    </div>
  );
}

export default SimulationApp;
