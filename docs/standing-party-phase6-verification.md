# standingParty Phase 6 統合検証 (Issue #251)

## 目的と範囲

Phase 6は、立食パーティー(`standingParty`)の空間ダイナミクス ―― confirmed cluster間斥力・wall avoidance
(#247)、未所属agentのpersistent roaming・局所crowding avoidance(#248、#249)、候補選択の一般化(#250) ――
の設計(ADR、#246)と実装(#247〜#250)の上に、設定UI・比較プリセット・Inspector診断・Canvas診断overlay・
read-only統計・dashboard・export・文書を追加する(#251)。simulation ruleそのものの新規実装は対象外であり、
既存の5 Issueが実装した挙動をユーザーが安全に観察・比較できるようにすることが本Issueの目的である。

これは仮説的なシミュレーションの内部状態を検証する資料であり、人物の社交性・人気・行動特性を測定・予測・
評価するものではない。spatial coverageが高いことや、cluster間斥力・crowding avoidanceが強く働くことは、
「良い会話」「良いパーティー」を意味しない。

## 用語と因果境界

| 用語 | 意味 | 混同しないもの |
| --- | --- | --- |
| social attraction | `attractiveness()`等、既存の社会的判断式が生む「輪へ集まる力」 | spatial dispersion(空間力) |
| spatial dispersion | cluster間斥力・roaming・crowding avoidanceが生む「会場を広く使う力」 | 社会的評価そのもの |
| roaming | `state === "undecided"`のagentのheading保持型movement | `socialCirculationTendency`(離脱しやすさの意味は変更しない) |
| crowding avoidance | 局所密度に応じた空間補正 | 人への嫌悪・社交拒否 |
| cluster repulsion | confirmed cluster中心同士の押し離し | 会話の質・輪の人気 |
| spatial coverage | 計測専用grid(8×5)における占有cell比率 | 参加者の活発さ・成功指標 |

`docs/spatial-dynamics-phase6-model.md`(ADR、#246)§1.3の対比表を継承する。空間力は移動vectorと候補選択
scoreの一項目としてのみ社会的判断へ接続し、逆方向(空間力が社会的評価値・離脱hazardを直接書き換える)は
行わない。

## 受入条件と自動検証

| 観点 | 主な検証 |
| --- | --- |
| spatialDynamics config validation・相互制約 | `spatialDynamics.test.ts`(#247)、`roaming.test.ts`(#248)、`spatialOccupancy.test.ts`(#249)、`clusterSearchSelection.test.ts`(#250) |
| engine.ts結線・OFF時のbyte-identical互換・非干渉(afterParty/classroomPair) | `spatialDynamicsEngineWiring.test.ts`、`roamingEngineWiring.test.ts`、`spatialOccupancyEngineWiring.test.ts`、`clusterSearchSelectionEngineWiring.test.ts` |
| spatial read model(coverage/radius of gyration/最近接距離/局所密度/重複率)の境界値・決定性・非mutation | `spatialAnalysis.test.ts` |
| Inspector値がread modelと一致(roaming/crowding/候補選択score/所属cluster診断) | `inspection.test.ts`(`buildAgentInspection: spatial`)、`ObserverJoinerInspector.test.ts`(spatial diagnostics section) |
| Canvas diagnostic overlayのON/OFFでmarkup以外に副作用が無いこと | `SimulationCanvas.test.ts`(spatial diagnostics overlay section) |
| 詳細設定UI: 5セクション・resetRequired・非personality-judging文言 | `StandingPartyAdvancedSettings.test.ts` |
| dashboard: 無効時の非評価的空欄表示、有効時の分布・table | `StandingPartyAnalyticsDashboard.test.ts`(Spatial Dynamics section) |
| JSON/CSV export: schema version・CSVファイル一覧・非mutation | `analysisExport.test.ts`、`standingPartyAnalysisPhase4Verification.test.ts` |
| 比較プリセットのconfig妥当性 | `standingPartyScenarioConfig.ts`モジュール読み込み時の`validateStandingPartyScenarioConfig`呼び出し(eager validation) |

## 意図的なスコープ決定: 累積指標について

ADR §8は次の7指標をExit Criteria候補として定義している。

| # | 指標 | 本Issueでの状態 |
| --- | --- | --- |
| 8.1 | spatial coverage(占有cell比率) | 実装済み。`StandingPartySpatialSnapshot.occupiedCells` |
| 8.2 | radius of gyration | 実装済み。`StandingPartySpatialSnapshot.radiusOfGyration` |
| 8.3 | cluster間最近接距離分布 | 実装済み。`StandingPartySpatialSnapshot.clusterNearestNeighborDistance` |
| 8.4 | local density分布 | 実装済み。`StandingPartySpatialSnapshot.localDensity`(agentごとの実数カウント) |
| 8.5 | cluster overlap rate | 実装済み。`StandingPartySpatialSnapshot.clusterOverlapRate` |
| 8.6 | distinct zones visited(累積) | **未実装(本Issue対象外)** |
| 8.7 | roaming distance(累積) | **未実装(本Issue対象外)。瞬間値`instantRoamingSpeed`で代替** |

8.1〜8.5は`state.agents`/`state.groupCandidates`/`state.spatialRuntimeState`の**現在tickのスナップショット**
だけから決定的に導出できる。一方8.6(累積訪問zone数)・8.7(累積roaming距離)・cluster center path length
(§8のcluster指標群の一部)は、定義上「run開始からの積算」を要し、過去tickのagent/cluster位置を保持する
runtime historyが無いと導出できない。

issue #251の対象候補ファイル一覧(`StandingPartyAdvancedSettings.tsx`、`ObserverJoinerInspector.tsx`、
`SimulationCanvas.tsx`、`StandingPartyAnalyticsDashboard.tsx`、`spatialAnalysis.ts`、`analysisExport.ts`、
`presets.ts`、`inspection.ts`)には`engine.ts`が含まれず、対象外節も「spatial runtime ruleの追加・変更」を
明記している。累積履歴の保持は`SimulationState.spatialRuntimeState`の拡張と`engine.ts`側の毎tick積算
(ADR §9.2が`visitedZones`として将来のP6-F項目に予定していたもの)を要するため、本Issueでは実装せず、
現在tick時点で診断可能な瞬間値(`AgentSpatialSnapshot.instantRoamingSpeed`、`crowdingVectorMagnitude`、
`wallAvoidanceMagnitude`)で代替する。これらのfield名・コメントには「累積ではない」ことを明示している
(`spatialAnalysis.ts`冒頭コメント参照)。真の累積追跡は、既存のruntime state「tick間fall backパターン」
(`interventionRuntimeState`・`informationRuntime`と同じ方式)に従って`spatialRuntimeState`を拡張する
別Issueのスコープとする。

同じ理由で、時系列(tick軸のtrend)としてのspatial coverage/local density推移も提供しない ――
過去tickのスナップショットを保持しないため、提供できるのは「現在tick」と「(既存Phase 4/5と同じ仕組みで
導出できる)エピソード・接触ベースの時系列」のみである。dashboardの「空間ダイナミクス」sectionは
現在tickの分布・rateのみを示し、既存の他sectionが持つtime seriesグラフは持たない。

## 観察UIとexport

standingPartyのいずれかのpresetを選び、詳細設定の「Spatial Dynamics 有効化」で`enabled`をONにして
Resetすると、以後のtickでcluster斥力・roaming・crowding avoidance・候補選択の一般化が働く。比較プリセット
「立食パーティー(空間回遊あり・分散型)」(`standing-party-spatial-roaming`)と「立食パーティー
(空間固定に近い比較基準)」(`standing-party-spatial-fixed-baseline`)は、Phase 2〜5設定を同一に保ったまま
`spatialDynamics`だけが異なるため、同一seedでpaired比較できる。

- agentインスペクターの「空間diagnostics(Phase 6)」: roaming向き・残りtick・局所密度・crowding/wall
  avoidanceの大きさ・(候補選択有効時)評価候補数・選択候補・score内訳・所属clusterの空間diagnostics。
- Canvasの「空間diagnostics overlayを表示」toggle(既定OFF、standingPartyのみ表示): 選択中clusterの中心
  velocity vector、選択中undecided agentのroaming向き、計測専用occupancy grid(8×5)の簡易overlay。toggleの
  ON/OFFはsimulation state・PRNG・event列を一切変更しない(表示専用prop、Canvas座標そのものは変えない)。
- 統計ダッシュボードの「空間ダイナミクス(Phase 6)」: spatial coverage・radius of gyration・cluster間
  最近接距離分布・agent局所密度分布・cluster重複率・cluster空間統計table。無効時は評価を含まない空欄
  メッセージを表示する。
- JSON exportは`standing-party-analysis-export/3`(Phase 6追加により`/2`から更新)で、`spatialDynamics`
  フィールド(`schemaVersion: "spatial-dynamics-analysis/1"`、config、現在tick snapshot、agent/cluster配列)
  を追加で含む。CSVは`standing-party-spatial-agent-stats.csv`/`standing-party-spatial-cluster-stats.csv`を
  追加する。raw occupancy grid全tickは出力しない(現在tickのcell占有率・分布のみ)。

表示・toggle・export操作はruntime state・event列・main PRNGを変更しない。

## 再現性と検証コマンド

```bash
npm run lint
npm run test
npm run build
```

Phase 6だけを反復する場合は次を使う。

```bash
npm test -- src/simulation/spatialDynamics.test.ts src/simulation/roaming.test.ts src/simulation/spatialOccupancy.test.ts src/simulation/clusterSearchSelection.test.ts
npm test -- src/simulation/spatialDynamicsEngineWiring.test.ts src/simulation/roamingEngineWiring.test.ts src/simulation/spatialOccupancyEngineWiring.test.ts src/simulation/clusterSearchSelectionEngineWiring.test.ts
npm test -- src/simulation/spatialAnalysis.test.ts src/simulation/analysisExport.test.ts
npm test -- src/components/StandingPartyAdvancedSettings.test.ts src/components/ObserverJoinerInspector.test.ts src/components/SimulationCanvas.test.ts src/components/StandingPartyAnalyticsDashboard.test.ts
```

ブラウザでの手動確認手順は`.claude/skills/verify/SKILL.md`のdev server + Playwright手順に従う。standingParty
プリセットで「Spatial Dynamics 有効化」をONにしてReset後、Start/Step操作で輪が複数領域へ広がっていく様子と、
比較プリセット(`standing-party-spatial-fixed-baseline`)との差を確認する。
