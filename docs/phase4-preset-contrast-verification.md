# Phase 4: 5プリセットのコントラスト維持検証 (Issue #120)

Parent Roadmap: #61 / Depends on: #114, #115, #116, #117

`App.tsx`はPhase 4三層モデル(`socialExpression`)・trust更新(`speechTrust`)・関係性補正
(`relationshipTie`)をPhase 3(`speechEffects`、[`speech-effects-phase3-boundary.md`](speech-effects-phase3-boundary.md)参照)
とともに**デフォルトで全て有効化**した状態で実行される(`App.tsx`の`createInitialState`/
`resetSimulation`呼び出し、いずれも4設定とも`{ enabled: true }`)。本ドキュメントは、この実運用条件下で
[`CLAUDE.md`](../CLAUDE.md)が要求する「5プリセットのコントラスト(特にプリセット5の孤立シナリオ、
[`core-agent-dynamics.md`](core-agent-dynamics.md)参照)」が維持されていることを、
`phase4MonteCarlo.ts`(`runPhase4MonteCarlo`、Issue #120で追加。手法は
[`speech-effects-paired-monte-carlo.md`](speech-effects-paired-monte-carlo.md)のpaired比較パターンを
踏襲)を使って複数seed実走で確認した結果を記録する。

## 実行条件

- 各プリセットについて `runPhase4MonteCarlo({ baseSeed: 1, runs: 30, params: preset.params }, true)`
  (`enabled: true` = Phase 3/4全機能ON、`App.tsx`のデフォルトと同じ条件)を実行。
- seed列は `baseSeed=1` から30件(`1`〜`30`)。

## 結果(Phase 4全機能ON)

| preset | observerJoinerJoinRate | observerJoinerLeaveRate | groupFailureRate | averageFirstGroupConfirmedTick | averageJoinedCount | averageDivergenceCount | averageTrustChangeAmount | averageTieChangeAmount |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| natural | 1.000 | 0.000 | 0.000 | 15.10 | 14.00 | 27.10 | 0.497 | 0.361 |
| ambiguous-dissolve | 0.000 | 1.000 | 1.000 | — | 0.00 | 9.90 | 0.432 | 0.192 |
| strong-leader | 0.867 | 0.133 | 0.000 | 29.97 | 13.87 | 28.07 | 0.432 | 0.277 |
| late-join-culture | 0.867 | 0.133 | 0.000 | 31.27 | 13.87 | 28.07 | 0.425 | 0.240 |
| leftover-free-grouping (preset 5) | 0.567 | 0.433 | 0.000 | 10.67 | 10.83 | 13.57 | 0.436 | 0.255 |

## 確認できたこと

1. **プリセット間の意図した対比は、Phase 4全機能ONでも維持される**:
   - `natural`: observerJoinerJoinRate 1.0・groupFailureRate 0(「自然に成立する場」の設計どおり)。
   - `ambiguous-dissolve`: observerJoinerJoinRate 0・groupFailureRate 1(「曖昧なまま解散」の設計どおり、
     `numLeaders: 0`かつ低willingnessで誰も核を作れない)。
   - `strong-leader`/`late-join-culture`: 高いjoinRate(0.867)を維持しつつ、`averageFirstGroupConfirmedTick`
     の差(29.97 vs 31.27)でプリセットの意図した違い(後乗りしやすさの差)を反映。
   - `leftover-free-grouping`(プリセット5): joinRateが0でも1でもない0.567という**中間値**であることが
     「孤立の余地は残るが、全員が必ず孤立するわけでもない」という設計意図(`docs/relationship-tie-model.md`
     の「観測条件が確率的に依存する」という記述)と一致する。
2. **プリセット5のobserverJoiner孤立シナリオが維持される**ことを、`phase4Acceptance.test.ts`の
   `describe("Phase4受入回帰テスト: プリセット5のobserverJoiner孤立が維持される...")`でも別途
   (baseSeed 1〜8の8seedで)「全seedで全observerJoinerが必ずjoinedになることはない」という形で
   機械的に確認済み(このMonte Carlo集計と整合)。
3. **strong-leader/late-join-cultureの`averageJoinedCount`/`averageDivergenceCount`が偶然ほぼ一致する
   点は、Phase 4導入前から存在する既存の性質**であることを、`runMonteCarlo`(Phase 3/4なし)で同一seed列
   ・同一runsを実行して確認した(`observerJoinerJoinRate: 0.867`・`averageJoinedCount: 13.867`は両条件で
   完全一致、`averageFirstGroupConfirmedTick`のみ30.53 vs 31.30とプリセット差を反映)。Phase 4の導入で
   新たに生まれた縮退ではなく、`lateJoinEase`の差(0.55 vs 0.85)が`averageFirstGroupConfirmedTick`
   以外の指標にはこの母数(30 run)では現れにくいという既存の挙動であり、本issueの対応範囲外
   (プリセットのチューニングは対象外)。

## 実行方法についての制約

環境上の理由(ネットワーク制約のためPlaywright/Chromiumのインストールが行えなかった)により、
CLAUDE.mdが推奨する「devサーバー+Playwright(またはヘッドレススクリプト)」のうち、実際のブラウザ
操作は行っていない。代わりに、`engine.ts`/`phase4MonteCarlo.ts`を直接呼び出すNode実行(`vitest`経由)
で、`App.tsx`が実運用で使うのと同一の設定(4機能フラグ全て`enabled: true`)・同一のプリセット
パラメータを使って複数seedを実走した(`relationshipTie.test.ts`のプリセット5検証・
`docs/relationship-tie-model.md`が採用しているのと同じ「Node実行による複数seed実走確認」の前例を踏襲)。
UIレイヤー(Inspector/Canvas表示)そのものの見た目の回帰確認は対応しない範囲(#119が担保)。
