# Venue Anchorと飲食目的行動の最小ドメイン契約 (Issue #261, standing-party Phase 7 設計)

Parent Roadmap: #172。Depends on: Phase 6 #246〜#252。Blocks: #262(配置とCanvas)、#263(needとdecision)、
#264(目的移動と取得)、#265(ステーション付近の再形成)、#266(presetと表示)、#267(検証とE2E)。

この文書は、立食パーティー(`standingParty`)に料理台とドリンク台を置き、会話とは独立した飲食目的の
移動を足すための**ドメイン契約(ADR)**である。本Issueの成果物は設計文書のみであり、`engine.ts`、
`SimulationState`、`Agent`、`GroupCandidate`、既存の状態・event・PRNG消費順は変更しない。
型とruntimeの実装は #262 以降が本契約に従って行う(§11)。

> **Phase名の注意**: 本文書の Phase 7 は Roadmap #172 の「Venue Anchors と飲食目的の移動」を指す。
> Roadmap #61 の speech Phase 3/4 とは別の番号体系である。

成功の定義は、通常の実行で「会話から離れる → 料理台またはドリンク台へ移動する → その場で止まって
受け取る → 会場の回遊へ戻る」までが目で追えることである。現実の食欲・人流・行列への較正は求めない。
係数は仮説的なシミュレーションパラメータである。

---

## 0. 決定要約

1. `VenueAnchor` は会話clusterとは別entityである。`GroupCandidate` にも `isPublicMeetingPoint` にも
   偽装しない。anchorへの接近だけでは contact・内容発話・会話参加を作らない。
2. 飲食欲求(`AgentRefreshmentNeed`)は `stress` / `willingness` / 会話満足度 / 愛着 /
   `socialCirculationTendency` とは別の `[0,1]` 状態である。意思決定式へ混入しない。
3. 進行中の訪問は agent あたり最大1件の `PendingVenueVisit` であり、`pendingClusterTransition` と
   同時に存在してはならない。`done` は保存しない。完了したtickで訪問レコードを消す。
4. 行動の優先順位は「会場退出 > 形成中・接近中 > 進行中の社会的移動意図 > 進行中の飲食訪問 >
   最低滞在 > 欲求判定」である。愛着と離脱配慮は飲食離脱を止めない。社会的離脱の乱数判定が
   同じtickで離脱を確定した場合は、そのtickの飲食訪問は開始しない。
5. 飲食のための離脱理由は `venueRefreshmentBreak` である。`clusterDepartureStarted` /
   `voluntaryDeparture` / `clusterBelowMinimumSize` / 会場退出(`leaving`)とは別イベントにする。
   残ったmemberの縮小・解散は既存の責務10のままである。
6. 訪問中とその完了tickは、曖昧さによる stress 増分と `canLeave` を評価しない。stressの値自体は
   リセットしない。飲食移動が会場退出を積み増さない。
7. 行列・在庫・価格は作らない。capacityは「受け取り中＋消費中の同時人数の上限」であり、空きが
   なければそのtickで訪問を放棄する。待ちphaseは無い。
8. 更新順は、Phase 6のcluster座標更新と既存の社会的decisionのあと、飲食decision → 目的移動 →
   到着・取得・完了である。描画はsimulationを駆動しない。
9. 飲食decisionとanchor選択はrngを使わない。個体差の初期化だけが、主系列とは独立した派生streamを
   1agentにつき4回だけ消費する。`enabled: false` のときは Phase 6 までの state・event・座標・
   主系列PRNGを変更しない。`afterParty` / `classroomPair` では実行しない。
10. 初期MVPの配置は料理台1・ドリンク台1で、座標は §10 で固定する。全agentへの常時
    `anchorAttraction` は採用しない。目的訪問の `traveling` 中だけ、roamingとcrowdingを止めて
    anchorへ直進する。

---

## 1. 現状との境界

### 1.1 Phase 6 までで固定済みの土台

本Phaseは次を置き換えない。飲食訪問は、これらの空いたスロットへ割り込む。

| 既存の契約 | 実装の要点 | Phase 7 での扱い |
| --- | --- | --- |
| 会場 | `WORLD_WIDTH = 800`、`WORLD_HEIGHT = 520`。agentのclampは `[5, W-5] × [5, H-5]` | 変更しない。anchorもこのagent到達範囲の内側に置く |
| 接近速度 | `APPROACH_SPEED = 14` | 飲食の直進速度はこれ以下(§7.1、既定10) |
| 社会的移動意図 | `Agent.pendingClusterTransition`。生成後はtargetを乗り換えない | 飲食訪問と同時に持たせない。飲食側から破棄しない |
| 最低滞在 | `clusterDeparture.minStayTicks`(既定15) | 飲食離脱も同じ値を使う。第二の滞在時計は作らない |
| 再接近cooldown | `CLUSTER_REJOIN_COOLDOWN_TICKS = 10` | 飲食離脱でも `lastDepartedClusterId` を書き、即時再合流を防ぐ |
| 会話エピソード | `currentEpisode`。分析は `clusterDepartureCompleted` / `clusterMemberReleased` / `clusterMembershipLost` で閉じる | 飲食離脱は新しいeventで閉じる(§6.2) |
| stress | `undecided` のときだけ増える。`canLeave` は `stress > leaveThreshold` | 訪問中は評価自体をスキップする(§6.4) |
| Phase 6 空間 | cluster斥力は step 1 の前。undecidedのroamingは step 6。`spatialDynamics.enabled === false` なら座標も主系列PRNGもPhase 5までと一致 | 飲食の移動は step 6 のroamingを、そのagentについてだけ置き換える |
| 接触 | 同一clusterのmembership区間の重なり | anchorの近さは接触にしない |
| 内容発話 | confirmed clusterのmembershipから生成 | anchor上では生成しない |

`stepSimulation` のtickは `const tick = state.tick + 1` である。needの増分もイベントもこのtick番号を使う。

### 1.2 混ぜてはならない概念

| 概念 | このPhaseでの意味 |
| --- | --- |
| `VenueAnchor` | 料理または飲み物を受け取る固定設備。会話の輪ではない |
| `AgentRefreshmentNeed` | そのagentの空腹・喉の渇き。社会的評価でもストレスでもない |
| `PendingVenueVisit` | 設備へ向かう・受け取る・短い消費を終えるまでの一時的な行動 |
| `pendingClusterTransition` | 特定の会話clusterへ向かう社会的意図 |
| `socialCirculationTendency` | 会話に不満がなくても次の輪へ移りやすい特性。歩く速さでも食欲でもない |
| 愛着 / 離脱配慮 | 今の会話から離れにくくする社会的抑制。飲食離脱の可否には使わない |
| `stress` / `leaveThreshold` | 曖昧な未定状態が続いたときの会場退出。飲食台への移動理由ではない |
| `venueExit` (分析の既存endReason) | 会場からいなくなったこと。飲食休憩ではない。新しい理由名は `venueRefreshmentBreak` |
| `isPublicMeetingPoint` | 介入用の、founder不在の `GroupCandidate`。飲食台ではない |
| Phase 4 contact | 同じ会話clusterに同時に所属していた観測。同じ台の近くに立ったことではない |
| Phase 6 roaming | 目的地が無いときの会場歩行。飲食台が決まっている間は適用しない |

