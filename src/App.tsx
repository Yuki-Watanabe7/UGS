import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { ControlPanel } from "./components/ControlPanel";
import { RESET_REQUIRED_PARAM_KEYS } from "./components/sliderConfig";
import { EventLog } from "./components/EventLog";
import { AgentLegend } from "./components/AgentLegend";
import { InterventionSelector } from "./components/InterventionSelector";
import { MonteCarloPanel } from "./components/MonteCarloPanel";
import { InterventionComparisonPanel } from "./components/InterventionComparisonPanel";
import { GroupFormationComparisonPanel } from "./components/GroupFormationComparisonPanel";
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
import { StandingPartyAdvancedSettings } from "./components/StandingPartyAdvancedSettings";
import { ConversationHistoryTimeline } from "./components/ConversationHistoryTimeline";
import { ContactNetworkGraph } from "./components/ContactNetworkGraph";
import {
  DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  validateStandingPartyScenarioConfig,
} from "./simulation/standingPartyScenarioConfig";
import type { StandingPartyScenarioConfig } from "./simulation/standingPartyScenarioConfig";
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
  resolvePresentationForPreset,
  type ScenarioConfig,
} from "./scenarios";
import { normalizeInterventionForPresentation } from "./presentation/scenarioPresentation";

const TICK_INTERVAL_MS = 250;
const INITIAL_SEED = 12345;

/**
 * Issue #132: 選択中のプリセットに紐づくFormationPolicyの実行時オプションを組み立てる。
 * Issue #189: `standingPartyConfig`はプリセットの既定値ではなく、呼び出し側(App.tsx)が管理する
 * 現在適用中の値(ユーザー編集を含む)を明示的に受け取る ―― プリセット切替時はプリセットの既定値、
 * Reset/Seed変更時は編集済みの値、と呼び出し側の意図によって使い分けるため。
 */
/**
 * Issue #189 (要件1節): UIのslider min/max/stepだけに頼らず、domain layerでも不正値を拒否する
 * (defense-in-depth)。sliderの構造上ここに到達する値は既に有効域内のはずだが、万一不正な値が
 * 渡された場合は既定値へ安全にフォールバックし、シミュレーション自体をクラッシュさせない。
 */
function sanitizedStandingPartyConfig(config: StandingPartyScenarioConfig): StandingPartyScenarioConfig {
  try {
    validateStandingPartyScenarioConfig(config);
    return config;
  } catch (error) {
    console.error("Invalid standingPartyConfig, falling back to default:", error);
    return DEFAULT_STANDING_PARTY_SCENARIO_CONFIG;
  }
}

