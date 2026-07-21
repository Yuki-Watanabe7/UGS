# 成立済みグループの描画専用レイアウト

Issue #149で、学校のペア・班形成Canvasに「成立済み領域」を導入した。目的は、成立した複数のグループを比較しやすい固定slotへ移しながら、シミュレーションの座標・状態遷移・乱数列を一切変えないことである。

## 責務境界

- `src/components/groupVisualLayout.ts`は`agents`、`groupCandidates`、Canvas寸法、表示幅、slot割当を受け取り、`CandidateVisualLayout`と`AgentVisualPosition`を純粋計算で返す。
- `src/components/SimulationCanvas.tsx`だけが計算結果をSVG属性へ適用する。成立済みグループ専用SVGと形成中シミュレーションSVGは別々の表示ボックスとして描画し、同じ描画面を共有しない。
- `engine.ts`、`FormationPolicy`、距離判定、発言認知、社会的表現、Monte Carloは描画レイアウトをimportしない。
- `candidate.x/y`、`agent.x/y`、`memberIds`を含む入力オブジェクトは変更しない。表示計算は`SeededRandom`も受け取らない。
- after-partyでは成立済み領域を作らず、従来の中心座標と半径54をそのまま返す。

## 退避対象

学校シナリオで次の両方を満たす候補だけを退避する。

1. `status === "confirmed"`
2. `memberIds.length >= maxGroupSize`

古い学校stateで`maxGroupSize`がない場合は、現在の学校FormationPolicyの既定値である2人を使う。`forming`、`dissolving`、`dissolved`、`expired`は実座標での既存表示を維持し、slotを消費しない。

## slotの安定性とリセット

Canvasが満員confirmed候補を初めて観測した順に、0始まりの連番slotを割り当てる。既存candidateのslotは、candidate配列の順番が変わっても維持する。同じrun中に候補が消えてもslotは再利用せず、新しい候補には次の番号を割り当てる。これにより、再登場や一時的な表示差分による番号の入れ替わりを避ける。

`SimulationCanvas.runId`または`formationScenarioId`が変わると割当を空にする。Appの`runId`はReset、seed変更、preset変更、介入変更で増えるため、新しい実行へ古いslotを持ち越さない。割当はcandidate IDと観測順だけで決まり、本体PRNGを消費しない。

## 配置と狭幅fallback

- PC表示は固定10列で、10組までを同じ行へ置く。成立件数が増えても既存slotの座標は変わらない。
- 形成中シミュレーションのSVGを主表示として上に置き、成立済みグループのSVGはその下に独立して配置する。形成中のcandidate・agent・接近線を成立済みSVGへ描かず、成立済みcandidate・agent・吹き出しを形成中SVGへ描かない。
- CSS上のSVG表示幅が480px未満なら固定4列へ切り替え、複数行へ折り返す。ResizeObserverが利用できない環境ではCanvasのviewBox幅を使う。
- 3人班、4人班では人数に応じてリング半径を広げる。ただし隣のslotとの安全間隔とCanvas境界を優先して上限を設ける。
- 成立済み領域は必要な行数だけ縦へ伸びるが、形成中領域を最低130座標単位残す。
- 表示可能容量を超えたグループと所属メンバーはCanvas上で重ねず省略し、省略件数を明示する。全候補はCanvas下の進行状況一覧へ残り、slot番号またはcandidate IDで確認できる。

## メンバーと吹き出し

所属メンバーには原則としてcandidateと同じvisual offsetを適用し、相対位置を維持する。元の相対距離が縮小後のリングからはみ出す場合だけ、candidate中心からの方向を維持したままリング内へ収める。発言、本心、通常の心の声はこの`AgentVisualPosition`から配置するため、退避後の生徒へ追従する。

接近線は成立済みの満員グループへは描かない。形成中候補への線は、エージェントと候補のシミュレーション座標をそのまま使う。

## テスト境界

`groupVisualLayout.test.ts`で、0件・1件・10組、3〜4人班、通常幅・狭幅、衝突と境界、slotの安定性・リセット規則、容量超過、再現性、非mutation、after-party非介入を検証する。`SimulationCanvas.test.ts`では、成立済み／形成中が別SVGで相互に混在しないこと、candidateとメンバーの対応、吹き出し、slot番号、形成中候補と接近線の実座標、入力非mutationをSVG出力で検証する。
