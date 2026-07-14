# Phase 4: 発言の真実性評価と受け手ごとの信頼更新モデル (Issue #116)

Parent Roadmap: #61 / Depends on: #113, #115

`speechTrust.ts`が扱う2つの独立した仕組み — 話者側の**真実性記録**と、受け手側の**動的trust更新** —
のモデルと処理境界を定義する。`docs/social-expression-phase4-boundary.md`(三層モデルの土台)の
続きにあたる。

## 1. 話者側: 真実性(`SpeechTruthfulnessRecord`)

発話時点の本心(`PrivateEvaluation`)と対外表現(`PublicExpression`)の一致度を、Issue #115の
乖離スナップショット(`SpeechEvent.expression`、`SpeechExpressionLink`)**だけ**から決定的に導出した
記録。`SimulationState.speechTruthfulnessLog`へ時系列蓄積される。

### 導出規則(`truthfulnessOf`、固定)

- 乖離なし(`divergent: false`)→ 常に **1**(完全一致)。
- 乖離あり → `スタンス一致度 × intent一致度` を上限 **0.75** で採用する。
  - スタンス一致度: `privateStance === expressedStance`=1、片方が"none"=0.5、positive対negative=0
  - intent一致度: `intent === baseIntent`(基礎intentのまま)=1、乖離により置換された=0.5
  - 上限0.75は、スタンス・intentに現れない次元(leaveInclination のみの乖離、例: 印象管理による
    離脱傾向の緩和)を「完全に真実」と区別するため。

| 代表例 | privateStance | expressedStance | intent | truthfulness |
| --- | --- | --- | --- | --- |
| 乖離なしの発言 | — | — | 不変 | 1 |
| 印象管理のみの乖離 | positive | positive | 不変 | 0.75 |
| 社交辞令の辞退(observerJoinerの典型) | positive | none | decline のまま | 0.5 |
| 遠慮による軟化 | positive | none | invite→greet | 0.25 |

### 境界

- 乖離スナップショットを持たない発言(socialExpression無効時の全発言・介入由来の
  `lightObserverInvitation`)は評価対象外(乖離情報が存在しないため)。
- **受け手には一切見えない**: 本心は他エージェントに認知されないため、真実性は下記trust更新の
  入力にならない純粋な観察・追跡用データ(受け手が観測できるのはintentと行動の一致/不一致のみ)。

## 2. 受け手側: 動的trust(`SpeechTrustState` / `SpeechTrustUpdateEvent`)

pair単位(**受け手→話者の方向つき**)の信頼値。`deriveSpeechInterpretations`(`speechEffects.ts`)の
trust係数として参照される。

### 初期値と保持

- 初期値は既存の静的`relationshipTrust`(同一clique/`existingTieStrength`から導出)の値。
- 更新が一度でも発生したpairのみ`SimulationState.speechTrust`(キー: `observerId->speakerId`)に
  保持され、未登場のpairは常に静的初期値として解決される(`createSpeechTrustResolver`)。
  よって更新が起きていないpairの解釈結果はconfig OFF時と完全に一致する。
- `existingTieStrength`・personality基礎値は一切変更しない(trustは別スロットにのみ保持)。

### 観測条件(固定)

受け手のtrustが更新されるのは、次の**すべて**を満たす観測が発生した場合のみ:

1. 受け手がその発言を発話時点で認知していた(Phase 3の`SpeechReceptionEvent.heard === true`。
   聞いていない発言との一致/不一致は観測できない)。
2. 話者が発言intentと一致/不一致な行動(状態遷移)をとった(下記判定表)。
3. その遷移が起きたtickに、受け手が話者から知覚範囲内にいる。距離モデルはPhase 3の可聴/認知判定と
   同じ「距離としきい値の比較」で、しきい値は`SPEECH_TRUST_OBSERVATION_RANGE`
   (= `DEFAULT_SPEECH_RANGE` = 200。「声が届く範囲=様子が見える範囲」という対応を
   `EXPRESSION_AUDIBLE_RANGE`と一貫させる)。