飲食欲求は `attractiveness()`、離脱hazard、他cluster関心、topic機会、空間score、crowding fieldの
入力にしない。接続してよいのは §5 の飲食decisionと、§7 の訪問runtimeと、read-onlyの表示だけである。

### 1.3 Phase 6 の「第5成分」スケッチの具体化

`docs/spatial-dynamics-phase6-model.md` §10 は、将来 `anchorAttraction` を全agentの移動合成の
第5成分にできる、とだけ書いていた。本Phaseはその形を**採用しない**。常時の弱い吸引では
「台へ行って止まる」が見えず、roamingと打ち消し合う。

採用するのは次の置換である。

- `pendingVenueVisit.phase === "traveling"` のagentだけ、roamingもcrowdingもゼロにし、
  anchor中心への直進と、既存のagent側wall avoidanceだけを合成する。
- `receiving` / `consuming` のagentは速度ゼロでその場に止まる。
- それ以外のagentの移動式はPhase 6のままである。cluster斥力にもanchor項を足さない。
- 維持するPhase 6契約は、成分ごとのclamp → 加算 → 合成clamp、空間phase(S1〜S4)がmembershipを
  書き換えないこと、主系列RNGを飲食の初期化に使わないこと、である。

入口・窓際・障害物・NavMesh・物理衝突・実データ較正は、本Phaseでも導入しない。

---

## 2. VenueAnchor

### 2.1 型

```ts
export type VenueAnchorKind = "food" | "drink";

export type VenueAnchor = {
  id: string;                 // 例: "anchor:food-main"
  kind: VenueAnchorKind;
  x: number;
  y: number;
  interactionRadius: number;  // 到着と受け取り位置の半径
  capacity: number;           // receiving + consuming の同時人数上限。待ち行列ではない
  serviceTicks: number;       // receiving の滞在tick数
  label: string;              // 表示用の短い名前。decisionは解析しない
};
```

- 正本は `StandingPartyScenarioConfig.venueAnchors.anchors` である。run中に追加・移動・削除しない。
- `createInitialState` は、機能が有効なときだけ同じ配列を `SimulationState.venueAnchors` へ
  コピーする。Canvasは自分で座標を作らず、この配列(または同じconfig)を描く。
- `id` がidentityである。`label` は `料理台` / `ドリンク台` のような表示名で、分岐条件に使わない。
- 同kindのanchorが複数あってもよい。MVPのcatalogは各1件である(§10)。
- `GroupCandidate` をanchorの数だけ生成しない。`memberIds` も `status` も持たない。

### 2.2 検証

`validateVenueAnchorConfig` がdomain layerで拒否する。UIの入力チェックだけに依存しない。
`enabled` が false でも、配列に要素があるなら同じ検証を通す。

| 条件 | 扱い |
| --- | --- |
| `id` が空、または配列内で重複 | 拒否 |
| `kind` が `food` / `drink` 以外 | 拒否 |
| `x` / `y` / `interactionRadius` が非finite | 拒否 |
| 座標が `[5, WORLD_WIDTH - 5] × [5, WORLD_HEIGHT - 5]` の外 | 拒否 |
| `interactionRadius` が `<= 0` または `> 80` | 拒否 |
| `capacity` が 1 未満の整数、または非整数 | 拒否 |
| `serviceTicks` が 1 未満の整数、または非整数 | 拒否 |
| `label` が空 | 拒否 |
| 任意の2anchorの中心距離が `200` 未満 | 拒否 |
| `visit.approachSpeed > anchor.interactionRadius` となるanchorがある | 拒否 |

最後の条件は、直進1tickが半径を飛び越えないためである。中心へ向かう1stepの長さが半径以下なら、
半径の外から中心へ進む移動は円の中に着地する。

### 2.3 初期MVPの配置

初期人口の抽選範囲は、非cliqueがおおよそ `x [80, 720)`・`y [78, 442)`、clique中心が
`x [120, 680)`・`y [104, 416)` に `±30` である。台はその外側の辺沿い、かつ壁回避が効き始める
40pxより内側に置く。初期配置が台の点を覆わない。

| id | kind | x | y | interactionRadius | capacity | serviceTicks | label |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `anchor:food-main` | `food` | 72 | 460 | 28 | 3 | 4 | `料理台` |
| `anchor:drink-main` | `drink` | 728 | 60 | 28 | 3 | 4 | `ドリンク台` |

二点の距離は `sqrt(656^2 + 400^2) ≈ 768` で、200以上である。壁までの最短距離はそれぞれ 60 と 72 で、
既定の wall margin 40 より大きい。定数名は `MVP_FOOD_ANCHOR` / `MVP_DRINK_ANCHOR` /
`MVP_VENUE_ANCHORS` とする。

---

## 3. AgentRefreshmentNeed

### 3.1 型と置き場所

```ts
export type AgentRefreshmentNeed = {
  hunger: number;   // [0, 1]
  thirst: number;   // [0, 1]
  hungerRate: number;
  thirstRate: number;
  /** このtick以上で、そのkindの新しい訪問を開始してよい */
  foodCooldownUntilTick?: number;
  drinkCooldownUntilTick?: number;
};

export type VenueRuntimeState = {
  needs: Record<string, AgentRefreshmentNeed>; // agentId
  visits: Record<string, PendingVenueVisit>;   // agentId。無ければキーを置かない
  /** Inspector用。直近のdecision。シミュレーションの入力にしない */
  lastDecisions?: Record<string, VenueVisitDecision>;
};
```

`SimulationState.venueRuntimeState?` に置く。`Agent` へフィールドを増やさない。
`spatialRuntimeState` と同じく、呼び出し側がconfigを渡し忘れても直前のruntimeを引き継ぐ。
機能が無効な間は `venueRuntimeState` も `venueAnchors` も `undefined` のままである。

`left` / `unassigned` になったagentのneedは残してよい(観察用)。訪問は §7.4 で破棄する。
死亡や退場でneedを削除して再生成しない。Resetは `createInitialState` が新しいruntimeを作る。

