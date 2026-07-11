# 既存の「軽い声かけ介入」とSpeechEventの概念対応・責務境界

Issue #84 の受入条件に対応する設計文書。既存の介入シナリオ`light-observer-invitation`
(observerJoinerへの軽い声かけ)と、Phase 2で導入した`SpeechEvent`(`src/simulation/speech.ts`)の
関係を棚卸しし、両者の概念対応と責務境界を明文化する。実装そのものは先行issue(#79-#83, #90)で
既に完了しており、本文書はその設計意図を後から読み解けるようにするためのものである
(コード変更は伴わない)。

## 1. 既存の「軽い声かけ介入」の棚卸し

実体は`InterventionScenarioId: "light-observer-invitation"`(`src/simulation/interventions.ts`)。

| 項目 | 内容 |
| --- | --- |
| カタログ定義 | `interventions.ts`の`INTERVENTION_SCENARIOS`内、`id: "light-observer-invitation"`(`category: "targetedSupport"`) |
| paramAdjustments | `observerInfluenceAvoidance: -0.2`, `observerLeaveEase: -0.1`(`resolveEffectiveParams`経由で全体に加算適用) |
| 発生条件 | `shouldTriggerLightObserverInvitation`: observerJoinerが`undecided`のまま`LIGHT_INVITATION_MIN_TICK`(5)経過、stressが`leaveThreshold`の30%以上100%未満、かつ`invitedAtTick`未設定(1エージェント1回限り) |
| 声かけ相手の選定 | `selectInvitationAgent`: 近傍(`LIGHT_INVITATION_SEARCH_RADIUS`=160)の`joined`/`forming`/`approaching`エージェントからrngで1人選択。いなければ最寄りの非observerJoinerにフォールバック |
| 状態への直接効果 | `applyLightInvitationEffect`が`agent.invitedAtTick`を設定(mutation)。以後`LIGHT_INVITATION_BOOST_WINDOW`(25tick)の間、`isUnderLightInvitationBoost`が真になり: (1) `attractiveness()`のinfluenceAvoidanceの壁を`LIGHT_INVITATION_INFLUENCE_AVOIDANCE_RESIDUAL`(0.5)まで緩和、(2) 接近確率に`LIGHT_INVITATION_APPROACH_MULTIPLIER`(1.6)を乗算、(3) 「行き場がない」追加ストレスに`LIGHT_INVITATION_STRESS_MULTIPLIER`(0.35)を乗算して軽減 |
| ログ | `state.log`に`eventType: "observerInvited"`のLogEntry(`metadata.inviterAgentId`/`inviterAgentLabel`を含む、タグ`["observerJoiner", "intervention"]`) |
| 集計 | `monteCarlo.ts`の`compareMonteCarloIntervention`が`interventionId: "none"`のbaselineと比較し、`observerJoinerJoinRate`等の差分を`MonteCarloComparisonResult.metrics`として出す。介入固有の集計項目(声かけ回数など)は現状持たない |

**重要**: この介入は`agent.stress`/`attractiveness()`の出力/接近確率という**シミュレーション本体の状態遷移そのもの**を直接変更する。これはPhase 2で導入した`SpeechEvent`の非介入性原則(下記2, 3節)とは別の、既存の介入システムとして最初から持っていた挙動であり、Issue #84でもこの効果量自体の再調整は対応範囲外。

## 2. 概念対応表

`light-observer-invitation`が発生させる「声かけ」という1つの出来事は、`SpeechEvent`
(`src/simulation/speech.ts`)としては以下のように対応付けられる(`engine.ts`内、
`shouldTriggerLightObserverInvitation`が真になった同一ブロックで生成):

| 声かけ介入側の概念 | SpeechEvent側のフィールド | 備考 |
| --- | --- | --- |
| 声をかけた人(`selectInvitationAgent`の戻り値) | `speakerId` | rngで選ばれるため`deriveSpeechEvents`(状態差分からの導出)では復元できず、`engine.ts`が`createSpeechEvent`を直接呼ぶ |
| 声をかけられた人(observerJoiner本人) | `target` | 1対1の呼びかけのため`audience`は使わない(`target`と`audience`は排他) |
| 呼びかけの意図 | `intent: "invite"` | 「一緒に行く?」という誘いなので他のintent(`welcome`/`greet`/`decline`)ではなく`invite` |
| 発生理由 | `reason: "lightObserverInvitation"` | `SpeechReason`の専用値。`speech.ts`側が特定の介入シナリオ名を知っている唯一の箇所 |
| 声かけ相手の探索半径(`LIGHT_INVITATION_SEARCH_RADIUS`) | 対応フィールドなし | `SpeechEvent`は**話者を誰にするかの選定**には使われるが、範囲/到達性そのものを表すフィールドを持たない(3節参照) |
| 声かけ後の後押し効果の強さ・持続期間(`LIGHT_INVITATION_APPROACH_MULTIPLIER`等) | 対応フィールドなし | `SpeechEvent`自体は効果量を持たない。効果は`Agent.invitedAtTick`から独立に導出される(1節) |

`SpeechEvent`は現状、range(到達範囲)・audibility(聞こえやすさ)・strength(発言の強さ)に相当する
フィールドを持たない。`target`(1人向け)または`audience: "nearby"`(周囲全体、実座標近接判定なし)の
どちらかを選ぶ二値的なモデルに留まる(`types.ts`の`SpeechRelation`コメント参照)。これはPhase 2の
スコープが「生成・記録・表示」に限定されているためであり、詳細は4節「Phase 3への拡張点」に記す。

## 3. 責務境界

- **SpeechEventの生成経路は`engine.ts`に一本化されている。** `speech.ts`の`createSpeechEvent`(唯一のコンストラクタ)を呼ぶ箇所は`engine.ts`内に限られ、次の2パターンのみ:
  1. `deriveSpeechEvents`(純粋な状態差分関数): `formingGroupRecruitment`/`approachWelcome`/`joinGreeting`/`leaveDeclaration`。話者が状態遷移の当事者から一意に決まる場合のみ対象。
  2. `engine.ts`内での直接呼び出し: `initiativeFormedCore`/`cliqueFormedCore`(核形成)、および`lightObserverInvitation`。話者がrngで選ばれ、状態差分だけからは復元できない場合。
  同一の「声かけ」が両方の経路から二重生成されることはない(`deriveSpeechEvents`は上記直接呼び出し対象のreasonを明示的に除外している)。新しい介入が発言を伴う場合も、この2パターンのいずれかに従うこと。
- **`createSpeechEvent`/`deriveSpeechEvents`は`SimulationState`・他エージェント・rngのいずれも参照/変更しない純粋関数である。** これが`SpeechEvent`の非介入性(Phase 2境界)の技術的な保証であり、`speechReproducibility.test.ts`/`speechGeneration.test.ts`/`speechBubbleNonInterference.test.ts`で継続的に検証されている。
- **既存介入(`light-observer-invitation`)がstress/attractiveness/接近確率を直接変更する経路(1節)は、`SpeechEvent`の生成/非介入性とは完全に独立した既存の効果メカニズムとして維持する。** `SpeechEvent`(`createSpeechEvent`呼び出し)自体はこれらの効果に一切関与せず、単に「声かけが発生した」という事実を記録するだけである。既存介入の効果はこれまで通り`Agent.invitedAtTick`/`isUnderLightInvitationBoost`経由で適用され続け、Issue #84によってこの経路が変更されることはない(後方互換)。
- **Phase 3へ移管すべき経路**: 「発言を聞いた他エージェントの判断が変化する」という効果全般はPhase 3の担当であり、Phase 2時点では実装しない。ただし`lightObserverInvitation`は「効果」と「発言」が同一トリガー・同一tickで発生する既存のケースであるため、Phase 3で発言起点の効果を導入する際は、既存の`light-observer-invitation`介入の効果(1節)と新しい発言効果が**二重に適用されない**よう設計する必要がある(例: 発言効果側で`lightObserverInvitation` reasonのSpeechEventを扱う場合、既存の`isUnderLightInvitationBoost`による効果をそのまま残すか置き換えるかを明示的に決める)。これはPhase 3着手時の検討事項としてここに記録し、Issue #84の対応範囲そのものには含めない。

## 4. Phase 3への拡張点

Phase 2はSpeechEventの生成・記録・表示までを担い、以下はいずれも意図的に未実装である
(Issue #84の対応しない範囲と同一):

- **発言の到達判定**: 現状`audience: "nearby"`は実座標近接判定を持たず、全エージェントを対象とみなす簡略化(`types.ts`の`SpeechRelation`コメント参照)。実際の到達範囲(range)や聞こえやすさ(audibility)を導入する場合、`SpeechEvent`または関連する新しい型にフィールドを追加する必要がある。
- **受け手別の解釈**: 同じ発言でも受け手によって解釈が異なる(例: influenceAvoidanceが高い人ほど直接的な声かけを重く受け取る等)というモデルは未実装。
- **状態差分・因果追跡**: 現状`SpeechEvent`は状態変化の結果として生成される(`deriveSpeechEvents`)か、独立したトリガーから生成される(直接呼び出し)かのいずれかであり、「この発言が後続のどの状態変化を引き起こしたか」という逆方向の因果関係は保持していない。Phase 3で発言の効果を追跡する場合、この因果関係を表す仕組み(例: 効果適用ログにspeechEvent idを残す等)が必要になる。

> **Phase 3対応済み(Issue #93)**: 上記の型・因果追跡の骨格は`src/simulation/speechEffects.ts`
> (`SpeechReceptionEvent`/`SpeechInterpretationEvent`/`SpeechEffectEvent`)として導入済み。
> ただし距離based の到達判定・性格based の解釈式・Agent状態への実際の効果適用は引き続き
> 未実装(それぞれ次フェーズ以降のスコープ)。詳細は`docs/speech-effects-phase3-boundary.md`参照。

## 5. 単発実行・Monte Carlo・介入比較での一貫性

`createInitialState`/`stepSimulation`(`engine.ts`)が唯一のシミュレーション実行経路であり、
単発実行・`runSimulationToEnd`・`runMonteCarlo`・`compareMonteCarloIntervention`
(いずれも`monteCarlo.ts`)は全てこの2関数を通して同じ`interventionId`解釈・同じ
`SpeechEvent`生成ロジックを共有する。介入比較のbaseline実行のみ`interventionId: "none"`を
明示的に強制するが、これは意図的な差分であり、それ以外の解釈(paramAdjustments・SpeechEvent
生成条件)は常に同一である。

`SimulationState.speechLog`はoptionalフィールドであり、存在しない場合(例: Phase 2以前に
保存されたシナリオ/設定の読み込み)でもシミュレーション本体のロジックは影響を受けない。

## 6. 参照

- Issue #84(本文書が対応するissue)、#79-#83, #90(先行実装)
- `src/simulation/speech.ts`, `src/simulation/interventions.ts`, `src/simulation/engine.ts`, `src/simulation/types.ts`
- `src/simulation/speechReproducibility.test.ts`, `speechGeneration.test.ts`, `speech.test.ts`, `speechBubbleNonInterference.test.ts`, `interventions.test.ts`