観測の進行状態は`SimulationState.speechTrustCommitments`(発言1件につき1件の未観測コミットメント、
hearer=発話時点の認知者スナップショット)が持ち、話者の決定的な遷移で解決・除去される
(**1発言につき観測は1回限り**。その瞬間に範囲外だった受け手は機会を失うだけで、遡って更新されない)。
認知者が1人もいない発言はコミットメント自体を作らない。

### intentと行動の一致/不一致判定表(`classifyTrustObservation`、固定)

| intent | 一致(consistent) | 不一致(inconsistent) | それ以外の遷移 |
| --- | --- | --- | --- |
| invite / welcome / greet(参加方向) | "joined"への遷移 | "leaving"への遷移(例: 誘っておいて自分は帰り始めたfounder) | 保留 |
| decline(離脱表明) | "left"への遷移 | "approaching" / "joined"への遷移 | 保留 |

declineの不一致(Issue #116の例「decline発言後に輪へjoinした」)は、現行engineにleavingからの
復帰経路がないため実際には発生しないが、判定表としては将来の遷移追加に備えて固定してある。

### 更新式(決定的、rng不使用)

```
newTrust = clamp(previousTrust + delta, 0, 1)
delta = 一致: +0.05 (TRUST_CONSISTENT_DELTA) / 不一致: -0.2 (TRUST_INCONSISTENT_DELTA)
```

信頼は壊れるときの方が大きく動く非対称。更新1件ごとに`SpeechTrustUpdateEvent`
(`SimulationState.speechTrustUpdateLog`)が記録され、**いつ**(tick)・**何を観測して**
(speechEventId・観測した状態遷移・一致/不一致・観測距離)・**どれだけ変化したか**
(previousTrust/newTrust/delta)を常に追跡できる。

## tick内の処理順序(`stepSimulation`、固定)

1. 状態遷移(step 1-9、従来どおり)
2. 発言の基礎生成 → 乖離調整(Issue #115、従来どおり)
3. **trust観測**: 前tickまでの未観測コミットメントを、このtickの状態遷移と突き合わせて更新
4. **真実性記録**: このtickの発言(乖離調整後)から導出
5. Phase 3認知 → 解釈(**更新後trust**をtrust係数として参照)→ 効果
6. **コミットメント登録**: このtickの発言+認知結果から追記

発言とその発言自体を生んだ遷移(例: leaving遷移とdecline発言)が同一tickで自己解決しないのは、
登録(6)が観測(3)より後だから。

## 処理境界

- `speechTrust.ts`の導出関数はすべて純粋関数。`SimulationState`をmutationせず、rngを受け取らない/
  消費しない(有効/無効・更新の有無でPRNG消費列は変わらない。同一seed・同一設定でtrustの時系列が
  完全に再現される)。
- `SpeechTrustConfig`(`enabled: false`デフォルト)は既存configと同じ後方互換パターン。
  設定は`SimulationState.speechTrustEnabled`へ引き継がれる(同じfall back規則)。
- **config OFF時**: 全導出が空/入力そのままを返し、`deriveSpeechInterpretations`はresolver未指定で
  従来の静的式を使う → 解釈結果・状態系列・PRNG消費はIssue #116以前と完全一致する(受入テストあり)。
- **config ON時**: 動的trustが解釈の`relationshipTrust`要因のcontributionを変え、Phase 3の効果
  チェーンを通じて確率しきい値へ間接的に影響しうる(rng draw列自体は変えない、Phase 3/#115と同じ性質)。
- trust更新の観測はPhase 3の認知記録(reception)を前提とするため、`SpeechEffectsConfig.enabled`が
  falseの間はhearerが存在せず、trust ONでも観測・更新は一切発生しない(状態系列も不変)。
- `speechEffects.ts`は`SpeechTrustResolver`(関数型)を受け取るだけで、trust状態の持ち方・更新規則を
  知らない。依存方向は`speechTrust.ts`→`speechEffects.ts`の一方向(循環なし)。

## このissueで対応しない範囲(後続issueとの境界)

- 整合性履歴の蓄積に基づく関係性(tie)変化: #117(本issueは解釈モデルのtrust係数のみ)
- trustのUI表示: #119
- 発言効果の次元マッピング(intent→dimension)の変更: 対象外(不変)