### 3.2 初期化

有効なときだけ、`createInitialState` が各agentについて派生streamを作る。

```text
createVenueRandom(runSeed, "needInit", agentId, 0)
  = SeededRandom(hashString(`${runSeed}:venueAnchors:needInit:${agentId}:0`))
```

ハッシュは `createSpatialRandom` と同じ FNV-1a 風実装で、名前空間を `venueAnchors` に分ける。
主系列の `SeededRandom` は読まない。1agentにつき次の4呼出しだけを、この順で行う。

```text
hunger     = rng.range(needs.initialMin, needs.initialMax)   // 既定 [0.05, 0.35)
thirst     = rng.range(needs.initialMin, needs.initialMax)
hungerRate = rng.range(needs.rateMin, needs.rateMax)         // 既定 [0.85, 1.15)
thirstRate = rng.range(needs.rateMin, needs.rateMax)
```

tick 0 の初期値には増分を足さない。増分は最初の `stepSimulation`(tick = 1)から毎tick 1回である。

### 3.3 毎tickの増分と補充

```text
hunger' = clamp(hunger + needs.hungerGainPerTick * hungerRate, 0, 1)
thirst' = clamp(thirst + needs.thirstGainPerTick * thirstRate, 0, 1)
```

- 対象は `state` が `left` / `unassigned` 以外の、runtimeにneedがある全agentである。
  `joined` や訪問中も含む。
- 取得tickでは、増分を適用したあと、その訪問のpurposeに対応する一方だけを
  `needs.needAfterRefill` へ代入する。もう一方は増分後の値を保つ。二重代入しない。
- 補充は `refreshmentObtained` のtickに1回だけである。`consuming` のあいだは再代入しない。
- 検証は `needAfterRefill < visitThreshold` を要求する。補充直後に同じ閾値を超えたままにしない。

既定値での到達目安(仮説値であり、人間の生理ではない):

| 条件 | 閾値 0.70 に達するstep数 |
| --- | --- |
| hunger 0.20、rate 1、gain 0.0032 | `ceil((0.70 - 0.20) / 0.0032) = 157` |
| thirst 0.35、rate 1.15、gain 0.004 | `ceil((0.70 - 0.35) / 0.0046) = 77` |

標準presetの数百tickの中で、初期値が高めのagentから複数の訪問が始まる係数である。

---

## 4. PendingVenueVisit

### 4.1 型

```ts
export type VenueVisitPhase = "traveling" | "receiving" | "consuming";

export type PendingVenueVisit = {
  visitId: string; // `${agentId}:${anchorId}:${startedAtTick}`
  anchorId: string;
  purpose: VenueAnchorKind;
  startedAtTick: number;
  phase: VenueVisitPhase;
  phaseEnteredAtTick: number;
  decisionReason: "selectedFood" | "selectedDrink";
};
```

`done` はphaseに含めない。完了はevent `venueVisitCompleted` で表し、同じtickで `visits` から
そのagentのキーを削除する。放棄もレコードを残さない。

phaseの意味:

| phase | 位置 | 社会的探索 |
| --- | --- | --- |
| `traveling` | anchor中心へ直進 | 核形成・候補接近・roamingをしない |
| `receiving` | 着地した位置で停止。サービスtickを数える | 同じ |
| `consuming` | 同じ位置で停止。受け取ったあとの短い表示用滞在 | 同じ |

経過tickは両端を含む。

```text
elapsedTicks = tick - phaseEnteredAtTick + 1
```

`elapsedTicks >= duration` のtickの終端処理で次phaseへ進む。遷移したtickの新しいphaseは
`phaseEnteredAtTick = tick` なので、そのtickの経過は 1 である。

### 4.2 同時に持ってはならないもの

agentについて次を不変条件にする。

- `visits[agentId]` と `agent.pendingClusterTransition` は同時に定義されない。
- 訪問があるなら `state === "undecided"` かつ `joinedGroupId` も `currentEpisode` も無い。
- 訪問の `anchorId` はcatalogに存在する。消えた場合は同じtickで放棄する。
- 1agent 1訪問。目的地とpurposeは開始後に変えない。

### 4.3 寿命

| 終わり方 | 条件 | その後 |
| --- | --- | --- |
| 完了 | `consuming` の経過が `visit.consumeTicks` に達した | cooldownをセットして `undecided` の通常探索へ戻る |
| 放棄 `anchorMissing` | catalogからanchorが消えた | 失敗cooldown。通常探索 |
| 放棄 `anchorAtCapacity` | 到着tickの同時人数がcapacityを超えた | 失敗cooldown。通常探索。待たない |
| 放棄 `travelTimedOut` | `traveling` のまま `tick - startedAtTick + 1 > visit.maxTravelTicks` | 失敗cooldown。通常探索 |
| 放棄 `agentLeft` | `leaving` / `left` / `unassigned` になった | cooldownは置かない |

失敗cooldownはpurposeのkindだけへ `failedVisitCooldownTicks` を足す。成功時は同じkindへ
`revisitCooldownTicks` を足す。もう一方のkindのcooldownは変えない。

```text
cooldownUntilTick = tick + duration
新しい訪問を開始できるのは tick >= cooldownUntilTick のとき
```

完了のセットは V3(§8)で、そのtickのdecisionより後である。したがって補充と同じtickに次の訪問は
始まらない。次tick以降、もう一方のneedが閾値以上なら、そちらの台へ向かってよい。
同じ台への毎tick往復は、`needAfterRefill < visitThreshold` と成功cooldownが止める。

Pauseは `stepSimulation` を呼ばないので、phaseもneedも進まない。Resumeは同じstateの続きである。
Resetは初期stateを作り直す。

---

## 5. 飲食decisionと行動優先順位

### 5.1 純粋関数

```ts
export type VenueVisitDecisionAction =
  | "continueSocialActivity"
  | "continueExploration"
  | "startFoodVisit"
  | "startDrinkVisit"
  | "keepCurrentVisit";

export type VenueVisitDecisionReason =
  | "featureDisabled"
  | "notEligibleState"
  | "pendingSocialTransition"
  | "activeVenueVisit"
  | "minimumDwell"
  | "belowThreshold"
  | "revisitCooldown"
  | "noAnchor"
  | "anchorsAtCapacity"
  | "selectedFood"
  | "selectedDrink";

export type VenueVisitDecision = {
  action: VenueVisitDecisionAction;
  reason: VenueVisitDecisionReason;
  anchorId?: string;
  hunger: number;
  thirst: number;
  dwellTicks?: number;
  distance?: number;
};
```

