# Phase 3: 複数発言の競合・累積・更新・上限制御を決定的に実装する

Issue #97 の受入条件に対応する設計文書。Issue #96 で導入した`SpeechActiveEffect`(発言由来の
持続・減衰付き効果)は、同一受け手・同一次元へ複数件同時に有効になり得るが、`sumActiveEffectValue`は
それらを単純加算するだけで、累積の上限・競合・重複適用・再発言の扱いを一切定義していなかった
(Issue #96の対応しない範囲として明記済み)。本issueはその集約規則を決定的に定義する。
`SpeechActiveEffect`自体の生成・減衰モデルは`docs/speech-effects-application-model.md`を参照。

## 1. 集約キー

`aggregateActiveEffects`/`sumActiveEffectValue`は、`activeSpeechEffects`を
**`receiverId × dimension`(・`dimension === "attractiveness"`のときのみ`targetGroupId`も含む)**
で絞り込んでから集約する。これはIssue #96時点の`sumActiveEffectValue`のフィルタ条件をそのまま踏襲する。

## 2. 同一tick内の安定した処理順序

`compareActiveEffectOrder`(`speechEffects.ts`)が、`aggregateActiveEffects`の集約処理・
`registerActiveSpeechEffects`の登録処理の両方で使う唯一の順序基準:

```
startedAtTick(発生tick) -> speechEventId -> receiverId -> dimension -> id
```

`SpeechActiveEffect`自体はtickに依存しないオブジェクトのため、「発生tick」の代わりに
`startedAtTick`(=生成元`SpeechEffectEvent.appliedTick`)を使う。この順序で並べ替えてから
処理するため、**呼び出し側が渡す配列の並び順(入力順)に一切依存せず、常に同じ結果になる**
(受入条件: 「同一入力集合なら入力配列順に依存せず同じ集約値になる」。
`speechEffects.test.ts`の"is independent of the input array's order (reversal invariant)"で検証)。

## 3. 同方向効果の累積規則: 上限付き加算

`DIMENSION_EFFECT_LIMIT`(`speechEffects.ts`)が、次元ごとの安全な最大値を
`DIMENSION_UNIT[dimension].magnitude`(単一の全力発言1件分の基礎強度)の3倍と定義する:

| dimension | 基礎強度 | 上限(`DIMENSION_EFFECT_LIMIT`) |
| --- | --- | --- |
| stress | 0.03 | 0.09 |
| attractiveness | 0.35 | 1.05 |
| approachProbability | 0.25 | 0.75 |
| leaveThreshold | 0.15 | 0.45 |

正方向の寄与(`value > 0`)と負方向の寄与(`value < 0`)をそれぞれ独立に合計し、この上限で
clampする(「上限付き加算」を選択し、逓減合成は採用しない — 単純な打ち切りの方が、
どの発言が上限超過分として切り捨てられたか`positiveContributions`/`negativeContributions`
そのままから判断でき、説明可能性が高いため)。

## 4. 反対方向効果の競合規則: net化

上限clamp済みの正方向合計・負方向合計を単純に加算してnet値を得る(「正負をnet化する」)。
**両方の寄与元は`AggregatedActiveEffect.positiveContributions`/`negativeContributions`に
そのまま残る**ため、net化後も「どちらの方向にどの発言がどれだけ効いていたか」を遡って
説明できる(受入条件: 「両方の寄与元は因果追跡用に保持する」)。

## 5. 同じ発言の重複適用の禁止

同一`speechEventId`が(通常は起こらないが、防御的に)複数の一致effectを生成していた場合、
`compareActiveEffectOrder`の安定順序で最初の1件のみを寄与として数え、以降は
`AggregatedActiveEffect.duplicateContributions`へ分離する(集約値には算入しない)。

## 6. 同一話者・同一intentの再発言: 置換(更新)

`registerActiveSpeechEffects`(`speechEffects.ts`、`engine.ts`の`stepSimulation`末尾で
`nextState.activeSpeechEffects`を組み立てる際に使用)が、既存の`activeSpeechEffects`と
このtickで新規生成された効果をどう合成するかを定義する。

受入条件が求める「置換/更新/cooldownのいずれかを明示する」に対し、本issueは**置換(更新)**を選ぶ:
新しい効果が、既存の(まだ期限切れでない)効果と
**同一`receiverId`・同一`dimension`・同一`speakerId`・同一`intent`**
(`dimension === "attractiveness"`のときは同一`targetGroupId`も)を共有する場合、
古い効果を取り除いてから新しい効果を追加する。

cooldownを採用しなかった理由: 「一定tick数は再発言を無視する」規則は、`engine.ts`側の各種
発言生成トリガー(核形成・接近・合流・離脱)がいつ再度同じ話者×intentの発言を生成するかに
依存した暗黙の相互作用を持ち込み、説明可能性を下げる。置換であれば「常に最新の発言が
その時点の強度・持続期間で効く」という単純な規則で説明でき、かつ「同じ話者が同じ趣旨の
発言を繰り返しても効果が際限なく積み上がらない」という受入条件の意図(上限制御)にも合致する。

話者/intentが異なる複数の発言が同時に効いている場合(例: 2人が別々に同じ受け手をinviteした)は
置換の対象にならず、通常通り第3節の上限付き加算・第4節のnet化の対象になる。

## 7. dimensionごとの安全な最小値・最大値とclamp

`aggregateActiveEffects`が最終的に返す`value`は、正負合計をnetした後、もう一度
`DIMENSION_EFFECT_LIMIT`で`[-limit, limit]`へclampする。正負それぞれが既に独立にこの範囲へ
clampされているため(第3節)、この最終clampは数学的には冗長だが、将来正負の上限ロジックが
変わった場合でも安全範囲を保証する防御的な二重チェックとして明示的に残す
(受入条件: 「次元ごとに安全な最小値・最大値を定義し、stressや確率を有効範囲へclampする」)。

`engine.ts`側の`agent.stress`(0〜1)・接近確率(0〜0.9)・`attractiveness()`(0〜1.5)自体の
clampはIssue #96時点から変更していない。本issueが追加するのは、それらの計算式へ加算される
**発言由来の補正そのもの**が単独でどこまで動かせるかという上限である。

## 8. 期限切れ効果の除外・履歴とactive setの分離

`aggregateActiveEffects`/`registerActiveSpeechEffects`はいずれも、呼び出し側が
`advanceActiveSpeechEffects`で期限切れ(`tick >= expiresAtTick`)を除去済みの`activeEffects`を
渡すことを前提とする(`engine.ts`の`stepSimulation`冒頭、Issue #96から変更なし)。
`SimulationState.speechEffectLog`(履歴、時系列蓄積のみ)と`activeSpeechEffects`
(現在有効な効果のスナップショット)の分離もIssue #96から変更しない。

## 9. 集約結果の永続化について(対応しない範囲の判断)

`AggregatedActiveEffect`(集約後の値と、寄与した各`speechEventId`・個別寄与の内訳)は、
`aggregateActiveEffects`が呼ばれるたびに`activeSpeechEffects`(状態)から決定的に導出できる
純粋な計算結果であり、`SimulationState`に新しい永続ログとして保持することはしない。
`activeSpeechEffects`自体が`speechEffectsEnabled`と同一seedの下で完全に再現可能
(`speechEffectsWiring.test.ts`の"reproducibility"テストで検証)であるため、
「同一seedで状態系列と集約履歴が再現される」という受入条件は、
`aggregateActiveEffects(state.activeSpeechEffects, ...)`を任意のtickで呼び出すことで
常に同じ結果が得られる、という形で満たされる。UI表示・新しい永続ログの追加は対応しない範囲
(issue記載の「UI表示、Monte Carlo比較」)。

## 10. 対応した範囲・対応しなかった範囲

対応した範囲(このissueのスコープ):

- `receiverId × dimension（× targetGroupId）`での集約とその安定した処理順序の固定
- 同方向効果の上限付き加算、反対方向効果のnet化(両寄与元の保持)
- 同一`speechEventId`の重複適用禁止
- 同一話者・同一intentの再発言の置換(更新)規則
- dimensionごとの安全な最小値・最大値とその最終clamp
- 配列順反転でも同じ集約結果になることのproperty/invariantテスト
- `engine.ts`の4箇所の適用先(attractiveness/接近確率/stress蓄積率/leave実効しきい値)が
  `sumActiveEffectValue`経由で新規則を透過的に受け取ること

対応しなかった範囲(意図的に対応しない、issue記載の対応しない範囲そのまま):

- 会話ターンや返答生成
- 信頼・評判の永続更新
- intent別テンプレート追加
- UI表示、Monte Carlo比較
- 集約結果(`AggregatedActiveEffect`)を新しい永続ログとして`SimulationState`に保持すること
  (第9節の判断により、純粋関数の戻り値として都度導出可能なため対応しない)

## 11. 参照

- Issue #97(本文書が対応するissue)、親ロードマップ #61、Depends on: #96
- `docs/speech-effects-application-model.md`(Issue #96、`SpeechActiveEffect`の生成・減衰・適用モデル)
- `docs/speech-effects-phase3-boundary.md`(Issue #93、3段階のイベントモデルの責務境界)
- `src/simulation/speechEffects.ts`(`aggregateActiveEffects`/`registerActiveSpeechEffects`)、`src/simulation/engine.ts`
- `src/simulation/speechEffects.test.ts`(`aggregateActiveEffects`/`registerActiveSpeechEffects`のdescribeブロック)、
  `src/simulation/speechEffectsWiring.test.ts`