function formationOptionsForPreset(
  presetId: string,
  standingPartyConfig: StandingPartyScenarioConfig,
): FormationRuntimeOptions {
  const preset = getPresetById(presetId);
  return {
    scenarioId: preset.formationScenarioId ?? "afterParty",
    formationDeadlineTick: preset.formationDeadlineTick,
    classroomGroupSize: preset.formationClassroomGroupSize,
    standingPartyConfig: sanitizedStandingPartyConfig(standingPartyConfig),
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
  // Issue #189 (Phase 2): standingParty専用のPhase 2設定。他シナリオではformationPolicy.ts側が
  // 常に無視するため保持しても無害だが、プリセット切替時はプリセットの既定値へ戻す(下記handlePresetChange)。
  const [standingPartyConfig, setStandingPartyConfig] = useState<StandingPartyScenarioConfig>(
    initialPreset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG,
  );
  const [seed, setSeed] = useState(INITIAL_SEED);
  const [interventionId, setInterventionId] = useState<InterventionScenarioId>("none");
  // Issue #155: プリセットごとの班人数設定(ペア/3人班/4人班/3〜4人班)に応じて、ペア/班の表示語彙・
  // 容量表示を動的に解決する。二次会シナリオでは常にシナリオ固定の静的な presentation と同一になる。
  const presentation = useMemo(
    () => resolvePresentationForPreset(scenario, getPresetById(presetId)),
    [scenario, presetId],
  );
  const activeInterventionId = normalizeInterventionForPresentation(
    interventionId,
    presentation,
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
      formationOptionsForPreset(initialPreset.id, standingPartyConfig),
    ),
  );
  // 現在のsimStateの生成に実際に使われたparams。Reset必須パラメータが
  // これとparamsとで食い違っている間は、変更がまだ反映されていないとみなす。
  const [appliedParams, setAppliedParams] = useState<SimParams>(initialPreset.params);
  // Issue #189: 同様に、現在のsimStateの生成に実際に使われたstandingPartyConfig。
  const [appliedStandingPartyConfig, setAppliedStandingPartyConfig] =
    useState<StandingPartyScenarioConfig>(standingPartyConfig);
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
  // Issue #202 (Phase 3): Inspectorで選択中のagentをCanvasと共有し、選択中agentのpending transition
  // targetだけをCanvas上に表示できるようにする(全agentの関心線は表示しない)。
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(undefined);
  // Issue #215: 会話履歴タイムラインとCanvasで共有するcluster選択(表示専用。sim/PRNG非介入)。
  const [selectedClusterId, setSelectedClusterId] = useState<string | undefined>(undefined);
  // Issue #216: 接触networkのinterval → timeline tick範囲連携(表示専用)。
  const [historyTickWindow, setHistoryTickWindow] = useState<
    { fromTick?: number; toTick?: number } | undefined
  >(undefined);

  const rngRef = useRef(new SeededRandom(seed));

  const resetSimulation = useCallback(
    (
      nextSeed: number,
      nextParams: SimParams,
      nextInterventionId: InterventionScenarioId,
      nextPresetId: string,
      nextStandingPartyConfig: StandingPartyScenarioConfig,
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
        formationOptionsForPreset(nextPresetId, nextStandingPartyConfig),
      );
      setSimState(initialState);
      setAppliedParams(nextParams);
      setAppliedStandingPartyConfig(nextStandingPartyConfig);
      setRunId((id) => id + 1);
      setRunning(false);
    },
    [],
  );

  const activeThoughts = useActiveExpressions(simState, seed, runId, {
    enabled: expressionDisplaySettings.enabled,
    maxConcurrent: EXPRESSION_DISPLAY_DENSITY_MAX_CONCURRENT[expressionDisplaySettings.density],
    scenarioId: presentation.id,
  });
  const visibleThoughts = filterThoughtsForDisplay(activeThoughts, expressionDisplaySettings.target);

  const visibleSpeeches = useActiveSpeechBubbles(simState, runId, {
    enabled: speechBubbleDisplaySettings.enabled,
    // Issue #119: 乖離場面で発言(建前)と対に本心(心の声)を同時表示するための決定的選択の種・プリセット
    seed,
    presetId,
    scenarioId: presentation.id,
  });

  // Issue #189: standingPartyConfigは丸ごとresetRequired(agent生成・FormationPolicy構築時にのみ
  // 使われるため)。ネストした値のためJSON比較で十分(数値のみの構造)。
  const hasPendingResetChanges =
    RESET_REQUIRED_PARAM_KEYS.some((key) => params[key] !== appliedParams[key]) ||
    JSON.stringify(standingPartyConfig) !== JSON.stringify(appliedStandingPartyConfig);

  // Issue #132: 現在選択中のプリセットに紐づくformationPolicyの実行時オプション。Issue #189:
  // standingPartyConfigは「適用済み」の値を使う(resetRequiredのため、Reset前の編集中の値では
  // 進行中のtickへ即座に反映しない)。presetId/appliedStandingPartyConfigが変わらない限り
  // 同一参照を保つ(useCallback/useEffectの依存配列に含めても不要な再生成を起こさないため)。
  const formation = useMemo(
    () => formationOptionsForPreset(presetId, appliedStandingPartyConfig),
    [presetId, appliedStandingPartyConfig],
  );

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
    resetSimulation(seed, params, activeInterventionId, presetId, standingPartyConfig);
  }, [resetSimulation, seed, params, activeInterventionId, presetId, standingPartyConfig]);

  const handleSeedChange = useCallback(
    (nextSeed: number) => {
      setSeed(nextSeed);
      resetSimulation(nextSeed, params, activeInterventionId, presetId, standingPartyConfig);
    },
    [resetSimulation, params, activeInterventionId, presetId, standingPartyConfig],
  );

  const handlePresetChange = useCallback(
    (nextPresetId: string) => {
      const preset = getPresetForScenario(scenario, nextPresetId);
      const nextStandingPartyConfig = preset.formationStandingPartyConfig ?? DEFAULT_STANDING_PARTY_SCENARIO_CONFIG;
      setPresetId(preset.id);
      setParams(preset.params);
      setStandingPartyConfig(nextStandingPartyConfig);
      resetSimulation(seed, preset.params, activeInterventionId, preset.id, nextStandingPartyConfig);
    },
    [resetSimulation, scenario, seed, activeInterventionId],
  );

  const handleInterventionChange = useCallback(
    (nextInterventionId: InterventionScenarioId) => {
      const normalized = normalizeInterventionForPresentation(
        nextInterventionId,
        presentation,
      );
      setInterventionId(normalized);
      resetSimulation(seed, params, normalized, presetId, standingPartyConfig);
    },
    [resetSimulation, seed, params, presetId, presentation, standingPartyConfig],
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
          {presentation.showInterventionControls
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
            presentation={presentation}
          />
          {presentation.id === "standingParty" && (
            <StandingPartyAdvancedSettings
              config={standingPartyConfig}
              onConfigChange={setStandingPartyConfig}
              hasPendingChanges={JSON.stringify(standingPartyConfig) !== JSON.stringify(appliedStandingPartyConfig)}
            />
          )}
          <ExpressionDisplaySettings
            settings={expressionDisplaySettings}
            onSettingsChange={setExpressionDisplaySettings}
          />
          <SpeechBubbleDisplaySettings
            settings={speechBubbleDisplaySettings}
            onSettingsChange={setSpeechBubbleDisplaySettings}
          />
          {presentation.showInterventionControls && (
            <InterventionSelector
              interventionId={activeInterventionId}
              onInterventionChange={handleInterventionChange}
              availableInterventionIds={presentation.availableInterventionIds}
            />
          )}
          <AgentLegend presentation={presentation} />
          <MonteCarloPanel
            presetId={presetId}
            params={params}
            seed={seed}
            interventionId={activeInterventionId}
            singleSimRunning={running}
            onBeforeRun={handlePauseForMonteCarlo}
            formation={formation}
            presentation={presentation}
          />
          {presentation.showInterventionComparison && (
            <InterventionComparisonPanel
              presetId={presetId}
              params={params}
              seed={seed}
              interventionId={activeInterventionId}
              singleSimRunning={running}
              onBeforeRun={handlePauseForMonteCarlo}
            />
          )}
          {presentation.showGroupFormationComparison && (
            <GroupFormationComparisonPanel
              presetId={presetId}
              params={params}
              seed={seed}
              singleSimRunning={running}
              onBeforeRun={handlePauseForMonteCarlo}
              formation={formation}
              presentation={presentation}
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
            presentation={presentation}
          />
        </aside>

        <section className="center-stage">
          <SimulationCanvas
            agents={simState.agents}
            groupCandidates={simState.groupCandidates}
            width={simState.width}
            height={simState.height}
            formationScenarioId={simState.formationScenarioId}
            formationClassroomGroupSize={simState.formationClassroomGroupSize}
            runId={runId}
            thoughts={visibleThoughts}
            speeches={visibleSpeeches}
            tick={simState.tick}
            selectedAgentId={selectedAgentId}
            selectedClusterId={presentation.id === "standingParty" ? selectedClusterId : undefined}
          />
        </section>

        <aside className="sidebar-right">
          <ObserverJoinerInspector
            state={simState}
            params={params}
            seed={seed}
            presetId={presetId}
            selectedAgentId={selectedAgentId}
            onSelectedAgentIdChange={setSelectedAgentId}
          />
          {presentation.id === "standingParty" && (
            <>
              <ContactNetworkGraph
                state={simState}
                selectedAgentId={selectedAgentId}
                onSelectedAgentIdChange={setSelectedAgentId}
                selectedClusterId={selectedClusterId}
                onSelectedClusterIdChange={setSelectedClusterId}
                onTimelineFocus={(focus) => {
                  if (focus.agentId !== undefined) setSelectedAgentId(focus.agentId);
                  if (focus.clusterId !== undefined) setSelectedClusterId(focus.clusterId);
                  setHistoryTickWindow({
                    fromTick: focus.fromTick,
                    toTick: focus.toTick,
                  });
                }}
              />
              <ConversationHistoryTimeline
                state={simState}
                selectedAgentId={selectedAgentId}
                onSelectedAgentIdChange={setSelectedAgentId}
                selectedClusterId={selectedClusterId}
                onSelectedClusterIdChange={setSelectedClusterId}
                linkedTickWindow={historyTickWindow}
              />
            </>
          )}
          <SimulationSummaryPanel state={simState} params={params} />
          <EventLog
            state={simState}
            presentation={presentation}
            seed={seed}
            presetId={presetId}
          />
        </aside>
      </main>
    </div>
  );
}

export default SimulationApp;
