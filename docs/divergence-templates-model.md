# Phase 4: シナリオ別・性格別の本心/建前表現テンプレート (Issue #118)

Parent Roadmap: #61 / Depends on: #114, #115

乖離モデル(#114/#115、[`social-expression-phase4-boundary.md`](social-expression-phase4-boundary.md)参照)
により「本心(心の声)と建前(発言)が同じtickで異なる内容になる」場面が生まれる。本文書は、その乖離場面で
本心と建前の違いが文言から読み取れるテンプレート層(`divergenceTemplates.ts`)と、その決定的な選択の
仕組みを定義する。心の声(Phase 1、`expression.ts`)・発言(Phase 2、`speech.ts`)いずれも本文書のテンプレート
層と同じ「表示専用・シミュレーション結果に非干渉」という原則を共有する。

## 乖離場面の分類(`classifyDivergenceScene`、socialExpression.ts)

発話時点の乖離スナップショット(`SpeechExpressionLink`、#115)と実際に発せられたintentから、
3つの乖離場面を決定的に判定する。各場面は#114の3つの乖離要因に1:1で対応する:

| 場面(`DivergenceScene`) | 要因(`DivergenceFactor`) | 判定条件 | 意味 |
| --- | --- | --- | --- |
| `reservedSoftening` | reserve(遠慮) | `baseIntent === "invite"` かつ `intent === "greet"` | 積極的な誘いを控えめな声がけへ軟化 |
| `obligatoryWelcome` | conformity(同調) | `intent === "welcome"` かつ `privateStance === "negative"` | 本心は乗り気でないまま歓迎する「建前の歓迎」 |
| `politeDecline` | impression(社交辞令) | `intent === "decline"` かつ `privateStance === "positive"` | 本心は参加希望のまま辞退する「社交辞令の辞退」 |

- `link.divergent === false`、または上記3場面に該当しない乖離発言はundefinedを返し、呼び出し側は
  従来の非乖離テンプレートへフォールバックする。
- **乖離判定ロジック自体は変更しない**(#114/#115の結果=`SpeechExpressionLink`を読むだけ)。

## 性格アーキタイプ(`classifyTemplateArchetype`、divergenceTemplates.ts)

`Agent`から表示テンプレート用の4アーキタイプを決定的に分類する:

| アーキタイプ | 判定 |
| --- | --- |
| `observerJoiner` | `agent.isObserverJoiner` |
| `designatedLeader` | 非observerJoinerかつ `initiative >= 0.5`(生成時0.7〜0.95、一般は0.1〜0.45で常に区別可能) |
| `cliqueMember` | 非observerJoiner・非リーダーで `cliqueId` を持つ |
| `general` | それ以外 |

## 本心/建前テンプレート(`DIVERGENCE_TEMPLATES`)

- 1バリエーションは `DivergencePair = { thought(本心), speech(建前) }` の**対**。同一の選択インデックスで
  対を取り出すため、thoughtとspeechの文言差から乖離要因が読み取れることを保証する。
- 場面ごとに `byArchetype`(語調・内容がアーキタイプで変わる)と `byPreset`(場面がシナリオで色付く)を持つ。
  `byArchetype.general` は必ず1件以上(フォールバック元)。

## 決定的な選択(`resolveDivergentExpression`)

```
候補プール = [...(byArchetype[archetype] ?? byArchetype.general), ...(byPreset[presetId] ?? [])]
キー       = `${seed}:${tick}:${agentId}:${scene}:${archetype}:${presetId}`
index      = hashString(キー) % プール長
→ プール[index] の { thought, speech } を返す
```

- **本体`SeededRandom`を一切消費しない**(Phase 1の表現専用rngパターンを踏襲した`hashString`のみ)。
- 同一seed・同一設定なら常に同じ文言(再現性)。プリセット/アーキタイプが変われば選択集合・
  インデックスの双方が変わりうる(シナリオ別・性格別の変化)。
- thoughtとspeechは同一`variantIndex`から取り出すため、必ず対応する対になる。

## 既存エントリポイントへの統合(speechTemplates.ts)

`resolveSpeechEventText(event, context?)` に任意の表示コンテキスト
(`{ agent, presetId, seed }`)を追加した。コンテキストが渡され、かつその発言が乖離場面であれば
建前側の乖離専用文言を返す。コンテキストなし(既存の全呼び出し元・コンポーネント)では従来どおり
reasonごとの1文言を返す(**後方互換**)。本心側(thought)の文言は、UI(#119)が同一tick・同一
エージェントの表現吹き出しに `resolveDivergentExpression(...).thought` を用いて表示することを想定する。

## 非干渉(受入条件)

- このテンプレート層はengine/stepSimulationのどこからも呼ばれない(表示側からのみ参照)。
  文言の追加・変更はシミュレーション結果(状態系列・最終結果・PRNG消費)に一切影響しない
  (受入テスト: 毎tickテンプレート解決を挟んでも状態系列・PRNG消費が完全一致)。
- 解決関数は純関数で、`Agent`・`SimulationState`・rngのいずれも変更しない。

## このissueで対応しない範囲

- 乖離判定ロジック自体の変更
- UI(吹き出しレイアウト)の変更: #119
- 新intent・新しい判断局面の追加
