# Phase 4: 本心・対外表現・行動の三層モデルと処理境界 (Issue #113 / #114)

Parent Roadmap: #61

Phase 4(本心・建前・行動の不一致を含む社会的表現モデル)の土台となる三層の分離と、
その導出の処理境界を定義する。本文書はIssue #113(三層の器)とIssue #114(乖離判定)
時点の状態を記述し、後続issue(#115〜#121)が拡張するたびに更新される。

## 三層の定義と既存概念との対応

| 層 | 型 | 定義 | 対応する既存概念 |
| --- | --- | --- | --- |
| 本心 (privateEvaluation) | `PrivateEvaluation` (`socialExpression.ts`) | エージェント内部の評価。既存の判断式の中間値から純関数で導出される観察用スナップショット。他エージェントには認知されない | Phase 1の`ExpressionEvent`(`expression.ts`)は本心側を観察者向けに言語化した演出データ |
| 対外表現 (publicExpression) | `PublicExpression` (`socialExpression.ts`) | 対外的に表現される立場。#114により遠慮・同調圧力・印象管理の3要因で本心から決定的に乖離しうる(下記「PublicExpressionの導出」参照) | Phase 2の`SpeechEvent`(`speech.ts`)は対外表現側が実際の発言として観測されたもの |
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

## PublicExpressionの導出(乖離判定、Issue #114)

`derivePublicExpressions(privateEvaluations, state, params, config)`が
「本心→対外表現」変換の唯一の境界。`privateEvaluationId`により導出元の本心を常に追跡できる。

乖離は恣意的な演出ではなく、既存personality・関係性・場の状態から**決定的に導出される仮説ルール**
であり、rngは一切使わない(Phase 1の表現専用rngパターンすら不要だった)。同一seed・同一設定・
同一tickに対して常に同じ乖離判定結果になる。personality基礎値は一切変更しない。

### 乖離要因(3要因固定、`PublicExpressionFactorKey`)

| key | 作用次元 | 方向 | ルール |
| --- | --- | --- | --- |
| `reserve`(遠慮・拒否回避) | joinDesire | 抑制のみ | `-clamp(influenceAvoidance) * max(0, joinDesire - 0.5)`。中立値(0.5)を超える積極さだけを打ち消す(積極→消極への反転はしない。最大で無表明まで) |
| `conformityPressure`(同調圧力) | joinDesire | 多数派の符号 | `clamp(conformity) * 0.3 * 多数派シグナル`。シグナルは可聴範囲内(自分とleftを除く)のforming/approaching/joined対undecided/leavingの人数差比率(-1〜1) |
| `impressionManagement`(印象管理・社交辞令) | leaveInclination | 緩和のみ | `-関係の近さ * 0.6 * clamp(leaveInclination, 0, 1)`。関係の近さ=可聴範囲内に同一clique者がいれば実効`existingTieStrength`、いなければ0。緩和量が本心の離脱傾向に比例するため表明は0未満へ反転しない |

- 可聴範囲(`EXPRESSION_AUDIBLE_RANGE`)はPhase 2の発言基礎到達距離`DEFAULT_SPEECH_RANGE`(200)を
  そのまま流用する(「声が届く範囲の相手」への表現、という対応を認知モデルと一貫させる)。
- `existingTieStrength`は`derivePrivateEvaluations`と同じ経路(`state.interventionId`→
  `resolveEffectiveParams`)で実効値へ解決する。

### clamp規則(乖離量の上限)

1. 次元ごとの要因contribution合計(`rawDelta`)を±`MAX_DIVERGENCE_PER_DIMENSION`(0.5)へclampする。
2. 最終値をjoinDesire次元は0〜1、leaveInclination次元は0以上へclampする。
3. `delta`は全clamp適用後の実際の乖離量(`expressedValue - privateValue`)として保持され、
   `rawDelta`との差からclampの発動が読み取れる。

### 構造化された乖離データ

Phase 3の解釈モデル(`SpeechInterpretationFactor`)のcontributionパターンを踏襲し、
`PublicExpression.divergences`(固定順: joinDesire→leaveInclination)が次元ごとに
`privateValue`/`expressedValue`/`rawDelta`/`delta`/`factors`(要因ごとの
`rawValue`/`normalizedValue`/`contribution`、条件不成立でもcontribution 0で必ず含まれる)を保持する。
`divergent`はいずれかの次元で|delta|が`DIVERGENCE_EPSILON`を超えるか。

### 表明スタンス(observerJoinerの乖離の判定)

`joinDesire`(本心側)/`expressedJoinDesire`(対外表現側)をしきい値
(0.65以上=positive、0.35以下=negative、間=none)で3値化した`privateStance`/`expressedStance`を持つ。
observerJoiner(willingness 0.8・influenceAvoidance高)の典型的な乖離は
**本心=positive(参加希望)・対外表現=none(無表明)**として判定される(受入テストあり)。

## 処理境界

- 導出関数はすべて純関数。`SimulationState`を読み取るのみで一切mutationしない。
- 本体の`SeededRandom`を受け取らない/消費しない。導出の有無でPRNG列・状態系列・最終結果は変わらない。
- `engine.ts`は`socialExpression.ts`をimportしない(観察専用の一方向依存。`expression.ts`と同じ位置づけ)。
  依存方向: `socialExpression.ts` → `engine.ts`/`speechEffects.ts`/`interventions.ts`/`speech.ts`/`model.ts`。
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

- 乖離を反映した`SpeechEvent`生成、engineとのrng消費順序の調整: #115
- 発言の真実性評価・信頼更新: #116
- 整合性履歴に基づく関係性変化: #117
- テンプレート: #118、UI・Inspector表示: #119、受入テスト・Monte Carlo比較: #120、README: #121
