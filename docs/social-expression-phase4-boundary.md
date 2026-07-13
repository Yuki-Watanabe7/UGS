# Phase 4: 本心・対外表現・行動の三層モデルと処理境界 (Issue #113)

Parent Roadmap: #61

Phase 4(本心・建前・行動の不一致を含む社会的表現モデル)の土台となる三層の分離と、
その導出の処理境界を定義する。本文書はIssue #113時点の状態を記述し、後続issue
(#114〜#121)が拡張するたびに更新される。

## 三層の定義と既存概念との対応

| 層 | 型 | 定義 | 対応する既存概念 |
| --- | --- | --- | --- |
| 本心 (privateEvaluation) | `PrivateEvaluation` (`socialExpression.ts`) | エージェント内部の評価。既存の判断式の中間値から純関数で導出される観察用スナップショット。他エージェントには認知されない | Phase 1の`ExpressionEvent`(`expression.ts`)は本心側を観察者向けに言語化した演出データ |
| 対外表現 (publicExpression) | `PublicExpression` (`socialExpression.ts`) | 対外的に表現される立場。**#113では常に本心と同値(乖離なし)** | Phase 2の`SpeechEvent`(`speech.ts`)は対外表現側が実際の発言として観測されたもの |
| 行動 (actualAction) | 新しい型は導入しない | 実際にどう動いたか | 既存の`AgentState`遷移・移動そのもの(`types.ts`/`engine.ts`) |

## PrivateEvaluationの導出(既存判断式との対応)

`derivePrivateEvaluations(state, params, config)`は新しい心理モデルを一切導入せず、
`engine.ts`の判断式の入力・中間値をそのまま写しとる:

| フィールド | 由来する既存の判断式 |
| --- | --- |
| `joinDesire` | `Agent.willingness`(personalityの基礎値そのもの) |
| `leaveInclination` | engineのleave判定 `stress > leaveThreshold + sumActiveEffectValue(..., "leaveThreshold", ...)` と同じ入力の比率表現(1.0以上=しきい値到達)。分母には発散防止の下限(`MIN_EFFECTIVE_LEAVE_THRESHOLD`)のみ設ける |
| `candidateEvaluations[].attractiveness` | `engine.ts`の`attractiveness()`を、engineと同じ入力(実効params・介入ID・現在有効な`SpeechActiveEffect`)で呼んだ値そのもの |
| `candidateEvaluations[].isNearest` | `nearestCandidate()`(engineの接近判定が対象にする最寄り候補)と同一の判定 |

入力の解決経路もengineに合わせる:

- 介入: `state.interventionId`から解決(`stepSimulation`の未指定時fall backと同じ)
- 実効params: `resolveEffectiveParams`(介入の`paramAdjustments`適用後)
- 発言効果: `state.activeSpeechEffects`(Phase 3が無効なら常に空)を`state.tick`時点の強度で評価

注意: engineは次tick(`state.tick + 1`)の判断時に効果を減衰させてから参照するのに対し、
本導出は「現在のstateの観察」として`state.tick`時点の強度で評価する。これは観察スナップショット
としての定義であり、engineの判断そのものの予言ではない。

## PublicExpressionの導出

`derivePublicExpressions(privateEvaluations, config)`は**#113では恒等変換**であり、
`divergent`は常に`false`。`privateEvaluationId`により導出元の本心を常に追跡できる。
この関数が「本心→対外表現」変換の唯一の境界であり、Issue #114の乖離判定
(遠慮・印象管理・同調圧力)はこの関数の内部に導入される。

## 処理境界

- 導出関数はすべて純関数。`SimulationState`を読み取るのみで一切mutationしない。
- 本体の`SeededRandom`を受け取らない/消費しない。導出の有無でPRNG列・状態系列・最終結果は変わらない。
- `engine.ts`は`socialExpression.ts`をimportしない(観察専用の一方向依存。`expression.ts`と同じ位置づけ)。
  依存方向: `socialExpression.ts` → `engine.ts`/`speechEffects.ts`/`interventions.ts`。
- 導出結果は`SimulationState`に保持されない。呼び出し側が必要なtickで都度導出する。
- `SocialExpressionConfig`(`enabled: false`デフォルト)は`SpeechEffectsConfig`と同じ
  後方互換パターン。無効時は導出関数が空配列を返す。

## Phase 3因果チェーンとの接続点

Phase 3の因果チェーンは
`SpeechEvent` → `SpeechReceptionEvent` → `SpeechInterpretationEvent` → `SpeechEffectEvent` → `SpeechActiveEffect`
であり、#113時点での接続点は次の2つのみ:

1. **入力として**: `PrivateEvaluation`は`state.activeSpeechEffects`(チェーンの終端)を
   attractiveness・実効leaveThresholdの計算に含める(engineと同じ計算を写しとるため)。
2. **概念の対応として**: `SpeechEvent`(チェーンの起点)は対外表現層の観測にあたる。

三層モデルがチェーンに何かを書き込むことはない。Issue #115(乖離を反映した発言生成)で初めて、
`PublicExpression`が`SpeechEvent`生成の入力になる形でチェーンの上流に接続される。

## このissueで対応しない範囲(後続issueとの境界)

- 乖離判定(遠慮・印象管理・同調圧力): #114
- 乖離を反映した`SpeechEvent`生成、engineとのrng消費順序の調整: #115
- 発言の真実性評価・信頼更新: #116
- 整合性履歴に基づく関係性変化: #117
- テンプレート: #118、UI・Inspector表示: #119、受入テスト・Monte Carlo比較: #120、README: #121
