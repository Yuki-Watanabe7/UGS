# 会話履歴・接触ネットワーク・統計可視化の分析契約 (Issue #211, Phase 4 設計)

Parent Roadmap: #172。Depends on: #197, #198, #199, #200, #201, #202, #203。
Blocks: #212(会話履歴モデル), #213(接触ネットワーク), #214(統計集計), #215〜#217(可視化),
#218(統合検証)。

この文書は、立食パーティー(`standingParty`)の Phase 1〜3 で蓄積された構造化イベントと
live な`ConversationEpisode`を、**シミュレーション本体の意思決定から分離した read-only 分析層**
へ正規化するための**ドメイン契約(ADR)**である。型・導出APIの本実装は Issue #212
(`src/simulation/standingPartyAnalysis.ts`の`buildStandingPartyConversationHistory`、
Gap Aの`clusterMembershipLost`イベント)および Issue #213
(`src/simulation/contactNetwork.ts`の`deriveContactIntervals` /
`buildStandingPartyContactNetwork`)および統計集計(#214、
`src/simulation/standingPartyStatistics.ts`の`buildStandingPartyRunStatistics`経由)で行い、
UI は #215 以降が担う。
本ADR(#211)自体は契約の固定が成果物であり、#211 マージ時点では既存コードの挙動・PRNG消費順序・
`SimulationState`のフィールドは変更していない。

> **命名の注意**: Roadmap #61 の「Phase 4」(社会的表現・発話信頼・関係性補正:
> `socialExpression` / `speechTrust` / `relationshipTie`)とは**別物**である。本ADRの Phase 4 は
> Roadmap #172 の「会話履歴・接触ネットワーク・統計可視化」を指す。文書名・モジュール名・
> schema version には必ず`standing-party` / `standingPartyAnalysis` を含め、#61 系の
> `phase4-*` 文書と衝突させない。

判断基準の軸は、これまでのADRが確立した拡張パターンをそのまま延長する:

