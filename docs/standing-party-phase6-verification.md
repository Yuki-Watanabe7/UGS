# standingParty Phase 6 統合検証 (Issue #251 / #252)

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

## Issue #252: 座標・movement不変条件、paired seed、凝集維持、cross-feature、長時間安定性の統合検証

上記(#251)は個々のsimulation rule(#247〜#250)の結線・診断・統計UIを検証する。本節は、それらが
**同時に**働いたときにも「局所固定の緩和」と「社会的凝集の維持」が両立することを、実際のengine run・
paired seed・長時間実行を通じて横断的に検証する(`src/simulation/standingPartyPhase6Verification.test.ts`、
`e2e/standingPartyPhase6.desktop.spec.ts`、`e2e/standingPartyPhase6.mobile.spec.ts`)。

### 発見された問題(#246 ADRの動機)

`docs/spatial-dynamics-phase6-model.md`(#246)が記録するとおり、Phase 5完成時点のstandingPartyは
confirmed clusterの中心・undecided agentの徘徊のいずれも会場内の狭い一角に局所固定されやすく、cluster間
斥力・持続的な徘徊(persistent roaming)・局所crowding avoidance・候補選択の一般化のいずれも欠いていた。
Phase 6(#247〜#250)はこれらを追加したが、「会場を広く使う」ことだけを最大化すると、今度は全員が散開して
会話clusterが成立しない・接触が短すぎる・情報伝播が起こらない、といった逆方向の退化が起こり得る
(本Issueの背景節)。本節の検証は、この2つの要求(空間分散の改善 と 社会的凝集の維持)が実際のrunで
同時に成立することを確認する。

### 検証した指標の定義

累積指標(distinct zones visited・roaming distanceの累積)は#251の対象外節が明記するとおり
`SimulationState`へ新しいruntime historyを追加しないと導出できない。本Issueもruntime拡張は行わず、
テスト自身がrunをtickごとに観測しながら以下を**テスト側で**集計することで、累積相当の指標を得た
(production codeへ手を加えていないため、既存のno-op保証(`spatialDynamics.enabled === false`時の
byte-identical互換)に影響しない)。

| 指標 | 導出方法 |
| --- | --- |
| spatial coverage | `buildStandingPartySpatialAnalysis`の`occupiedCells.rate`を一定間隔でsampleし平均 |
| 訪問zone数(distinct zones visitedの代替) | 計測用grid(8×5)のcell indexを、agent座標から一定間隔でsampleするたびに`Set`へ追加した累積種類数 |
| roaming移動量の合計(roaming distanceの代替) | `AgentSpatialSnapshot.instantRoamingSpeed`(瞬間値)を一定間隔でsampleし合計 |
| cluster間最近接距離 / agent局所密度 / cluster重複率 | `StandingPartySpatialSnapshot`の該当分布をそのままsample |
| 壁際・角セル滞在率 | 計測用gridのcellが端行/端列(壁際)・四隅(角)かどうかで分類し、sample中の該当割合 |

### paired seedでの空間分散改善(退化していないことの確認)

比較preset「立食パーティー(空間回遊あり・分散型)」(`standing-party-spatial-roaming`)と
「立食パーティー(空間固定に近い比較基準)」(`standing-party-spatial-fixed-baseline`)――Phase 2〜5設定は
同一で`spatialDynamics`だけが異なる――を同一seed集合(4 seed)・400tickでpaired実行し、上表の指標を
aggregateして比較した。個々のseedへ単調差を要求せず(ADR §8の方針どおり、`docs/speech-effects-paired
-monte-carlo.md`と同じ考え方)、aggregateした分布・件数で比較する。

- spatial coverage(平均)は有効化presetの方が基準より高い
- 訪問zone数(平均)は有効化presetの方が基準以上
- roaming移動量の合計(平均)は、基準(roaming無効)よりも有効化presetの方が明確に大きい
- cluster間最近接距離(平均)は、有効化presetで基準の9割を下回るような縮小(過密化)は起きていない
- 壁際・角セルへの滞在率は、有効化presetが基準より大幅に(それぞれ+0.35/+0.20を超えて)悪化しない
  ―― 「会場を広く使う」が「壁へ張り付く」「角に収束する」だけになっていないことを確認する

### 逆方向の退化防止(凝集維持)

同じpaired実行(有効化preset側)で、次を確認した。

- active clusterが継続的に0件のままになる seed はない(全seedでactive clusterが観察される)
- joined比率(平均)がほぼ0へ崩壊するseedはない(全seedで10%を上回る)
- 完了した会話episode(`eventType: "clusterDepartureCompleted"`)は、4 seedのうち少なくとも1つで発生する
  (発生tickは離脱判定の確率に依存するため、CLAUDE.mdのpreset 5検証と同じ方針で「複数seedのうち
  少なくとも1つ」で確認する)
- 接触network(`buildStandingPartyContactNetwork`)に非自明なedgeが、4 seedのうち少なくとも1つで形成される

### oscillation/limit cycle検証

- roaming headingの切替頻度は、`roamingHeadingHoldTicksMin`から導かれる理論上限を超えない
  (500tick・複数agentで確認。「震え続ける」高周波振動が起きていない)
- confirmed cluster中心のvelocity x成分の符号反転率は、100tickのうち50%を下回る(毎tick反転する
  高周波振動になっていない)

### Phase 5情報伝播とのcross-feature検証

`SPATIAL_ROAMING_STANDING_PARTY_CONFIG`(spatialDynamics有効)と`INFO_RICH_STANDING_PARTY_CONFIG`の
`informationPropagation`設定を組み合わせ(テスト側でのみ合成、production presetは追加しない)、
500tick×2 seedで実行した。少なくとも1 seedでcontent utterance・reception(heard)・adoptionのいずれも
0へ退化しないことを確認し、あわせて座標・movement不変条件(下記)もこのcross-feature runで同時に検証した。

### 座標・movement不変条件と長時間安定性

`standingPartyInvariants.ts`に`assertStandingPartySpatialInvariants`を追加し(既存の
`assertStandingPartyInvariants`と同じ「テストから毎tick呼び出す」設計を踏襲)、次を1000tick×2 preset×2
seedの長時間runで検証した(NaN/Infinity・world境界外・orphan runtime stateがないこと)。

- 全agent/confirmed clusterのx/yがfinite かつ world境界のclamp範囲内
- `spatialRuntimeState.clusterVelocity`の各entryがconfirmed clusterに対応し(orphanがない)、
  速度が`maxClusterCenterSpeed`を超えない
- `spatialRuntimeState.roaming`の各entryが存在するagentを指し、`approaching`/`forming`/`joined`
  (候補合流状態)とは共存しない ――
  ただし責務9(離脱判定)はroaming計算(step 6)より後の別stepで評価されるため、同一tick内で
  `undecided`から`leaving`/`left`等の「場を離れる」側へ遷移した直後のagentは、そのtickの戻り値に
  限り1tickだけroaming entryが残る(次tickのrebuildで自然に脱落する既知の挙動であり、恒久的な
  孤児化ではない)。この一時的な重なりは許容し、候補合流状態との共存だけを不変条件として扱う。
  発見の経緯: 当初「roaming entryは常に`state === "undecided"`のみを指す」という厳密な不変条件で
  1000tick runを検証したところ、`state === "leaving"`/`"left"`のagentがこの1tickだけ引っかかり、
  production codeのroaming/離脱処理そのものにバグがないことをengine.tsのstep順序(roamingが責務9より
  前)から確認したうえで、不変条件側を「候補合流状態と共存しない」という意味的に正しい条件へ調整した。
- joinedなagentが所属clusterの中心から明らかに取り残されない(`applyMemberFollow`の追従が機能している
  ことの緩やかな上限チェック)

### ordering/determinism

`spatialDynamics.ts`/`spatialOccupancy.ts`/`clusterSearchSelection.ts`各moduleの冒頭コメントが
契約する「入力配列順に依存しない」を、実runから得た現実的なsnapshotに対して直接検証した
(cluster repulsion・crowding vector・候補列挙)。

一方、`stepSimulation`全体(社会的decision含む)をagents配列ごと反転して複数tick回す検証は、共有の
主系列`SeededRandom`を配列走査順に消費するため意図的に採用しなかった――agents配列を逆順にすると
「誰が何番目に`rng.chance()`を引くか」が変わり、Phase 6と無関係に(元々そういう仕様の)異なる乱数列を
消費して別の軌跡になる。これは既存の欠陥ではなく、Phase 6が契約する配列順非依存の範囲が「空間計算
そのもの」であって「共有RNGを消費する社会的decision全体」ではないことを示す発見であり、本検証はその
境界を実データで確認した。

### disabled parity(Phase 6 disabled時のPhase 5互換)

`spatialDynamics.enabled: false`の間は他フィールドの値に一切依存しないno-opであることを、
数値field(`repulsionStrength`/`roamingSpeed`/`crowdRepulsionStrength`等)を大きく変えた2つの
disabled configで同一seed・300tickを実行し、agents/groupCandidates/spatialRuntimeState/logが
byte-identicalになることで確認した(個々のmodule単体の「disabled時の非干渉」テストは#247〜#250の
engine wiringテストが既に持つため、ここでは「どのdisabled configでも同じ結果になる」という
一段上の保証を追加した)。

### spatial analysis/export cross-check

`buildStandingPartyAnalysisExport`の`spatialDynamics` fieldが`buildStandingPartySpatialAnalysis`の
戻り値とid別に一致すること、CSV file一覧に空間統計2ファイルが含まれること、`occupiedCells`が
raw agent座標からの再計算(手計算)と一致すること、export呼び出し自体が`SimulationState`を
mutationしないことを確認した。

### Playwright E2E

`e2e/standingPartyPhase6.desktop.spec.ts`/`.mobile.spec.ts`は、比較preset選択→実行→Inspectorの
「空間diagnostics(Phase 6)」到達→Canvas診断overlay(`.spatial-diagnostic-grid`)のON/OFF→dashboardの
「空間ダイナミクス(Phase 6)」section(spatial coverage表示・分布chart)→JSON/CSV export→
pause/resume/reset→比較基準presetでの無効表示→afterParty/classroomPairへの切替でspatial UIが
残らないこと、をdesktop(1440×900)・iPhone相当幅(320×640)の両方で確認する。

### 実機観察について

本Issueの実装はエージェントによる自動化されたセッションで行われ、この検証ではPC/iPhone実機を人間の目視で
確認する工程の代わりに、上記Playwright E2E(desktop 1440×900・iPhone相当320×640の実Chromiumでの自動実行)
と、`standingPartyPhase6Verification.test.ts`の1000tick級long-run・paired seed検証を実施した。人間による
実機での最終確認は`.claude/skills/verify/SKILL.md`のdev server + Playwright手動確認手順に従って別途
行うことを推奨する(下記コマンド参照)。

### venue anchorについて(今後の拡張候補)

#251のドキュメントが記す「対象外」節のとおり、POI/ドリンク/料理/入口等のvenue anchor実装は本Issue
(#252)でも対象外のままである。paired seed検証で確認した「壁際・角への集中が悪化しない」は、あくまで
既存のwall avoidance・crowding avoidanceの効果であり、venue anchorによる「特定の場所に自然と人が
集まる」という肯定的な引力は今後の別Issueのスコープとして残す。

## 再現性と検証コマンド

```bash
npm run lint
npm run test
npm run build
npm run typecheck:e2e
npm run test:e2e
```

Phase 6だけを反復する場合は次を使う。

```bash
npm test -- src/simulation/spatialDynamics.test.ts src/simulation/roaming.test.ts src/simulation/spatialOccupancy.test.ts src/simulation/clusterSearchSelection.test.ts
npm test -- src/simulation/spatialDynamicsEngineWiring.test.ts src/simulation/roamingEngineWiring.test.ts src/simulation/spatialOccupancyEngineWiring.test.ts src/simulation/clusterSearchSelectionEngineWiring.test.ts
npm test -- src/simulation/spatialAnalysis.test.ts src/simulation/analysisExport.test.ts
npm test -- src/components/StandingPartyAdvancedSettings.test.ts src/components/ObserverJoinerInspector.test.ts src/components/SimulationCanvas.test.ts src/components/StandingPartyAnalyticsDashboard.test.ts
# Issue #252: 座標不変条件・paired seed・凝集維持・cross-feature・長時間安定性の統合検証
npm test -- src/simulation/standingPartyPhase6Verification.test.ts
npx playwright test standingPartyPhase6
```

ブラウザでの手動確認手順は`.claude/skills/verify/SKILL.md`のdev server + Playwright手順に従う。standingParty
プリセットで「Spatial Dynamics 有効化」をONにしてReset後、Start/Step操作で輪が複数領域へ広がっていく様子と、
比較プリセット(`standing-party-spatial-fixed-baseline`)との差を確認する。
