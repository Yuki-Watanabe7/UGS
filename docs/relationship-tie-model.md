# Phase 4: 過去の発言と行動の整合性に基づく関係性変化 (Issue #117)

Parent Roadmap: #61 / Depends on: #116

`relationshipTie.ts`が扱う、発言intentと話者のその後の行動の整合性の**積み重ね**が
pair間の関係性(親密さ・距離感)そのものを変えるモデルの定義と処理境界。
[`speech-trust-model.md`](speech-trust-model.md)(#116、trust更新=単発観測に対する解釈係数の変化)の
続きにあたり、こちらは整合性を**履歴**として蓄積し、その履歴から関係性補正(tie補正)を導く。
反映先は[`core-agent-dynamics.md`](core-agent-dynamics.md)が定義する`attractiveness()`の同clique
bonus/outsider penalty、および[`speech-interpretation-model.md`](speech-interpretation-model.md)の
`relFactor`(関係性係数)の2箇所(下記「反映先」参照)。

## #116(trust更新)との違い

| | #116 trust更新 | #117 tie補正 |
| --- | --- | --- |
| 単位 | pair(受け手→話者)の動的trustスカラ | pair(受け手→話者)の整合性**履歴**(観測列) |
| 観測 | 単発。決定的遷移で即時にスカラをnudge | 履歴へ蓄積。件数上限で忘却 |
| 時間窓 | なし(決定的遷移まで無期限に保留) | `TIE_OBSERVATION_WINDOW`(N=12 tick)以内。窓超過で失効 |
| 反映先 | 解釈モデルの`relationshipTrust`係数(trust係数) | `attractiveness()`の同clique bonus/outsider penalty、および解釈モデルの`relFactor`(関係性係数) |
| 反映方式 | trust係数を置換 | **加算**(固定) |

観測条件(発話時点で認知=heard、話者の決定的遷移を知覚範囲内で観測)と、intent→行動の一致/不一致
判定表(`classifyTrustObservation`)は#116と共通(単一の情報源として再利用)。

## 整合性履歴(`RelationshipTieState`)

- pair単位(受け手→話者、キー`tiePairKey`)の観測列`TieConsistencyObservation[]`。
- 各観測は「どの発言(speechEventId)を認知し、その後の話者の遷移がintentと一致/不一致だったか」と、
  補正への符号付き寄与`weight`を保持する(**どの発言・行動の組が補正へ寄与したか**を追跡できる)。
- `TIE_HISTORY_LIMIT`(8件)を超えると最古から破棄する。**この件数上限が「忘却」を担い、時間減衰は導入しない。**

### 観測条件(固定、#116と同一 + 時間窓)

`SimulationState.tieCommitments`(未観測コミットメント、`expiresAtTick = speechTick + N`)が進行状態を持つ:

1. 受け手がその発言を発話時点で認知(`SpeechReceptionEvent.heard === true`)。
2. 話者が発言intentと一致/不一致な決定的遷移をとった(`classifyTrustObservation`が非undefined)。
3. その遷移tickに、受け手が話者から`TIE_OBSERVATION_RANGE`(=200、#116と同じ距離モデル)以内。
4. **発話から N tick以内**。窓内に決定的遷移がなければ失効(履歴に残さない)。

判定表(invite/welcome/greet→joined=一致・leaving=不一致、decline→left=一致・approaching/joined=不一致)は
`classifyTrustObservation`(`speechTrust.ts`)を共有。

## tie補正値(`correctionFromHistory`)

```
correction(pair) = clamp( Σ weight, -MAX_TIE_CORRECTION, MAX_TIE_CORRECTION )   // MAX = 0.2
weight = 一致: +0.04 (TIE_CONSISTENT_WEIGHT) / 不一致: -0.1 (TIE_INCONSISTENT_WEIGHT)
```

一致は小さく上げ、不一致は大きく下げる非対称(信頼は壊れやすい)。総和は加算のみで順序非依存。
補正値そのものはstateに保持せず、常に履歴から決定的に再計算する(単一の情報源)。

## 反映先(2箇所、加算方式固定)

### 1. `attractiveness()`(engine.ts)

観測者が輪の構成員に積み上げた補正を集約(`aggregateGroupTieCorrection` = 構成員pair補正の合算を
`[-MAX, MAX]`へclamp、自分自身は除外)し、次のように加算する:

```
cliqueTieBonus  = isDominantMember ? max(0, existingTieStrength*0.5 + tieCorrection) : 0
outsiderPenalty = isDominantMember ? 0 : max(0, existingTieStrength*dominanceBeyondHalf*0.75 - tieCorrection)
```

正の補正は(同一cliqueならbonus増、部外者ならpenalty減で)常に魅力度を上げ、負は下げる。
step 2(接近判定)で使うのは**前tickまでの履歴**由来の補正(このtickの新規観測は次tick以降に効く。
Phase 3のactiveEffectsと同じ「今回生成→次回参照」の時間関係)。

### 2. 解釈モデルの`relFactor`(speechEffects.ts)

受け手→話者pairの補正を`relFactor`(関係性係数、target=1.0/nearby=0.7)へ加算し`[0, 2]`へclamp
(負の補正で乗数が0未満へ転じてvalenceが反転しないため)。こちらは**このtickの観測適用後**の補正を使う
(#116のtrustがtickStepの更新後trustを使うのと同じ)。`createTieCorrectionResolver`経由で
`deriveSpeechInterpretations`に注入する。

## tick内の処理順序(`stepSimulation`)

1. step 1-9(状態遷移)。step 2のattractivenessは**前tick**の履歴由来tie補正を参照。
2. 発言の基礎生成→乖離調整(#115)。
3. **整合性観測**(`deriveTieObservations`): 前tickまでの未観測コミットメントをこのtickの遷移と
   突き合わせ、履歴を更新。窓超過分は失効。
4. Phase 3認知→解釈(`relFactor`に**更新後**tie補正を加算)→効果。
5. **コミットメント登録**(`registerTieCommitments`): このtickの発言+認知結果から追記。

登録(5)が観測(3)より後なので、発言とその発言自体を生んだ遷移が同一tickで自己解決しない。

## 決定性・境界・後方互換

- 全関数は純粋関数。`SimulationState`をmutationせず、rngを受け取らない/消費しない
  (有効/無効・補正の有無でPRNG消費列は変わらない。同一seed・同一設定で履歴・補正・状態系列が完全再現)。
- 安定順序: コミットメントは`(speechTick, speechEventId)`、hearerはソートして処理
  (Phase 3 #97の安定順序パターン。入力配列反転で結果不変)。補正は加算合成のため順序非依存。
- `RelationshipTieConfig`(`enabled: false`デフォルト)は既存configと同じ後方互換パターン。
  設定は`SimulationState.relationshipTieEnabled`へ引き継がれる。
- **config OFF**: 全導出が空/入力そのままを返し、`attractiveness`/`relFactor`は補正0で従来式と完全一致
  (状態系列・最終結果・PRNG消費が#117以前と一致。全presetで受入テストあり)。
- **config ON**: tie補正がattractiveness/relFactorのしきい値を変え、状態系列は変わりうる
  (rng draw列自体は不変。#116/#96/#115と同じ性質)。tie ONでもspeechEffects OFFなら認知が存在せず
  観測が発生しないため、状態系列はOFFと完全一致する。
- `existingTieStrength`基礎値・`cliqueId`・personality基礎値は一切変更しない(補正は`tieHistory`という
  別スロットにのみ保持され、判断式へ一時的な加算として反映される)。
- プリセット5(leftover-free-grouping)のobserverJoiner孤立は、補正が小さく上限付き(±0.2)であるため
  維持される(全機能ON・複数seedで「全observerJoinerが必ず合流する」ことはない、を受入テストで確認)。

## このissueで対応しない範囲

- cliqueの再編成(`cliqueId`の変更・移籍)
- 関係性変化のUI表示: #119
- 新しい行動ルールの追加(既存の判断式への補正のみ)
