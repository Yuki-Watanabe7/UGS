# 発言効果ON/OFF paired Monte Carlo比較 (Issue #99)

`speechEffectsMonteCarlo.ts`の`compareSpeechEffects`は、同一preset由来`params`・`intervention`・
`baseSeed`・`runs`・`maxTicks`を固定したまま、Phase 3発言効果(`speechEffects.ts`)の`enabled`だけを
`false`(off)/`true`(on)に切り替えてMonte Carloを2回実行し、run i同士をseedで対応付けて比較する。

## 既存の「介入あり/なし比較」との型分離

`compareMonteCarloIntervention`(`monteCarlo.ts`)は介入シナリオの有無を`baseline`/`intervention`という
名前で比較する。`compareSpeechEffects`はこれとは独立した軸(発言効果の有無)を比較するため、
戻り値の型・フィールド名を意図的に分離している:

- `MonteCarloComparisonResult` (`baseline`/`intervention`) と
  `SpeechEffectsComparisonResult` (`off`/`on`) は別の型。
- `MonteCarloConfig`(`speechEffects`フィールドを持つ、単発Monte Carlo実行/既存介入比較用)と
  `SpeechEffectsMonteCarloConfig`(`intervention`は固定するが`speechEffects`という軸自体を持たない
  — off/onは`compareSpeechEffects`が内部で切り替えるため)も別の型。
- 既存指標(`metrics`)とPhase 3固有指標(`phase3Metrics`)を分けて保持する。

## paired性(同一seedでのrng列一致)の根拠

`speechEffects.ts`の`deriveSpeechReceptions`/`deriveSpeechInterpretations`/`deriveSpeechEffects`/
`deriveSpeechActiveEffects`はいずれも`rng`を受け取らない。発言の認知(距離としきい値の比較)・解釈
(性格パラメータ・関係性・現在stateからの決定的な計算)・効果の生成はすべて決定的であり、確率的な
分岐を持たない。したがって`speechEffectsConfig.enabled`をfalse/trueのどちらにしても、
`SeededRandom`が消費される順序・回数は完全に同じになる。off/on同じseedのrunは、Phase 3効果が
実際にengine.tsの4箇所の計算式(attractiveness/接近確率/stress蓄積率/leave判定のしきい値)へ
加算されるかどうかだけが異なり、それ以外の乱数選択(誰が接近するか、等)は同一列をたどる。

## Phase 3固有指標の算出方法

`buildSpeechEffectsRunSummary`(`summary.ts`)が、1run分の最終`SimulationState`から次を導出する:

- `observerJoinerHeardSpeech`: observerJoinerが1件以上の発言を認知(`SpeechReceptionEvent.heard`)したか。
- `hadInterpretationOrEffect`: 中立でない解釈、または`SpeechEffectEvent`が1件以上発生したか。
- `dimensionTotals`: dimension別の`SpeechEffectEvent.outputValue`の絶対値の合計(累積補正の目安)。
- `transitionInfluenced`: 発言効果が状態遷移に寄与したとみなせるか(下記のヒューリスティック)。

### `transitionInfluenced`のヒューリスティックと限界

「発言効果の値がこのtickの意思決定の閾値比較に実際に使われたかどうか」はengine.ts内部で計算される
だけでログに残らないため、厳密な反実仮想検証(効果なしで同じrngならどうなっていたか)はできない。
代わりに、dimensionごとに対応する構造化ログイベントが`SpeechEffectEvent`の有効期間内(`appliedTick`〜
`appliedTick + durationTicks`)に同一受け手について存在するかどうかで判定する、決定的だが近似的な
ヒューリスティックを採用する:

| dimension            | 対応する`SimulationEventType`                          |
| --------------------- | ------------------------------------------------------- |
| `approachProbability` | `observerApproached`                                     |
| `attractiveness`      | `observerJoinedForming` / `observerJoinedConfirmed`      |
| `leaveThreshold`      | `observerLeaveStarted`                                   |
| `stress`              | (対象外。下記参照)                                        |

`stress`次元(`greet`由来、stress蓄積率の緩和)は「その分だけ離脱しなかった」という非イベントにしか
効果が現れず、対応する離散的な状態遷移イベントを持たない。このため`transitionInfluenced`の判定対象
から意図的に除外している(常に寄与なし側として扱う)。将来、蓄積率そのものをログに残すような
instrumentationを追加すれば対応可能だが、本Issueのスコープ外とする。

## 対応しない範囲

- `transitionInfluenced`の反実仮想的な厳密検証(効果を無効化した場合の再実行比較)。
- `stress`次元の状態遷移寄与判定。
- 発言効果モデル自体のパラメータ比較(効果の強度・持続tickの変更はスコープ外)。