`evaluateVenueVisitDecision` はagentの公開状態、need、catalog、そのtickのanchor占有数、
`minStayTicks`、`enabled` だけを読む。他agentのneed、未来のneed、Phase 4の接触網、表示文言は読まない。
rngは呼ばない。`isObserverJoiner` では分岐しない。`enabled` が false のときは、他の条件を見ずに
`featureDisabled` を返す。engineは無効時にこの関数を呼ばない。このreasonは純粋関数の単体テスト用である。

占有数は、そのanchorで `receiving` または `consuming` にある他agentの数である。
`traveling` は占有に数えない。decision時点で `occupancy >= capacity` のanchorは候補から外す。

### 5.2 1agent・1tickの優先順位

上から最初に一致した理由を採用する。

| 順 | 条件 | action | reason |
| --- | --- | --- | --- |
| 1 | `leaving` / `left` / `unassigned` | 開始しない。訪問があれば放棄 `agentLeft` | `notEligibleState` |
| 2 | `forming` / `approaching` | 開始しない | `notEligibleState` |
| 3 | `pendingClusterTransition` がある | 開始しない。社会的意図は消さない | `pendingSocialTransition` |
| 4 | 自分の `PendingVenueVisit` がある | 維持する。anchorを選び直さない | `activeVenueVisit` |
| 5 | `joined` かつ `tick - clusterJoinedAtTick < minStayTicks` | 会話を続ける | `minimumDwell` |
| 6 | 閾値以上のkindが無い | `joined` なら `continueSocialActivity`、それ以外は `continueExploration` | `belowThreshold` |
| 7 | 閾値以上のkindがすべてcooldown中 | 同じ | `revisitCooldown` |
| 8 | 閾値以上かつcooldown済みのkindすべてについて、catalogにanchorが1件も無い | 同じ | `noAnchor` |
| 9 | それらのkindのanchorは1件以上あるが、すべて `occupancy >= capacity` | 同じ | `anchorsAtCapacity` |
| 10 | `joined` または `undecided` で、空きanchorのあるkindが残る | `startFoodVisit` または `startDrinkVisit` | `selectedFood` または `selectedDrink` |

kindの選択:

```text
deficit(kind) = need(kind) - visitThreshold
閾値以上かつ空きanchorがあり、cooldownを過ぎたkindのうち deficit が最大のもの
同値なら drink を food より先にする
```

同じkindのanchorの選択:

```text
距離の昇順、同距離は anchor.id の昇順
```

距離はagentの現在座標とanchor中心のユークリッド距離である。

`forming` / `approaching` を切らないのは、そのtickまでに会話へ向かう移動が既に確定しているからである。
合流または接近失敗のあとのtickで、改めて §5.2 を評価する。

愛着(`attachment`)と離脱配慮(`departureConcern`)は、この表に出てこない。値が大きくても
`minimumDwell` を満たした飲食離脱を遅らせない。イベントへ観察値としてコピーするのは任意であり、
そのコピーは次tickの判定に使わない。#263 はhungerに `(1 - attachment)` を掛けてはならない。

### 5.3 同じtickの社会的離脱との関係

既存の step 5b(クラスタ離脱の `rng.chance`)を、飲食decisionより先に実行する。

- step 5b が `departAndExplore` または `switchToTargetCluster` を確定したagentは、そのtickでは
  もう `joined` ではない。`switchToTargetCluster` なら順3で飲食を開始しない。
  `departAndExplore` のあとneedが閾値以上なら、**同じtickの飲食decisionで訪問を開始してよい**。
  社会的な再探索の移動より、そのtickに確定した飲食目的を優先する。
- step 5b が `stay`、または確率0で離脱しなかったagentだけが、`joined` のまま順5以降へ進む。
- 飲食decisionは主系列RNGを消費しない。step 5b の `rng.chance` は、飲食機能のON/OFFにかかわらず
  同じagentに対して同じ位置で1回だけ引く。

確率をちょうど0にする決定的fixtureの作り方は §10.2 に書く。

---

## 6. 会話からの離脱、エピソード、接触、会場退出

### 6.1 メンバーシップの外し方

`startFoodVisit` / `startDrinkVisit` が `joined` に対して確定したとき、同じtickで次をまとめて行う。
既存の `departFromCluster` は呼ばない。あれは主系列RNGを消費し、中心から34px離れ、
`clusterDepartureCount` を増やし、社会的離脱の意味を持つ。

`releaseMemberForVenueVisit` が行うこと:

1. `episodeId` と `ticksInCluster` を退避する。
2. `detachMemberFromCandidate` で `memberIds` から外す。
3. `joinedGroupId`、`clusterJoinedAtTick`、`currentEpisode` を消す。
4. `state` を `undecided` にする。
5. `lastDepartedClusterId` と `lastDepartedClusterAtTick` を書く。
   既存の再合流cooldown(10tick)が効き、台へ歩き始める前に同じ輪へ戻らない。
6. `clusterDepartureCount` は増やさない。
7. 座標は動かさない。目的移動は §8.1 の step 6(`traveling` の分岐)が行う。
8. `PendingVenueVisit` を `phase: "traveling"`、`phaseEnteredAtTick = startedAtTick = tick` で作る。

`undecided` から始める場合は 1〜7 を行わず、8だけを行う。

残った人数が成立最小人数を割った場合、同じtickの既存step 9が他memberを
`clusterMemberReleased` (`episodeEndReason: "memberReleased"`、理由 `clusterBelowMinimumSize`)
で解放する。飲食で離れた本人をこの強制解放で二重に処理しない。本人は既にmemberではない。
クラスタが0人なら既存の `activeClusterDissolved` のままである。

### 6.2 エピソードと接触

飲食離脱の構造化理由は `venueRefreshmentBreak` である。
`ConversationEpisodeEndReason` と、分析側の `ConversationEpisodeEndReasonV2` の両方へ追加する。
既存の `venueExit` は会場退出のまま残す。

発生させるイベントは `venueVisitStarted` だけがエピソードを閉じる。
`clusterDepartureStarted` / `clusterDepartureCompleted` は出さない。

`venueVisitStarted` のmetadata(該当するものだけ):

| フィールド | 内容 |
| --- | --- |
| `agentId` / `agentLabel` | 離れたagent |
| `groupId` | 離脱元cluster。未所属からなら省略 |
| `episodeId` | 閉じるエピソード。未所属からなら省略 |
| `episodeEndReason` | `venueRefreshmentBreak` |
| `ticksInCluster` | 離脱時点の滞在 |
| `venueAnchorId` / `venueAnchorKind` / `venueVisitId` | 開始した訪問 |
| `refreshmentNeedHunger` / `refreshmentNeedThirst` | decision時点の増分後の値 |

