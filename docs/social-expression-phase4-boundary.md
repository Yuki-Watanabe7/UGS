# Phase 4: 本心・対外表現・行動の三層モデルと処理境界 (Issue #113 / #114 / #115)

Parent Roadmap: #61

Phase 4(本心・建前・行動の不一致を含む社会的表現モデル)の土台となる三層の分離と、
その導出の処理境界を定義する。本文書はIssue #113(三層の器)・#114(乖離判定)・
#115(乖離を反映した発言生成)時点の状態を記述し、後続issue(#116〜#121)が拡張するたびに更新される。

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

## SpeechEvent生成への統合(Issue #115)

Phase 4有効時、発言選択の入力が本心(状態遷移そのもの)から対外表現(乖離適用後)へ切り替わる。
`stepSimulation`内のtick処理順序は次のとおり固定:

1. **基礎生成**: 従来どおり`createSpeechEvent`直接呼び出し(rng選択speaker: 核形成・介入声かけ)+
   `deriveSpeechEvents`(状態diff由来)。両経路の排他ルール(同一イベントの二重生成禁止)は不変。
2. **乖離調整**: `applyPublicExpressionsToSpeech`(socialExpression.ts)が、このtickの判断に使ったのと
   同じ入力(遷移後のagents・実効化済みactiveEffects)から導出した`PublicExpression`に基づき、
   話者の`expressedStance`でintentを置換/抑制し、`SpeechEvent.expression`
   (`SpeechExpressionLink`: 発話時点の乖離スナップショット参照)を付与する。
3. **Phase 3認知パイプライン**: 調整**後**のSpeechEvent列が認知→解釈→効果の入力になる
   (`speechLog`にも調整後の列のみ記録される)。

### intent置換表(既存4 intentの範囲内、新intentなし)

| 基礎intent | expressedStance: positive | none | negative |
| --- | --- | --- | --- |
| invite | invite | greet(軟化) | 抑制(発言なし) |
| welcome | welcome | welcome(建前の歓迎) | 抑制 |
| greet | greet | greet | greet |
| decline | decline | decline | decline |

「本心とずれた発言」の代表例(社交辞令の辞退=本心positiveのままのdecline、建前の歓迎=
本心negativeのままのwelcome)はintent維持側に現れ、ずれは`SpeechExpressionLink.divergent`/
`privateStance`/`expressedStance`/`baseIntent`から追跡する(#116の真実性評価の入力)。

`reason === "lightObserverInvitation"`(介入由来の声かけ)は調整対象外
(`docs/speech-event-intervention-boundary.md`参照)。

### rng消費の管理方針(Issue #115の受入条件)

- 乖離判定・発言調整はいずれもrngを受け取らない/消費しない。**config ON/OFFでPRNG消費列自体は
  変わらない**(発言調整はrng消費を伴う全処理の後に行われ、追加消費ゼロ)。
- config OFF時(デフォルト): 全関数が入力をそのまま返し/空配列を返すため、`speechLog`・状態系列・
  PRNG消費が従来と完全一致する。
- config ON時: SpeechEvent列(intent・件数)が変わることは許容される。speechEffects(Phase 3)も
  有効な場合、変わったintentが効果次元マッピングを通じて確率しきい値を変えるため状態系列は
  変わりうるが、これは「同じrng draw列を異なるしきい値と比較する」差であり、draw列そのものは
  同一のまま(Phase 3導入時と同じ性質)。speechEffects無効なら状態系列・PRNG消費はOFF時と完全一致する
  (全presetで受入テストあり)。

## 処理境界

- 導出関数はすべて純関数。`SimulationState`を読み取るのみで一切mutationしない。
- 本体の`SeededRandom`を受け取らない/消費しない。導出・発言調整の有無でPRNG消費列は変わらない
  (状態系列への間接的な影響は上記「rng消費の管理方針」参照)。
- Issue #115により、`engine.ts`は発言生成の後段調整(`derivePrivateEvaluations`/
  `derivePublicExpressions`/`applyPublicExpressionsToSpeech`)のためだけに`socialExpression.ts`を
  importする(相互依存になるが、双方ともモジュール初期化時に相手側の値を評価しないため安全)。
  engineの状態遷移・行動判断式(attractiveness/接近確率/stress/leave判定)への直接接続は
  引き続き存在しない(Phase 3の`SpeechActiveEffect`経由の間接的な影響のみ)。
- 導出結果は`SimulationState`に保持されない。呼び出し側が必要なtickで都度導出する
  (`SpeechEvent.expression`は発話時点のスナップショット複製であり、導出結果の保持ではない)。
- `SocialExpressionConfig`(`enabled: false`デフォルト)は`SpeechEffectsConfig`と同じ
  後方互換パターン。無効時は導出関数が空配列を返し、発言調整は入力をそのまま返す。
  設定は`SimulationState.socialExpressionEnabled`へ引き継がれる(`speechEffectsEnabled`と同じ
  fall back規則)。

## Phase 3因果チェーンとの接続点

Phase 3の因果チェーンは
`SpeechEvent` → `SpeechReceptionEvent` → `SpeechInterpretationEvent` → `SpeechEffectEvent` → `SpeechActiveEffect`
であり、接続点は次の3つ:

1. **入力として**: `PrivateEvaluation`は`state.activeSpeechEffects`(チェーンの終端)を
   attractiveness・実効leaveThresholdの計算に含める(engineと同じ計算を写しとるため)。
2. **概念の対応として**: `SpeechEvent`(チェーンの起点)は対外表現層の観測にあたる。
3. **上流への接続として(Issue #115)**: `PublicExpression`が`SpeechEvent`生成の入力になり、
   乖離調整後のintentがチェーン全体(認知→解釈→効果)の入力を決める。intent→効果次元の
   マッピング(`speechEffects.ts`)自体は変更しない。

## このissueで対応しない範囲(後続issueとの境界)

- 発言の真実性評価・信頼更新: #116(実装済み。`speechTrust.ts`が、#115の乖離スナップショットからの
  真実性導出と、受け手→話者pair単位の動的trust更新を担う。`docs/speech-trust-model.md`参照)
- 整合性履歴に基づく関係性変化: #117
- テンプレート: #118、UI・Inspector表示: #119、受入テスト・Monte Carlo比較: #120、README: #121