1. **シナリオ固有ルールは`engine.ts`へ分岐を書かず、`FormationPolicy`実装へ委譲する**
   (Issue #130、[formation-policy-model.md](formation-policy-model.md))。
2. **新しい状態は現状態(`joinedGroupId`/`memberIds`)を汚さず、生成専用ログ・スナップショットとして
   別に持つ**(Issue #173、[interaction-cluster-model.md](interaction-cluster-model.md) 3.3節7)。
3. **表示文言の文字列解析を行わない**。集計は`eventType` + `metadata` + live state のみから導出する
   (`standingPartyComparison.ts` / Issue #190 と同じ規律)。
4. **分析データは意思決定入力にも PRNG 系列にも影響しない**
   (`speechLog` / Phase 3 speech effects の「生成専用」境界と同型)。

---

## 0. 拡張対象の現状(Phase 1〜3 で確定済みの土台)

### 0.1 既にあるもの

| 資産 | 役割 | 限界 |
| --- | --- | --- |
| `SimulationState.log: LogEntry[]` | tick ごとの監査・デバッグ用イベント列。`eventType` + `metadata` を持つ | 完了 episode / membership 区間 / contact の正規レコードではない |
| `Agent.currentEpisode?: ConversationEpisode` | 現在`joined`中の 1 エピソード器 | 終了時にクリアされ、履歴として残らない |
| `ConversationEpisodeEndReason` | `voluntaryDeparture` / `memberReleased` / `membershipLost` | `membershipLost` に専用`SimulationEventType`が無い |
| `PendingClusterTransition` + `clusterTransition*` イベント | 目的地付き移動の意図〜完了/失敗 | transition を横断する正規レコードが無い |
| `StandingPartyRunSummary`(#190) | log 由来の比較指標(自発離脱・再参加・dwell サンプル等) | contact network・lifetime 分布・時間窓・未完了 episode の censored 扱いが無い |
| `standingPartyComparison.ts` | log → summary の pure 導出 | Phase 4 全体の契約ではなく、比較用の薄い集計 |

### 0.2 Follow-up D との関係

[interaction-cluster-model.md](interaction-cluster-model.md) 3.3節7 / 4節 Follow-up D は、
`ClusterMembershipEvent`(`{ agentId, clusterId, tick, kind: "joined" | "departed" }`)という
追記専用ログの新設を提案していた。本ADRはそれを**supersede**する:

- 正本は**新規 append-only ログの新設ではなく**、既存`state.log`(+ 必要最小限の live state)からの
  **導出履歴**とする(2節)。
- 接触・network・統計は導出履歴の上に載せる read model とし、`ClusterMembershipEvent` 単体の
  実装Issueは開かない(#212 が履歴レコード実装を担う)。

### 0.3 本Issueの対象外(再掲)

- 履歴・network・統計の本実装(#212〜#214)。#212(会話履歴)・#213(接触ネットワーク)・#214(統計集計)は実装済み
- Canvas / timeline / graph / dashboard UI(#215〜#217)
- DB・クラウド保存・複数端末同期
- 人間関係の好悪推定、network centrality を社会的価値として評価すること
- 話題・情報伝播・口コミ拡散(Phase 5)
- 実データ較正・統計的因果推論
- 既存 runtime 挙動の変更

---

## 1. 正規単位の定義

すべての区間は半開区間`[startTick, endTick)`で表す。
滞在 tick 数は常に`endTick - startTick`(未完了は`asOfTick - startTick`)とし、
`tick - joinedAtTick`と**一致させる**(現行の`ticksInCluster`慣習を区間長の定義として固定する)。
`endTick`未定義の区間は active / censored であり、完了分布へ混ぜない(4.3節)。

### 1.1 会話エピソード (Conversation episode)

- **意味**: 1 agent の 1 回の`joined`〜episode 終了までの、ひとつながりの滞在期間。
- **開始条件**: `startConversationEpisode`が呼ばれた tick(＝ agent が`state === "joined"`になった瞬間)。
- **終了条件**: `departFromCluster`または整合性回復で`currentEpisode`がクリアされた tick。
- **再参加**: 同一 cluster への再参加は**別 episode**。`episodeId`は既存どおり
  `` `${agentId}:${clusterId}:${joinedAtTick}` `` で決定的に生成し、RNG を消費しない。
- **満足度・愛着**: episode に紐づく runtime 値であり、履歴レコードへコピーしてもよいが、
  分析層がそれらを再計算・更新してはならない(観測スナップショットのみ)。

### 1.2 cluster membership 区間 (Membership interval)

- **意味**: agent が特定 cluster の**正式 member**(`state === "joined"` かつ
  `joinedGroupId === clusterId` かつ `memberIds`に含まれる)だった連続期間。
- **episode との関係(決定事項)**: standingParty では **membership interval と conversation episode は 1:1**。
  同じ`startTick`/`endTick`/`episodeId`を共有してよい。別型に分けるのは API の読みやすさのためであり、
  二重の事実源を作らない。
- **含めないもの**:
  - `approaching`のみ(まだ member ではない)
  - nucleus founder の`forming`期間(episode 未開始、1.6節)
  - `pendingClusterTransition`保持中の`undecided`/`approaching`(membership なし)

### 1.3 cluster lifetime 区間 (Cluster lifetime)

- **意味**: 1 つの`GroupCandidate.id`が生成されてから、解散・期限切れ・linger cleanup で
  分析上「終了」とみなされるまでの期間。
- **開始**: `nucleusCreated`の tick(`createdAtTick`)。
- **確認**: `groupConfirmed`の tick(`confirmedAtTick`、未確認のまま消えた場合は undefined)。
- **終了候補**:
  - standingParty の`activeClusterDissolved`(責務10)
  - 未確認の`groupDissolved` / `groupExpired`
  - linger 猶予後の配列除去(履歴レコード自体は残す)
- **cleanup 後も**: `groupCandidates`から消えても lifetime レコードは分析可能な形で保持する
  (#212 の責務。本ADRでは「消えたら分析不能」を禁止する)。

### 1.4 cluster transition (Cluster transition)

- **意味**: source cluster からの離脱意図が、目的地付き移動または目的地なし再探索として
  確定してから、完了・無効化・abandon に至るまでの 1 過程。
- **目的地付き**: `PendingClusterTransition` +
  `clusterTransitionTargetSelected` → (`Invalidated` | `Abandoned` | `Completed`)。
- **目的地なし**: `departAndExplore`(`clusterDepartureCompleted` + `clusterResearchStarted`)。
  transition レコードとしては`result: "explore"`等で区別し、targeted 成功/失敗率の分母に入れない。
- **ID**: `` `${agentId}:${sourceClusterId}:${decidedAtTick}` `` を推奨(決定的、RNG 非消費)。
  同一 ID で selected → 結果イベントを紐づける。

### 1.5 contact interval (Contact interval)

- **意味**: 2 agent が**同一 cluster に同時に`joined`所属していた**連続期間。
- **再接触**: 同じ 2 人が別 cluster で再会した場合、または同一 cluster でも一旦同席が途切れた後の
  再会は**別 contact interval**。
- **ID**: `` `${min(agentA,agentB)}:${max(agentA,agentB)}:${clusterId}:${startTick}` ``
  (無向・決定的)。
- **含めないもの**(決定事項):
  - 接近しただけ / 空間的に近かっただけ
  - clique 所属が同じだけ
  - speech trust / relationshipTie の更新
  - forming 核での co-presence(1.6節)

### 1.6 forming 期間と接触の境界(決定事項)

| 状況 | `memberIds` | agent `state` | episode | contact に数えるか |
| --- | --- | --- | --- | --- |
| 核 founder、confirm 前 | 含む | `forming` | なし | **数えない** |
| forming 候補へ approach-join | 含む | `joined` | あり | **数える** |
| confirmed へ join | 含む | `joined` | あり | **数える** |
| approaching のみ | 含まない | `approaching` | なし | 数えない |

根拠: Phase 2 が「エピソード = `joined`〜離脱」と定義済みであり、接触を episode / membership の
重複から導けば off-by-one と二重定義を避けられる。核形成直後の「まだ会話として始まっていない輪」を
接触に含めると、confirm 前に解散した短命候補が network をノイズで埋めやすい。

---

## 2. 正本と導出データ(決定事項)

### 2.1 採用方針

**正本は`SimulationState.log`の構造化イベント(`eventType` + `metadata`)とし、
必要に応じてその時点の live state(`agents[].currentEpisode` / `groupCandidates` /
`pendingClusterTransition`)で未完了区間を補完する。**

engine 更新時に専用 append-only 履歴へ同時記録する方式、および毎 tick の状態差分スキャンを
正本にする方式は**採用しない**(本Issueの「runtime 不変」と、既存`standingPartyComparison.ts`の
導出パターンとの一貫性を優先)。

```
state.log (+ live episodes / candidates / pending transitions)
        │  pure, deterministic, no RNG
        ▼
 ConversationHistoryReadModel   (#212)
        │
        ├─► ContactNetworkReadModel   (#213)
        └─► StandingPartyStatistics   (#214)
                │
                └─► UI (#215–#217)  ※ state を mutation しない
```

### 2.2 最低条件への対応

| 条件 | 方針 |
| --- | --- |
| 意思決定と観察用履歴の循環依存を作らない | 分析 API は`stepSimulation`から呼ばない。`App.tsx` / Inspector / 将来 UI からの read-only 呼び出しのみ |
| 表示文言の文字列解析を行わない | `message`は参照禁止。`eventType`/`metadata`のみ |
| 二重記録時の ID・整合性 | 同一事実が複数イベントに現れる場合は canonical 開始/終了イベントを 1 つ決め、他は cross-check 用(2.4節) |
| pause / resume | `log`も導出履歴も破壊しない。pause 中は tick が進まないだけ |
| reset / scenario 切替 | 新`SimulationState`で`log`空。旧 run の分析は呼び出し側が保持した state からのみ可能(非永続アプリのまま) |
| observation horizon | active episode / open contact を勝手に完了扱いにしない。`asOfTick`時点で censored とする |
| DB・サーバ保存を導入しない | メモリ上の`SimulationState`と pure 導出のみ |

### 2.3 再構成ギャップと #212 での埋め方

現状の log だけでは完全再構成できない穴を明示し、#212 の実装選択肢を固定する。

#### Gap A: `membershipLost`に専用イベントが無い

`engine.ts`の整合性回復は`currentEpisode`クリアのみで、構造化イベントを出さない
(`ConversationEpisodeEndReason`コメントどおり)。

**#212 での採用(決定事項)**: 最小の構造化イベントを**1 種追加**してよい
(例: `clusterMembershipLost`、metadata に`agentId`/`groupId`/`episodeId`/
`episodeEndReason: "membershipLost"`/`ticksInCluster`)。
これは「分析契約を満たすための観測穴埋め」であり、意思決定・PRNG・離脱判定には使わない。
追加しない代替(最終 live state との差分推定)は、途中 tick の再生・horizon 途中の集計で
曖昧になるため却下する。

> **更新(Issue #212)**: Gap A は観測用イベント`clusterMembershipLost`の追加と、
> `buildStandingPartyConversationHistory`による履歴導出で解消済み。Gap B の canonical 開始規則
> (join系の畳み込み + `groupConfirmed`時のfounder開始)も同モジュールのテストで固定している。
>
> **更新(Issue #213)**: membership区間の時間重複から`ContactIntervalRecord` /
> `ContactNetworkEdge` / node / 記述指標を`buildStandingPartyContactNetwork`で導出する。
> clique / trust / relationshipTie は edge weight に混ぜず、比較用`comparisonAttributes`または
> 別ログとの照合に留める。実装は`src/simulation/contactNetwork.ts`(入口は
> `standingPartyAnalysis.ts`から再エクスポート)。
>
> **更新(Issue #214)**: 履歴・contactから`StandingPartyRunStatistics`(agent / cluster / run /
> ObserverJoiner比較 / 時系列)を`buildStandingPartyRunStatistics`で導出する。完了と
> active/censoredの分離、`DistributionSummary`(empty非捏造)、turnover=
> `(vol+forced)/max(join,1)`、meanMemberCount=区間加重平均、density分母=開始時populationを固定。
> 実装は`src/simulation/standingPartyStatistics.ts`(入口は`standingPartyAnalysis.ts`)。

#### Gap B: confirm 時の founder episode 開始に join イベントが無い場合がある

`groupConfirmed`で`forming`→`joined`になった founder は`startConversationEpisode`されるが、
必ずしも`agentJoined`を伴わない(再参加時のみ`clusterRejoined`)。

**導出規則(決定事項)**: episode 開始の canonical 信号は次のいずれか(先に定義した優先順):

1. `metadata.episodeId`を持つ join 系イベント
   (`agentJoined` / `observerJoinedForming` / `observerJoinedConfirmed` /
   `clusterRejoined` / `clusterTransitionCompleted`)
2. それ以外で live / 後続 end イベントから`` `${agentId}:${clusterId}:${joinedAtTick}` ``が
   復元できる場合、`groupConfirmed` tick とその agent の membership 変化を開始として扱う

同一`episodeId`を複数イベントが参照しても**1 episode に畳む**(ObserverJoiner 専用イベントと
`agentJoined`の併記を二重計上しない)。

#### Gap C: 強制 release と自発離脱の混同

既にイベントが分離されている:

- 自発: `clusterDepartureCompleted` + `episodeEndReason: "voluntaryDeparture"`
- 強制: `clusterMemberReleased` + `episodeEndReason: "memberReleased"`

統計・履歴は必ずこの分離を継承する(`StandingPartyRunSummary`と同型)。

### 2.4 イベント ↔ 履歴レコード対応表

| 事実 | Canonical 入力 | 生成レコード | 備考 |
| --- | --- | --- | --- |
| episode / membership 開始 | join 系 + Gap B 規則 | `ConversationEpisodeRecord` open | 同一`episodeId`は1件 |
| 自発終了 | `clusterDepartureCompleted` | episode close (`voluntaryDeparture`) | `departAndExplore`と`switchToTargetCluster`は`endReason`または付随フィールドで区別(#212 で`targetedTransition`を endReason に足してよい) |
| 強制 release | `clusterMemberReleased` | episode close (`memberReleased`) | 自発回数に入れない |
| 所属喪失 | `#212`で追加する`clusterMembershipLost`(Gap A) | episode close (`membershipLost`) | |
| 目的地なし再探索 | `clusterResearchStarted` | `ClusterTransitionRecord`(`explore`) | targeted 成功率の分母外 |
| targeted 開始 | `clusterTransitionTargetSelected` | transition open | |
| targeted 完了 | `clusterTransitionCompleted` | transition success + 新 episode 開始 | |
| targeted 失敗 | `Invalidated` / `Abandoned` | transition failure | |
| cluster 生成 | `nucleusCreated` | `ClusterLifetimeRecord` open | |
| cluster 確認 | `groupConfirmed` | lifetime.`confirmedAtTick` | founder episode 開始の Gap B 入力 |
| active 縮小/解散 | `activeClusterShrunk` / `Dissolving` / `Dissolved` | lifetime 更新 / close | |
| 未確認解散/期限切れ | `groupDissolved` / `groupExpired` | lifetime close | |
| contact | membership 区間の時間重複 | `ContactIntervalRecord` | イベント直接ではなく導出 |

### 2.5 履歴寿命

| 操作 | 履歴の扱い |
| --- | --- |
| Start / Pause / Resume / Step | 破壊しない |
| Reset | 新 state。旧 state を保持していなければ分析不可(現行アプリと同じ非永続) |
| observation horizon 到達 | `simulationFinished`/`observationHorizonReached`を記録。open 区間は censored |
| scenario / preset 切替 | Reset と同型(新 state) |

破壊的な集約(元イベントを捨てて summary だけ残す)は禁止する。UI は常に
「履歴レコード → 表示用投影」の一方向とする(将来の再生 UI に耐える)。

---

## 3. 接触ネットワークの意味(決定事項)

### 3.1 グラフ要素

| 要素 | 定義 |
| --- | --- |
| node | agent(`agentId`) |
| edge | 2 agent 間に 1 つ以上の`ContactIntervalRecord`が存在するとき張る**無向**辺 |
| edge key | `` `${minId}:${maxId}` `` |

### 3.2 edge 属性(weight 候補)

最低限、次を持てば #213 / #216 が実装できる:

- `totalCoPresenceTicks`: 全 contact interval の区間長合計
- `contactIntervalCount`: 区間数
- `distinctClusterCount`: 同席した異なる cluster 数
- `firstContactTick` / `lastContactTick`
- `isActive`: `asOfTick`時点で open な contact interval があるか

追加の中心性指標(degree 以外の betweenness 等)を社会的価値として解釈することは対象外。
degree / strength は記述統計として出してよいが、UI 文言で「重要人物」などと評価しない(#218 まで継承)。

### 3.3 明示的に同一視しないもの

| 概念 | 層 | contact edge との関係 |
| --- | --- | --- |
| `cliqueId` / `existingTieStrength` | 事前の友人関係カテゴリ(run 中不変) | **別属性**。edge の有無と同一視しない |
| speech `trust`(Roadmap #61) | 発話と行動の一貫性から更新される有向信頼 | 別軸。contact から自動更新しない |
| `relationshipTie`(Roadmap #61) | 同様の一貫性履歴 → attractiveness 補正 | 別軸。contact の weight に足さない |
| 空間近接 | 座標距離 | contact ではない |

Phase 5 の情報伝播が再利用してよいのは**接触事実(contact interval / edge の存在と区間)**までである。
話題モデル・伝播確率・口コミ内容は本契約の外に置き、型にもフィールドを先取りしない。

---

## 4. 統計指標契約

集計は「完了サンプル」と「active / censored サンプル」を常に分離する。
平均値だけでなく、**件数・中央値・分位点**を優先して API に含める
(平均のみの API を禁止はしないが、分布系 UI の正本にはしない)。

### 4.1 agent 別

| 指標 | 定義 | 分母・欠損 |
| --- | --- | --- |
| `episodeCount` | 開始した episode 数(active 含む) | — |
| `completedEpisodeCount` | `endedAtTick`定義済み | — |
| `completedDwellTicks` | 完了 episode の`dwellTicks`一覧 | 未完了は混ぜない |
| `activeDwellTicks` | open episode の`asOfTick - startTick` | horizon / 現在時刻依存 |
| `distinctContactCount` | 1 つ以上の contact を持った相手数 | 自己は除外 |
| `totalContactTicks` | 全 contact interval 長の合計 | 相手ごとにも内訳可能 |
| `clusterMoveCount` | membership 終了のうち「別 cluster へ移る意図を伴う」数 | venue exit は別 |
| `targetedTransitionSuccessCount` / `FailureCount` | transition result | explore は分母外 |
| `voluntaryDepartureCount` / `forcedReleaseCount` | #190 と同義 | 混同禁止 |

### 4.2 cluster 別

| 指標 | 定義 |
| --- | --- |
| `lifetimeTicks` | `endedAtTick - createdAtTick`(未終了は censored) |
| `peakMemberCount` / `meanMemberCount` | lifetime 中の member 数(joined のみ) |
| `joinCount` / `voluntaryLeaveCount` / `forcedReleaseCount` | イベント件数 |
| `turnover` | `(voluntaryLeave + forcedRelease) / max(joinCount, 1)`(#214で数値固定) |
| `endReason` | dissolved / expired / stillActive / cleanedUp |

### 4.3 run 全体

| 指標 | 定義 |
| --- | --- |
| 滞在時間分布 | **完了** episode の`dwellTicks`の件数・中央値・分位点 |
| 接触人数分布 | agent 別`distinctContactCount`の分布 |
| network density | `2|E| / (n(n-1))`。分母nはrun開始時populationで固定(#214)。接触に現れたnode集合ベースのdensityは`ContactNetworkMetrics`に別途保持 |
| 孤立 node 数 | degree 0 の agent 数 |
| cluster lifetime 分布 | 完了 lifetime のみ |
| 目的地付き移動成功率 | `success / (success + failure)`。explore 除外 |

未完了 episode を完了分布へ混ぜることは**禁止**。UI が「現在までの暫定」を出す場合は
active 系列を別シリーズとして重ねる。

### 4.4 ObserverJoiner 比較

- ObserverJoiner 個人値と、非 ObserverJoiner 集団の記述統計(中央値・分位点・件数)を並べてよい。
- **優劣評価・因果推論・介入効果の検定は行わない**(文言・API 名にも`effect`/` uplift`等を使わない)。
- #190 の比較サマリーを置き換えず、横に薄い層として載せる
  (`StandingPartyRunSummary`は維持。Phase 4 統計は`StandingPartyAnalysisStatistics`等の別型)。

---

## 5. 時間窓・snapshot

### 5.1 同じ導出履歴、用途別 read model

| 窓 | 用途 | API 形 |
| --- | --- | --- |
| run 全体(`asOfTick = final`または horizon) | ダッシュボード・MC | `build*(state)` |
| 現在 tick まで | 実行中 Inspector | 同上 + `asOfTick` |
| 任意`[from, to)` | 将来の再生 UI・区間比較 | `build*(state, { fromTick, toTick })` |
| 現在の active contact | network ハイライト | contact の`isActive`フィルタ |

履歴レコードを窓ごとに作り直すのではなく、**全区間レコードを一度作り、窓で filter / clip**する。
clip 時も半開区間規約を保ち、窓外に完全に落ちる区間は除外、部分重複は
`max(start, from)`〜`min(end, to)`へ切る(長さ 0 になったら除外)。

### 5.2 snapshot の非破壊

集計キャッシュを持っても、元の`log`と episode/membership/contact レコードは破棄しない。
memoization キーは`(runId | seed, asOfTick, schemaVersion, filter)`を推奨。

---

## 6. ID・schema・互換性

### 6.1 ID 再利用・生成

| ID | 生成規則 |
| --- | --- |
| `agentId` / `clusterId` | 既存値を再利用 |
| `episodeId` | 既存 `` `${agentId}:${clusterId}:${joinedAtTick}` `` |
| `transitionId` | `` `${agentId}:${sourceClusterId}:${decidedAtTick}` `` |
| `contactIntervalId` | `` `${min}:${max}:${clusterId}:${startTick}` `` |
| `networkEdgeKey` | `` `${min}:${max}` `` |
| lifetime レコード key | `clusterId`(1 cluster 1 record) |

いずれも RNG 非消費・決定的。同じ入力 state からは byte 同一の read model が得られること。

### 6.2 schema version

```ts
/** standing-party Phase 4 分析 read model の互換バージョン。#61 Phase 4 とは無関係 */
export const STANDING_PARTY_ANALYSIS_SCHEMA_VERSION = 1 as const;
```

- フィールド追加は加算変更(古い consumer が無視できる形)を基本とする。
- 意味変更・区間規約変更は version bump + 変換関数、または新フィールド併記。

### 6.3 シナリオ共通化範囲

| 機能 | afterParty | classroomPair | standingParty |
| --- | --- | --- | --- |
| episode / membership 導出の骨格 | 利用可(終端 join が主) | 利用可 | 主用途 |
| cluster lifetime(可変 confirmed) | confirmed 後は静的 | 静的 | 必須 |
| contact network | 技術的には導出可だが UI 対象外 | 同左 | 必須 |
| targeted transition 統計 | イベント無しで空 | 空 | 必須 |
| 離脱 turnover | 原則 0 | 原則 0 | 必須 |

共通コードは`standingPartyAnalysis.ts`(仮)内の pure 関数として置き、
`formationScenarioId !== "standingParty"`でも例外を投げず空/ゼロを返す
(`standingPartyComparison.ts`と同型)。afterParty / classroomPair 向けの専用 UI は Phase 4 の範囲外。

### 6.4 Phase 4「無効」時の挙動

分析モジュールは**常に導出可能**(設定フラグで PRNG や决策を切り替えない)。
「無効」とは UI が呼び出さないことのみを意味する。
`stepSimulation`の経路に分析コードを挿入しないため、呼び出さなければ
シミュレーション結果・PRNG 系列は byte-identical。

---

## 7. 性能・保持方針

### 7.1 目標

- 想定: **1000 tick × population ≈ 24**(standingParty プリセット)、UI tick 間隔 250ms。
- 目標: 分析の再計算が 1 フレームの操作感を阻害しない(おおよそ数 ms〜十数 ms 級を目安)。
- **禁止**: 毎 render で O(tick × agent²) のフルペア走査を素朴に繰り返すこと。

### 7.2 計算戦略

| 処理 | 方針 |
| --- | --- |
| episode / membership / lifetime / transition 履歴(#212) | log の 1 パス掃引で構築。O(log 長) |
| contact intervals(#213) | membership 区間を cluster 別に束ね、cluster 内の区間重複で生成。cluster 内人数は小さい前提で O(Σ m_c²) |
| 統計(#214) | 履歴レコードの fold。分布は配列保持 + 分位点 |
| UI 実行中 | `asOfTick`単位で memoize。tick が進んだときだけ再計算 |
| MC / 終了時 | 各 run 終了時に 1 回集計し、summary だけ保持してよい(ただし単発 UI 用に元 log は state に残る) |

### 7.3 保持上限

- `state.log`に履歴上限を設けて古いイベントを落とす設計は**採用しない**
  (分析値が欠落するため)。
- 将来どうしても上限が必要なら、落ちる前に正規履歴レコードへ flush する前提を別 Issue で扱う。
- 本フェーズの非永続アプリでは、Reset で解放する以外の eviction を入れない。

---

## 8. 型案(実装は #212 以降)

名称は #212 のスケッチと整合させる。本節は契約であり、本Issueでは`types.ts`へ追加しない。

```ts
export const STANDING_PARTY_ANALYSIS_SCHEMA_VERSION = 1 as const;

/** 完了分布に混ぜないための区間状態 */
export type AnalysisIntervalStatus = "active" | "completed" | "censored";

export type ConversationEpisodeEndReasonV2 =
  | ConversationEpisodeEndReason
  | "targetedTransition"
  | "venueExit"
  | "reset";

export type ConversationEpisodeRecord = {
  episodeId: string;
  agentId: string;
  clusterId: string;
  startedAtTick: number;
  endedAtTick?: number;
  /** endedAtTick 定義時は endedAtTick - startedAtTick。active/censored は asOfTick - startedAtTick */
  dwellTicks: number;
  status: AnalysisIntervalStatus;
  endReason?: ConversationEpisodeEndReasonV2;
  joinedGroupStatus: GroupCandidateStatus;
  startMemberIds: string[];
  endMemberIds?: string[];
};

/** episode と 1:1。API 便宜上の別名レコードでもよい */
export type ClusterMembershipInterval = {
  intervalId: string; // === episodeId を推奨
  agentId: string;
  clusterId: string;
  startedAtTick: number;
  endedAtTick?: number;
  status: AnalysisIntervalStatus;
  episodeId: string;
};

export type ClusterLifetimeRecord = {
  clusterId: string;
  createdAtTick: number;
  confirmedAtTick?: number;
  dissolvingAtTick?: number;
  endedAtTick?: number;
  status: AnalysisIntervalStatus;
  endReason?: "activeClusterDissolved" | "groupDissolved" | "groupExpired" | "cleanedUp";
  peakMemberCount: number;
  joinCount: number;
  voluntaryLeaveCount: number;
  forcedReleaseCount: number;
};

export type ClusterTransitionRecord = {
  transitionId: string;
  agentId: string;
  sourceClusterId: string;
  targetClusterId?: string;
  focusAgentId?: string;
  startedAtTick: number;
  endedAtTick?: number;
  result?: "completed" | "invalidated" | "abandoned" | "explore";
  invalidationReason?: string;
  sourceEpisodeId?: string;
  targetEpisodeId?: string;
};

export type ContactIntervalRecord = {
  contactIntervalId: string;
  agentIdA: string; // min(id)
  agentIdB: string; // max(id)
  clusterId: string;
  startedAtTick: number;
  endedAtTick?: number;
  status: AnalysisIntervalStatus;
  dwellTicks: number;
};

export type ContactNetworkEdge = {
  edgeKey: string;
  agentIdA: string;
  agentIdB: string;
  totalCoPresenceTicks: number;
  contactIntervalCount: number;
  distinctClusterCount: number;
  firstContactTick: number;
  lastContactTick: number;
  isActive: boolean;
};

export type StandingPartyAnalysisSnapshot = {
  schemaVersion: typeof STANDING_PARTY_ANALYSIS_SCHEMA_VERSION;
  asOfTick: number;
  episodes: ConversationEpisodeRecord[];
  membershipIntervals: ClusterMembershipInterval[];
  clusterLifetimes: ClusterLifetimeRecord[];
  transitions: ClusterTransitionRecord[];
  contactIntervals: ContactIntervalRecord[];
  networkEdges: ContactNetworkEdge[];
};
```

推奨モジュール配置:

- `src/simulation/standingPartyAnalysis.ts` — 履歴・contact・統計の pure 導出の入口
  (#212で`buildStandingPartyConversationHistory`、#213で`buildStandingPartyContactNetwork`、
  #214で`buildStandingPartyRunStatistics`を実装済み。`standingPartyComparison.ts`は維持)
- `src/simulation/contactNetwork.ts` — #213: membership重複→contact interval / edge / node / 指標
- `src/simulation/standingPartyStatistics.ts` — #214: 分布要約・agent/cluster/run統計・時系列
- UI コンポーネントは`src/components/`に置き、シミュレーション規則を持たない
  (既存の presentational 規律)。

---

## 9. read model / 集計 API の責務境界

| 層 | 責務 | 禁止事項 |
| --- | --- | --- |
| `engine.ts` / `FormationPolicy` | 意思決定・状態遷移・構造化イベント生成 | 分析レコードの構築、network 集計 |
| `state.log` + live episode | 観測正本 | 表示文言への依存 |
| `standingPartyAnalysis.ts`(予定) | log → 正規履歴 → contact → 統計 | `SeededRandom`の消費、`Agent` trait / stress の更新、`stepSimulation`からの呼び出し |
| `standingPartyComparison.ts` | #190 比較指標(維持) | Phase 4 network をここに詰め込みすぎない |
| `App.tsx` / components | 表示・フィルタ・エクスポート | 独自に join/leave を数え直すこと、message 文字列 parse |
| Phase 5(将来) | 接触事実を入力に伝播モデルを載せる | Phase 4 型へ話題フィールドを逆流入させること |

Inspector や将来ダッシュボードが欲しい値は、すべて分析 API 経由で取得する。
「画面ごとに`state.log`を filter して count++」は #215 以降も禁止(回帰の温床)。

---

## 10. 後続 Issue の実装順と移行手順

Roadmap #172 の推奨順を本契約で固定する:

1. **#212 会話履歴モデル**
   - `ConversationEpisodeRecord` / membership / lifetime / transition を実装
   - Gap A(`clusterMembershipLost`イベント追加)をこの Issue で解消
   - Gap B の canonical 開始規則をテストで固定
   - `membershipLost` / `targetedTransition` / censored を区別
2. **#213 接触ネットワーク** — **実装済み**
   - membership 重複から`ContactIntervalRecord` / `ContactNetworkEdge`
   - clique / trust / tie と混同しないテスト
3. **#214 統計集計** — **実装済み**
   - agent / cluster / run 指標、未完了分離、ObserverJoiner 記述統計
4. **#215 / #216 / #217** UI(タイムライン・graph・ダッシュボード)
5. **#218** 統合検証・E2E(1000 tick、複数 seed、desktop / iPhone 幅)

### 移行時の不変条件

- `afterPartyRegression` / `classroomPairInvariants` / standingParty Phase 2〜3 長時間テストが
  無改修または分析専用テスト追加のみで通過する。
- #212 で Gap A イベントを足す場合でも、**PRNG 消費順序と意思決定結果は変えない**
  (イベント push は既存`pushLog`と同様、乱数非消費)。
- `StandingPartyRunSummary`の既存フィールド意味を壊さない。
- `interaction-cluster-model.md` Follow-up D は本ADRに委譲済みとみなす(文書側を更新)。

---

## 11. 受入条件との対応

| #211 受入条件 | 本ADRの節 |
| --- | --- |
| episode / membership / contact / lifetime の定義が固定 | §1 |
| 既存構造化 event との対応と正本が決定 | §2 |
| contact network と clique / trust / tie の違い | §3 |
| agent / cluster / run 統計の定義・分母・未完了 | §4 |
| tick 範囲と off-by-one を防ぐ区間規約 | §1 冒頭、§5 |
| analysis が意思決定・PRNG へ影響しない境界 | §2.2、§6.4、§9 |
| afterParty / classroomPair との共通化範囲 | §6.3 |
| 1000 tick を想定した性能・保持方針 | §7 |
| Phase 5 へ渡すのは接触事実まで | §3.3 |
| 既存 runtime 挙動は本Issueでは変更しない | 冒頭・対象外・本Issueの成果物は文書のみ |
| lint / test / build 成功 | 文書のみの変更で既存どおり成功すること |

---

## 12. 決定事項一覧(実装 Issue が再議論しないこと)

1. 区間は半開`[start, end)`。`dwellTicks = end - start`。
2. membership と episode は standingParty で 1:1。forming founder の confirm 前は membership/contact 外。
3. contact は「同一 cluster への同時`joined`所属」のみ。近接・clique・trust・tie は非接触。
4. 正本は`state.log`(+ live 補完)からの pure 導出。専用履歴ログの二重正本は作らない。
5. `membershipLost`穴は #212 で観測用イベントを追加して埋める(决策非影響)。
6. 未完了 episode は完了分布に混ぜない(active / censored 分離)。
7. 強制 release と自発離脱を統計上混同しない。
8. 分析 API は RNG 非消費・`stepSimulation`非介入。
9. schema version は`STANDING_PARTY_ANALYSIS_SCHEMA_VERSION`( #61 Phase 4 と分離)。
10. Follow-up D(`ClusterMembershipEvent`単体)は本契約で supersede。
11. Phase 5 用に話題・伝播フィールドを先取りしない。
12. 本Issueではコード挙動を変更しない。