#264 は `standingPartyAnalysis.ts` が `venueVisitStarted` かつ `episodeId` があるときに
`closeEpisode(..., endReason: "venueRefreshmentBreak")` するよう拡張する。
`voluntaryLeaveCount` と `forcedReleaseCount` は増やさない。
接触区間はmembership区間が閉じれば閉じる。追加の接触エッジは作らない。

同じ台に複数人が止まっていても、同じ `GroupCandidate` に入るまでは contact ではない。
距離による既存の `SpeechReception` は、これまでどおり届く範囲の発言を受信してよい。
それは接触でも内容発話の新規生成でもない。受信規則は変更しない。

内容発話はcluster membershipからしか生成しない。訪問中のagentはmemberではないので、
台の上で `ContentUtteranceEvent` を新たに作らない。

### 6.3 ログ文言

表示文言は事実だけを述べ、人格や評価を述べない。集計は `eventType` を使い、文言を解析しない。
移動の毎tickではログを出さない。タグは新しい `LogTag` `"venueVisit"` だけを使う。
`"leave"` と `"clusterDeparture"` は付けない。

| eventType | 文言の形 |
| --- | --- |
| `venueVisitStarted` | `${label}さんが料理を取りに移動を始めた` / `ドリンクを取りに移動を始めた` |
| `venueVisitArrived` | `${label}さんが料理台に着いた` / `ドリンク台に着いた` |
| `refreshmentObtained` | `${label}さんが料理を受け取った` / `ドリンクを受け取った` |
| `venueVisitCompleted` | `${label}さんが料理台を離れ、会場の回遊に戻った` / `ドリンク台を離れ、会場の回遊に戻った` |
| `venueVisitAbandoned` | `${label}さんが料理台への移動を中断した` / `ドリンク台への移動を中断した` |

放棄理由はmetadataの `venueVisitAbandonReason` に置き、文言へは埋め込まない。

### 6.4 会場退出stressを飲食移動で再判定しない

step 7 は、**そのtickの飲食phaseに入った時点で `PendingVenueVisit` を持っていたagent**
(そのtickの完了・放棄でレコードが消えたagentを含む)を、増分も `canLeave` もせずに飛ばす。

- 飛ばすのは評価だけである。`stress` を0に戻さない。`leaveThreshold` も変えない。
- 訪問が無い次のtickから、通常の `undecided` 増分と退出判定に戻る。
- 台を「歓迎するconfirmed group」の代わりに数えない。偽の `GroupCandidate` で増分を下げない。
- 長時間の `traveling` が `undecided` のまま stress を積み、受け取る前に `leaving` へ落ちる経路を、
  このスキップが断つ。

訪問開始前から `stress` が既に閾値を超えているagentは、訪問が終わった次tickで通常規則により
会場退出へ進み得る。これは会話からの社会的離脱のあとと同じ規則である。fixtureでは
`stress` を閾値未満にして、回遊再開が見えるようにする(§10.2)。

---

## 7. 移動、到着、取得、復帰

### 7.1 traveling

```text
delta = anchor.xy - agent.xy
distanceが0なら移動しない
そうでなければ step = normalize(delta) * visit.approachSpeed
position = clampToAgentWorld(position + step)
wall = 既存の computeAgentWallAvoidanceForce (既定の寄与上限 2)
合成後に hypot が approachSpeed を超えたら approachSpeed へ縮める
```

- roamingのheading更新もcrowdingも、このagentには適用しない。
- `approachSpeed` の既定は 10。`APPROACH_SPEED`(14)以下、かつ全anchorの `interactionRadius` 以下。
- Phase 6 の `maxAgentSpeed`(roaming合成の上限、既定5)は飲食の直進には適用しない。
  会場を横切る移動が数百tickに埋もれないようにするためである。
- 目的地のanchor idは毎tickの再抽選で変えない。

### 7.2 到着とcapacity

移動のあと(§8.1 step 6)、まだ `traveling` で `distance(agent, anchor) <= interactionRadius` なら到着候補にする。
同じtickに同じanchorへ着いた候補は `agent.id` の昇順で空きを埋める。

```text
occupancy = そのanchorで既に receiving または consuming の人数
slots = capacity - occupancy
候補を id 昇順で slots 人まで receiving にする
残りは venueVisitAbandoned / anchorAtCapacity
```

到着できたagentは `phase = "receiving"`、`phaseEnteredAtTick = tick` とし、`venueVisitArrived` を
1件出す。そのtickの経過は1である。着地座標からさらに滑らせない。

`traveling` のまま `elapsedTicks > maxTravelTicks` なら、到着判定のあとでもまだ `traveling` の場合に
`travelTimedOut` で放棄する。そのtickに円へ入ったなら到着を優先する。

### 7.3 receiving と consuming

`receiving` / `consuming` は速度を0にする。wall avoidanceもcrowdingも足さない。
円の外へ押し出さない。

| 遷移 | 条件 | 副作用 |
| --- | --- | --- |
| `receiving` → `consuming` | 経過がanchorの `serviceTicks` 以上 | 対応するneedを `needAfterRefill` にする。`refreshmentObtained` を1件 |
| `consuming` → 消去 | 経過が `visit.consumeTicks` 以上 | 成功cooldown。`venueVisitCompleted` を1件。`state` は `undecided` のまま |

`serviceTicks` はanchor側、`consumeTicks` はconfig側(既定3)である。MVPの両台は `serviceTicks = 4`。

取得のあと元のclusterへ引き戻す力は無い。次tickからPhase 6のroamingと、通常の候補選択
(または `spatialDynamics` が無効なら従来の最寄り探索)に戻る。

### 7.4 失敗時

放棄したtickで訪問を消し、`state` が `leaving` / `left` / `unassigned` でなければ `undecided` の
通常規則へ戻す。座標は放棄のためにジャンプさせない。

同じtickに、放棄したagentを再度 `startFoodVisit` しない。decisionはV3より前だからである。
失敗cooldownが次tickの即時再出発を止める。

### 7.5 ステーション付近の会話(#265 への境界)

#264 は会話を自動生成しない。次も本契約で固定する。

- `receiving` / `consuming` のあいだは核形成も接近もしない。サービスを会話参加が中断しない。
- 近接だけでは contact も `ContentUtteranceEvent` も作らない。
- 再形成は、訪問レコードが消えたあとに、既存の `GroupCandidate` 生成・合流と既存の発言経路で行う。
- その追加は `venueAnchors.encounterEnabled` が true のときだけである。訪問自体が有効でも、
  既定は `encounterEnabled: false` である。#264 の移動テストは形成規則を変えない。
