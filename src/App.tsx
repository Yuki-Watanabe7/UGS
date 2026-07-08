import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { ControlPanel } from "./components/ControlPanel";
import { RESET_REQUIRED_PARAM_KEYS } from "./components/sliderConfig";
import { EventLog } from "./components/EventLog";
import { AgentLegend } from "./components/AgentLegend";
import { InterventionSelector } from "./components/InterventionSelector";
import { MonteCarloPanel } from "./components/MonteCarloPanel";
import { InterventionComparisonPanel } from "./components/InterventionComparisonPanel";
import { SimulationCanvas } from "./components/SimulationCanvas";
import { ObserverJoinerInspector } from "./components/ObserverJoinerInspector";
import { SimulationSummaryPanel } from "./components/SimulationSummaryPanel";
import { createInitialState, stepSimulation } from "./simulation/engine";
import { SeededRandom } from "./simulation/random";
import { getPresetById, PRESETS } from "./simulation/presets";
import { getInterventionById } from "./simulation/interventions";
import type { InterventionScenarioId } from "./simulation/interventions";
import type { SimParams, SimulationState } from "./simulation/types";
import { useIsMobile } from "./hooks/useIsMobile";

const TICK_INTERVAL_MS = 250;
const INITIAL_SEED = 12345;

const INTRO_TEXT =
  "このプロトタイプは、二次会に行くかどうかがその場の空気で決まるような、曖昧な移行場面での" +
  "グループ形成過程を可視化します。オレンジ色のエージェントは" +
  "「行きたいが、自分の意思で場を動かしたくない人 (observerJoiner)」です。";

function App() {
  const isMobile = useIsMobile();
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [params, setParams] = useState<SimParams>(PRESETS[0].params);
  const [seed, setSeed] = useState(INITIAL_SEED);
  const [interventionId, setInterventionId] = useState<InterventionScenarioId>("none");
  const [running, setRunning] = useState(false);
  const [simState, setSimState] = useState<SimulationState>(() =>
    createInitialState(INITIAL_SEED, PRESETS[0].params, { interventionId: "none" }),
  );
  // 現在のsimStateの生成に実際に使われたparams。Reset必須パラメータが
  // これとparamsとで食い違っている間は、変更がまだ反映されていないとみなす。
  const [appliedParams, setAppliedParams] = useState<SimParams>(PRESETS[0].params);

  const rngRef = useRef(new SeededRandom(seed));

  const resetSimulation = useCallback(
    (nextSeed: number, nextParams: SimParams, nextInterventionId: InterventionScenarioId) => {
      rngRef.current = new SeededRandom(nextSeed);
      setSimState(createInitialState(nextSeed, nextParams, { interventionId: nextInterventionId }));
      setAppliedParams(nextParams);
      setRunning(false);
    },
    [],
  );

  const hasPendingResetChanges = RESET_REQUIRED_PARAM_KEYS.some(
    (key) => params[key] !== appliedParams[key],
  );

  const handleStep = useCallback(() => {
    setSimState((prev) => stepSimulation(prev, params, rngRef.current, { interventionId }));
  }, [params, interventionId]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setSimState((prev) => {
        if (prev.finished) {
          setRunning(false);
          return prev;
        }
        return stepSimulation(prev, params, rngRef.current, { interventionId });
      });
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [running, params, interventionId]);

  const handleStartPause = useCallback(() => {
    if (simState.finished) return;
    setRunning((r) => !r);
  }, [simState.finished]);

  const handlePauseForMonteCarlo = useCallback(() => {
    setRunning(false);
  }, []);

  const handleReset = useCallback(() => {
    resetSimulation(seed, params, interventionId);
  }, [resetSimulation, seed, params, interventionId]);

  const handleSeedChange = useCallback(
    (nextSeed: number) => {
      setSeed(nextSeed);
      resetSimulation(nextSeed, params, interventionId);
    },
    [resetSimulation, params, interventionId],
  );

  const handlePresetChange = useCallback(
    (nextPresetId: string) => {
      const preset = getPresetById(nextPresetId);
      setPresetId(preset.id);
      setParams(preset.params);
      resetSimulation(seed, preset.params, interventionId);
    },
    [resetSimulation, seed, interventionId],
  );

  const handleInterventionChange = useCallback(
    (nextInterventionId: InterventionScenarioId) => {
      setInterventionId(nextInterventionId);
      resetSimulation(seed, params, nextInterventionId);
    },
    [resetSimulation, seed, params],
  );

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>グループ形成過程シミュレーター</h1>
        {isMobile ? (
          <details className="app-intro-details">
            <summary>このシミュレーターについて</summary>
            <p>{INTRO_TEXT}</p>
          </details>
        ) : (
          <p>{INTRO_TEXT}</p>
        )}
        <p className="tick-status">
          Tick: {simState.tick} {simState.finished ? "(終了)" : running ? "(実行中)" : "(一時停止)"}
        </p>
        <p className="current-condition">
          プリセット: {getPresetById(presetId).name} / seed: {seed} / 介入:{" "}
          {getInterventionById(interventionId).name}
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
          />
          <InterventionSelector
            interventionId={interventionId}
            onInterventionChange={handleInterventionChange}
          />
          <AgentLegend />
          <MonteCarloPanel
            presetId={presetId}
            params={params}
            seed={seed}
            interventionId={interventionId}
            singleSimRunning={running}
            onBeforeRun={handlePauseForMonteCarlo}
          />
          <InterventionComparisonPanel
            presetId={presetId}
            params={params}
            seed={seed}
            interventionId={interventionId}
            singleSimRunning={running}
            onBeforeRun={handlePauseForMonteCarlo}
          />
        </aside>

        <section className="center-stage">
          <SimulationCanvas
            agents={simState.agents}
            groupCandidates={simState.groupCandidates}
            width={simState.width}
            height={simState.height}
          />
        </section>

        <aside className="sidebar-right">
          <ObserverJoinerInspector state={simState} params={params} />
          <SimulationSummaryPanel state={simState} />
          <EventLog log={simState.log} />
        </aside>
      </main>
    </div>
  );
}

export default App;