- #265 が有効化するとき、新しい接触ネットワーク実装は作らない。
- 同時に円内へ入ったagentが同一座標へ重なるのは、#264 では許容する。重なりはclusterではない。
  決定的な立ち位置のずらし(agent idから半径18以内のオフセット)は #265 が加える。
- #265 がclusterを新規に作る場合、中心は対象anchorの中心から
  `interactionRadius + encounter.clusterClearance`(既定20)以上離す。台の円の中へ輪を置かない。
- 機会の窓は、同じanchorで訪問を完了したtickから `encounter.windowTicks`(既定8)以内、
  相互距離 `encounter.radius`(既定48)以内に限る。窓の外では通常の探索だけが働く。

---

## 8. tick更新順序と乱数

### 8.1 1tickの順序

Phase 6の S1〜S4 と既存step番号は維持する。飲食は step 5b と step 6 のあいだから、step 6 の
対象者を除く形で入る。

```text
 0.  前tickのコピー / activeSpeechEffects の減衰 / 介入 beforeTick(既存)
 S1–S4. Phase 6 の cluster 座標更新と joined member 追従(既存)
       飲食runtimeを読まない。訪問中のagentは joined ではないので追従されない
 1.  核形成。pendingClusterTransition または PendingVenueVisit がある agent はスキップ
 1b. 軽い声かけ。PendingVenueVisit がある agent は対象にしない
 2.  接近判定。訪問中はスキップ。pendingClusterTransition は従来どおり最優先
 3.  approaching の移動と join(既存)。訪問中の agent は approaching ではない
 4.  forming の中心微調整(既存)
 5.  joined の wander と episode 更新(既存)
 5b. 社会的離脱判定(既存、主系列 rng.chance はここだけ)
 V0. [有効時] need増分
 V1. [有効時] §5.2 のdecision。開始するなら releaseMemberForVenueVisit
       この段では座標を動かさない
 6.  undecided の移動
       訪問 phase が traveling なら §7.1
       receiving / consuming なら速度 0
       それ以外は Phase 6 roaming、または無効時の従来ランダムwalk
 V3. [有効時] 到着・capacity・TTL・receiving/consuming の遷移・補充・完了・放棄
 7.  stress。tick開始時に訪問があった agent はスキップ(§6.4)
 8.  leaving の退場(既存)。訪問が残っていれば agentLeft で放棄
 9.  cluster の縮小・解散・期限(既存)
 T/U. 発言・内容発話・伝播(既存)。訪問中は cluster 発話の話者にしない
```

V0の「tick開始時に訪問があった」集合を、V3でレコードが消える前に控える。step 7 はその集合を見る。

crowdingの入力スナップショットは、従来どおり step 6 の直前の座標で固定する。
飲食で先に動いたagentの新座標を、同じtickの他agentの密度へ反映しない。

同一tickの因果は一方向である。このtickの `refreshmentObtained` は、このtickの step 5b や
V1 のdecisionへ遡らない。次tickの V0 以降が補充後のneedを見る。

### 8.2 描画は駆動しない

Canvasのヒットテスト、ラベル位置、アイコンの有無、Inspectorの開閉は、座標・phase・need・
PRNGを変えない。anchorの当たり判定の正本は `interactionRadius` と中心座標である。
SVGの描画順のために第二の座標を持たない。

### 8.3 RNG

| 処理 | 主系列 `SeededRandom` | 派生stream |
| --- | --- | --- |
| need初期化 | 消費しない | agentごとに4回だけ(§3.2) |
| need増分、decision、anchor選択、capacity順 | 消費しない | 消費しない |
| 飲食の直進・停止・補充 | 消費しない | 消費しない |
| 訪問中の roaming heading | 呼ばない | 呼ばない(tickがキーに入るので、他agentの列はずれない) |
| step 5b の社会的離脱 | 既存の1回を維持 | 使わない |
| `enabled: false` | Phase 6 と同一列 | 派生stream自体を作らない |

有効なrunでは、座標と「誰が `undecided` のwander抽選を通るか」が変わるため、主系列の列は
Phase 6 の有効runと一致しなくてよい。一致を取りに、捨てるためのダミー `rng.range` を
挿入してはならない。byte-identical を要求するのは `enabled: false` のときだけである。

---

## 9. feature flag、非介入、不変条件

### 9.1 config

`StandingPartyScenarioConfig` にだけ足す。`SimParams` には足さない。

```ts
export type VenueAnchorConfig = {
  enabled: boolean;            // 既定 false。false なら anchors も encounter も読まない
  encounterEnabled: boolean;   // 既定 false。#265 が true にするまで形成へ影響しない
  anchors: VenueAnchor[];
  needs: {
    initialMin: number;        // 0.05
    initialMax: number;        // 0.35
    rateMin: number;           // 0.85
    rateMax: number;           // 1.15
    hungerGainPerTick: number; // 0.0032
    thirstGainPerTick: number; // 0.004
    visitThreshold: number;    // 0.70
    needAfterRefill: number;   // 0.15
  };
  visit: {
    approachSpeed: number;             // 10
    consumeTicks: number;              // 3
    revisitCooldownTicks: number;      // 55
    failedVisitCooldownTicks: number;  // 12
    maxTravelTicks: number;            // 100
  };
  encounter: {
    windowTicks: number;       // 8
    radius: number;            // 48
    clusterClearance: number;  // 20
  };
};

export const DEFAULT_VENUE_ANCHOR_CONFIG: VenueAnchorConfig = {
  enabled: false,
  encounterEnabled: false,
  anchors: [],
  needs: {
    initialMin: 0.05,
    initialMax: 0.35,
    rateMin: 0.85,
    rateMax: 1.15,
    hungerGainPerTick: 0.0032,
    thirstGainPerTick: 0.004,
    visitThreshold: 0.7,
    needAfterRefill: 0.15,
  },
  visit: {
    approachSpeed: 10,
    consumeTicks: 3,
    revisitCooldownTicks: 55,
    failedVisitCooldownTicks: 12,
    maxTravelTicks: 100,
  },
  encounter: { windowTicks: 8, radius: 48, clusterClearance: 20 },
};
```

追加の検証:

| フィールド | 範囲 |
| --- | --- |
| `initialMin` / `initialMax` | `[0, 1]` かつ `initialMin < initialMax` |
| `rateMin` / `rateMax` | `> 0` かつ `rateMin < rateMax` |
| gain 2つ | `>= 0` かつ finite |
| `visitThreshold` | `(0, 1]` |
| `needAfterRefill` | `[0, 1)` かつ `< visitThreshold` |
| `approachSpeed` | `> 0` かつ `<= 14` |
| tick数4つ(`consume` / 両cooldown / `maxTravel`) | 1以上の整数。`failedVisitCooldownTicks` は 0 を許す |
| `encounter.windowTicks` | 0以上の整数 |
| `encounter.radius` / `clusterClearance` | `>= 0` |

`enabled: false` の実行経路は、検証が通ったあとにすぐ戻る。anchor配列もneedもeventも作らない。
既存presetの既定オブジェクトは `DEFAULT_VENUE_ANCHOR_CONFIG` のままとする。
Phase 6 の比較presetも `enabled: false` のまま残す。

### 9.2 ゲート

```text
venueAnchorsActive =
  formationPolicy.id === "standingParty"
  && standingPartyConfig.venueAnchors.enabled
```

`afterParty` と `classroomPair` では、この条件の評価以外を実行しない。
`encounterEnabled` は `venueAnchorsActive` が true のときだけ追加効果を持つ。

### 9.3 不変条件

#264 が `assertStandingPartyInvariants` へ足す。

| # | 条件 |
| --- | --- |
| VA-1 | 同一agentが `PendingVenueVisit` と `pendingClusterTransition` を同時に持たない |
| VA-2 | 訪問中は `undecided` で、`joinedGroupId` と `currentEpisode` が無い |
| VA-3 | `receiving` / `consuming` のagentは対象anchorから `interactionRadius + 0.5` 以内にいる |
| VA-4 | 1訪問の長さは `maxTravelTicks + serviceTicks + consumeTicks` を超えない |
| VA-5 | catalogのidは一意で、座標はfiniteかつ §2.2 の範囲内 |
| VA-6 | hunger / thirst は `[0, 1]` のfinite |
| VA-7 | 1つの `visitId` につき `refreshmentObtained` は1件まで |
| VA-8 | `enabled: false` のstateに `venueRuntimeState` も飲食eventも無い |
| VA-9 | 飲食eventのtickで、同じagentの `clusterDepartureStarted` は同時に存在しない |

### 9.4 分析スキーマ

#264 は `STANDING_PARTY_ANALYSIS_SCHEMA_VERSION`(当時 1)を上げない。
終了理由の追加と、未知のeventを無視していた経路で `venueVisitStarted` を閉じる変更だけを行う。
訪問回数などの新しい集計列をJSON/CSVへ足すのは #266 であり、そのとき version を 2 にする。
#266 では分析スキーマを 2、export bundle を `standing-party-analysis-export/4`、
飲食集計を `venue-visit-analysis/1` にした。

---

## 10. 代表シナリオ

### 10.1 普通の実行で見えること

#266 の比較preset(名前はこの契約で固定する):

| preset id | 表示名の意図 | config |
| --- | --- | --- |
| `standing-party-venue-refreshment` | 飲食で会場を回遊する | Phase 6 の空間回遊presetと同じ社会・空間設定に、`enabled: true`、`encounterEnabled: true`(#265完了後)、`anchors: MVP_VENUE_ANCHORS`、§9.1 の既定need |
| `standing-party-venue-off-baseline` | 飲食なしの比較 | 上と同一で `enabled: false` だけが違う。`encounterEnabled` は true のまま残し、無効時は実行しない |

#266 は立食パーティーの初期選択を `standing-party-venue-refreshment` へ移した。
古いpreset id(`standing-party` と Phase 6 の比較presetを含む)は残し、それらの飲食は無効のままである。
`enabled: false` に切り替えた実行は、飲食presetと同じseedでも Phase 6 の座標・event・主系列PRNGと
一致する。これが #267 の互換テストの期待値である。

数百tickの有効runでは、初期thirstが高い複数agentがドリンク台へ向かい、料理台へ向かうagentも現れ、
受け取ったあとに輪へ戻る様子がCanvasで区別できる。台への集合だけでconfirmed clusterが
ゼロになることは、成功条件に含めない。会話の維持は Phase 1〜6 の既存規則が担う。

### 10.2 座標まで固定する単体シナリオ

エンジンテストは次の初期stateを直接作る。人口1、空間力学は off(cluster追従で起点がずれない)、
社会的離脱の確率は0である。

| 項目 | 値 |
| --- | --- |
| 開始時 `state.tick` | 15(最初のstepのtickは16) |
| agent | `agent-a`、`joined`、座標 `(400, 260)` |
| cluster | confirmed、中心 `(400, 260)`、memberは `agent-a` だけ、`clusterJoinedAtTick = 0` |
| `minStayTicks` | 15。tick 16 の滞在は 16 で、最低滞在は満たす |
| 満足度 | 1 |
| `socialCirculationTendency` | 0 |
| 離脱確率 | 不満寄与も回遊寄与も0。`rng.chance(0)` は false で、社会的離脱は起きない |
| need(step前) | hunger `0.20`、thirst `0.70`、両rate `1`、cooldown無し |
| stress / leaveThreshold | `0.10` / `0.80` |
| anchors | §2.3 の2件 |
| spatialDynamics | `enabled: false` |

tick 16 の増分後も thirst は `0.704` で閾値以上、hunger は `0.2032` で閾値未満である。
二台は `(400, 260)` から同距離 `sqrt(147584) ≈ 384.1666` だが、kind選択は距離ではなくneedなので
ドリンク台が選ばれる。

同じtick 16:

- memberから外れ、エピソードは `venueRefreshmentBreak`
- `clusterDepartureStarted` は無い。`clusterDepartureCount` は増えない
- `lastDepartedClusterId` はセットされる
- `PendingVenueVisit.phase = "traveling"`、anchorは `anchor:drink-main`
- `venueVisitStarted` が1件
- 離脱の時点の座標は `(400, 260)` のままである。同じtickの step 6 で最初の直進が始まる
- stressは増えない
- 唯一のmemberが先に外れているので、step 9は空になったclusterを既存の
  `activeClusterDissolved` で消す。本人に `clusterMemberReleased` は出ない。
  fixtureは `everConfirmed: true` のconfirmed clusterとして作る

直進は毎tick、長さ10で `(728, 60)` へ向かう。36回目の移動で距離 `24.1666 <= 28` になる。
開始tickが16なので、到着tickは `16 + 35 = 51`。到着座標はおよそ `(707.37, 72.58)`。

| tick | 出来事 |
| --- | --- |
| 51 | 到着。`receiving` 開始。`venueVisitArrived`。経過1 |
| 52–53 | 停止したまま。経過2、3 |
| 54 | 経過4。thirstを `0.15` にする。hungerは増分だけ。`refreshmentObtained`。`consuming` 開始 |
| 55 | `consuming` 経過2。停止 |
| 56 | 経過3。訪問を消す。drinkの `cooldownUntilTick = 111`。`venueVisitCompleted`。stressはこのtickもスキップ |
| 57 | 通常の `undecided`。roamingまたは最寄り探索が再開。stress増分が再開。元の輪への強制帰還は無い |

hungerが閾値未満なので、tick 57 に料理台へは向かわない。thirstは 0.15 から再上昇し、
tick 111 より前にはドリンク台へ再出発しない。

このシナリオを空間力学 on で再実行するテストは、到着座標の一致ではなく、
「roamingが目的地を奪わない」「`venueVisitCompleted` が1件」「完了後に `undecided`」を見る。

### 10.3 失敗の決定的ケース

| ケース | 期待 |
| --- | --- |
| catalogが空、またはそのkindが無い | 開始しない。reason `noAnchor` |
| 到着時、先に `receiving` が capacity に達している | id順で溢れたagentだけ `anchorAtCapacity`。待機phaseは残らない |
| `maxTravelTicks` を 5 に下げたfixture | 到着前に `travelTimedOut`。座標は世界内 |
| 同じtickに社会的 `switchToTargetCluster` が確定 | 飲食訪問はできず、`pendingClusterTransition` が残る |
| `enabled: false` | 上のfixtureでも座標・event・主系列の乱数列が、飲食コードを足す前と一致する |

---

## 11. 後続Issueへの割り当て

追加の設計判断を各Issueへ残さない。実装時に本契約と違う挙動が必要なら、先にこの文書を更新する。

| Issue | 実装してよいこと | この契約で既に決まっていて、再設計しないこと |
| --- | --- | --- |
| #262 | `venueAnchors.ts` の型・検証・`MVP_VENUE_ANCHORS`、configへの格納、Canvas表示 | 座標、半径、ラベル、無効時は描かない、simulation非干渉、他scenarioへ出さない |
| #263 | `refreshmentNeeds.ts` と `venueVisitDecision.ts`。need更新とdecisionの記録まで。メンバーシップは外さない | 増分式、初期化の4抽選、§5.2 の優先順位、愛着は掛けない、rngをdecisionに使わない |
| #264 | `venueVisitRuntime.ts`、engineの V0〜V3、エピソード閉じ、イベント、VA不変条件 | `departFromCluster` を使わない、phase寿命、capacity放棄、stressスキップ、主系列へダミー抽選を足さない |
| #265 | `venueEncounter.ts`。`encounterEnabled` のときだけ既存のcluster形成へ接続 | 近接をcontactにしない、サービス中は合流しない、台の円内にcluster中心を置かない |
| #266 | §10.1 の2 preset、Canvas上の移動/受け取り表示、Inspector、イベント文言、集計とexport schema 2 | 表示のON/OFFがruntimeを変えない、毎tickの移動ログを出さない、既存presetを消さない |
| #267 | §10.2 のfixture、失敗ケース、1000tickのVA、Playwright、検証メモ | 座標の画素一致をE2Eに要求しない。構造化eventとphaseで断言する。現実データとの較正はしない |

#262 の時点では、有効なconfigをテストと定数として持てばよい。アプリの初期presetはまだ切り替えない。
「standingPartyで二台が常時識別できる」は、`enabled: true` のときCanvasに両方が残ることである。
無効時に装飾として残す描画は採用しない。Phase 6 の画面と一致させる。

Inspectorが読むのは `venueRuntimeState` のneed、最後のdecision、訪問phaseである。
コンポーネントが閾値式を複製しない。

---

## 12. 受入条件との対応

| Issue #261 の受入条件 | 該当 |
| --- | --- |
| anchor・need・visit・離脱理由・優先順位・tick順が文書化されている | §2〜§8 |
| anchorは会話clusterと別で、接近だけでは接触を作らない | §1.2、§2.1、§6.2、§7.5 |
| 離脱 → 台へ移動 → 一定tick滞在 → 取得 → 回遊再開が定義されている | §4、§7、§10.2 |
| 無効時のPhase 6互換、afterParty / classroomの非介入、安定seed、UI非介入 | §8.2、§8.3、§9 |
| 設計のみで既存挙動を変えない | 変更は本契約、Phase 6契約からの参照、READMEの案内だけである |

本Issueでは `src/simulation` と `src/components` を変更しない。

---

## 13. Issue #265 ステーション付近の再形成

§7.5 の境界を、次の操作に固定する。`encounterEnabled === false` のあいだは、この節の関数を呼ばない。
位置・cluster中心・crowding・event・主系列PRNGは #264 のままである。

1. **滞在位置**。`receiving` / `consuming` のagentを、anchor中心から半径18以内の決定的オフセット
   （`venueStayOffset(agentId)`）へ置く。同じidは常に同じ位置で、interaction radius の外には出さない。
   traveling と、訪問が無いagentは動かさない。
2. **機会**。`evaluateEncounterOpportunity` は二人の距離、phase、topicの一致、同cliqueの
   `existingTieStrength`、initiative、willingness / conformity / influenceAvoidance から score を決める。
   rngは使わない。`isObserverJoiner` は式に入れない。scoreが `0.45` 未満なら理由は
   `belowSocialThreshold` で、近くにいても輪を作らない。
3. **サービス中**。phaseが `beforeObtain` または `afterObtain` のあいだは理由 `serviceInProgress`。
   状態は `undecided` のまま、forming cluster へ移さない。
4. **訪問完了後**。同じanchorの完了tickから `windowTicks` 以内、相互距離が `radius` 以内、
   両方が `undecided` で社会的移動意図が無いときだけ `postVisitGreeting`。
   台の円の外に既存の参加可能な輪があり、開始者から `candidateMergeRadius` 以内なら、その輪へ
   既存の approaching として向かう。無ければ新しい `GroupCandidate` を、中心が
   `interactionRadius + clusterClearance` 以上離れた位置に作る。開始者は forming、相手は approaching。
   発言は既存の `initiativeFormedCore` と、状態遷移から導出する `approachWelcome` / `joinGreeting`。
5. **接触と内容発話**。Phase 4 の contact は、その後の正式な membership 区間からのみ導出する。
   Phase 5 の内容発話は、これまでどおり confirmed cluster の membership からのみ導出する。
   機会自体は `venueEncounterOpportunity` / `venueEncounterFormed` に残し、表示文言は解析しない。
6. **台への定着を避ける**。形成中・成立中のcluster中心がクリアランス円の中にあれば、1tickあたり
   最大4だけ外へずらす。`encounterEnabled` のときだけ、crowding の密度sourceにanchor中心を足す。
   物理衝突は作らない。
