# 他クラスタ関心・現在クラスタ愛着・ObserverJoiner葛藤のドメイン契約 (Issue #197, Phase 3 設計)

Parent Roadmap: #172。Depends on: #185(会話満足度ADR), #186, #187, #188, #189, #190。
Blocks: #198(他クラスタ関心), #199(愛着・離脱配慮), #200(遷移decision), #201(目的地付き移動),
#202(UI/Inspector), #203(検証・E2E)。

この文書は、立食パーティー(`standingParty`)の会話クラスタ離脱を、Phase 2の
「現在クラスタ内部の状態だけを見る自発的離脱」(`clusterDepartureDecision.ts`)から、
「周囲の別クラスタへの関心・現在の輪への愛着・自分が離れることへの配慮を合成した
**クラスタ遷移decision**」へ拡張するための**ドメイン契約(ADR)**である。
**本Issueでは実装しない**(既存コードの挙動・PRNG消費順序は一切変更しない)。
後続Issue(#198〜#203)が追加の設計判断なしに実装へ着手できるよう、新規概念の意味・寿命・
既存概念との境界・tick更新順序・decision型案・観察可能情報の制限・パラメータ方針・
構造化イベント・移行手順を残す。

判断基準の軸は、これまでのADRが確立した3つの拡張パターンをそのまま延長する:

1. **シナリオ固有ルールは`engine.ts`へ分岐を書かず、`FormationPolicy`実装へ委譲する**
   (Issue #130、[formation-policy-model.md](formation-policy-model.md))。
2. **新しい状態は現状態(`joinedGroupId`/`memberIds`)を汚さず、生成専用ログ・スナップショットとして
   別に持つ**(Issue #173、[interaction-cluster-model.md](interaction-cluster-model.md) 3.3節7)。
3. **このtickで生じた変化は次tickのスナップショットから見える**
   (Issue #185、[conversation-satisfaction-model.md](conversation-satisfaction-model.md) 3.3節、
   および`speechEffects.ts`の`advanceActiveSpeechEffects`)。

---

## 0. 拡張対象の現状(Phase 2 で確定済みの土台)

`standingPartyPolicy.evaluateClusterDeparture`(責務9)は現在、`clusterDepartureDecision.ts`の
純粋関数で「不満由来」「回遊由来」の2寄与を独立hazardとして合成し、`{ eligible, probability,
factors, primaryReason }`を返す。`engine.ts`の step 5b がその`probability`へ`rng.chance`を
**1回だけ**引き、成立したら`departFromCluster`でmembershipを更新して構造化イベント
(`clusterDepartureStarted` / `clusterDepartureCompleted` / `clusterResearchStarted`)を記録する。

離脱後のagentは`undecided`へ戻り、次tick以降の step 2 で`nearestCandidate`
(= **join可能な候補のうち距離が最も近いもの**、離脱直後のクラスタは`CLUSTER_REJOIN_COOLDOWN_TICKS`の
間だけ除外)を選び直す。**「どこへ向かうか」を決める情報は距離しか存在しない。**

このため、他クラスタへの興味だけを離脱確率へ足すと、issueが指摘する
**「別の人と話したいため離れたのに、無関係な近い輪へ向かう」という意味の不整合**が起きる。
Phase 3は、この「離れる理由」と「向かう先」を1つのdecisionとして接続する。

`ClusterDepartureContext`/`ClusterDepartureDecision`(`formationPolicy.ts`)、
`ConversationEpisode`(`types.ts`)、`StandingPartyScenarioConfig`(`standingPartyScenarioConfig.ts`)は
Phase 2で既に「standingParty専用の設定・状態を`SimParams`へ混ぜずに差し替える」器として整備済みであり、
Phase 3はこの器を**拡張する**(新しい器を作らない)。

---

## 1. 新規概念の定義

### 1.1 他クラスタ関心 (AlternativeClusterInterest)

- **意味**: 「今この瞬間に観察できる**別の**会話クラスタのうち、そこへ移りたいと感じる度合い」。
  有限範囲 `[0, 1]`。
- **性質**: agentの恒久的traitでも、tickをまたいで蓄積する状態でもない。
  **そのtickに観察できる周囲の状態から毎tick導出し直す、一時的な評価結果**である。
  「Aさんが好き」のような**永続的な選好は持たない**(1.1.2)。
- **配置**: `SimulationState`にも`Agent`にも**保存しない**。step 5a3(3.1節)で導出し、
  同一tickの遷移decisionへ渡してその場で捨てる。
  `switchToTargetCluster`が確定した場合に限り、`score`と`focusAgentId`だけを
  `PendingClusterTransition`(1.5節)へスナップショットとして写す。
  - 根拠: 保存すると「前tickの関心が今tickのdecisionを歪める」暗黙の履歴依存が生まれ、
    #203が要求する「同一入力から同一結果」「入力をmutationしない」が検証しにくくなる。
    Inspector表示は同じ純粋関数を同じ入力で再計算すれば復元できる
    (Phase 2の`ClusterDepartureDecision`と同じ扱い)。

#### 1.1.1 `focusAgentId`(関心を主に駆動したmember)の意味

「そのクラスタへの関心を最も強く押し上げた同席者1名」の**記録**であり、
「その人に会う予約」でも「その人への好意」でもない。用途は次の2つに限定する:

1. 構造化イベント・Inspectorで「なぜそのクラスタを選んだのか」を説明すること。
2. target無効化判定(3.3節)で、`focusAgentId`がtargetから離脱した場合に
   意図を破棄して通常探索へfallbackさせること
   ―― **これが「別の人と話したいため離れたのに無関係な輪へ向かう」不整合を防ぐ本体の仕組み**。

`focusAgentId`が存在しない関心(距離・入りやすさだけで選ばれた場合)は`undefined`とし、
その場合は「特定の相手が理由ではない移動」として扱う(無効化判定でも`focusAgentLeft`は起きない)。

#### 1.1.2 特定人物への選好をどこまで表現するか(決定事項)

**Phase 3では、任意の人物間好悪行列(agent × agent の選好テーブル)を新設しない。**
`focusAgentId`の選定は、**既存の関係情報の範囲**に限定する:

- `Agent.cliqueId`(同じ既存友人グループに属するか)と`SimParams.existingTieStrength`
- Phase 4の`relationshipTie.ts`が既に蓄積している(observer→speaker)ペア単位の整合性履歴由来補正
  ―― **存在する場合のみ**参照し、未設定・無効時は常に0として扱う(NaNを生じさせない)

理由: 好悪行列を新設すると、(a) `population`規模に対して O(n²) の状態が増え、
(b) 「誰が誰を好きか」という**個人評価に読めるデータ**を持つことになり、
CLAUDE.mdおよび#185 ADR 7節が明記する「人格診断・個人評価ではない」という立場と衝突する。
恋愛関係・親密度の詳細モデルは本Issueおよびフェーズの**対象外**であり、
必要になった時点で独立に検討する。

#### 1.1.3 決定的なtie-break

関心scoreは浮動小数のため同点があり得る。**rngを使わず**、次の順で決定的に解決する:

1. `score`の降順
2. `targetClusterId`の昇順(文字列比較)
3. (`focusAgentId`の選定内で同点の場合)`agentId`の昇順

候補配列の並び順を変えてもbest targetが変わらないこと(安定選択)は#203の受入条件であり、
`schoolInterventionRuntime.ts`の`stableSortById`が確立した「rng不要の決定的選択」と同じ方針である。

### 1.2 現在クラスタ愛着 (CurrentClusterAttachment)

- **意味**: 「今の会話エピソードから**離れにくい**度合い」。有限範囲 `[0, 1]`。
- **会話満足度との違い(この分離が本節の主題)**:

  | | 会話満足度 (`conversationSatisfaction`) | 現在クラスタ愛着 (`attachment`) |
  | --- | --- | --- |
  | 問い | 今の会話を**どう評価**しているか | 今の会話エピソードから**離れにくい**か |
  | 向き | 低いほど**離脱圧力**を生む(駆動側) | 高いほど**離脱を抑制**する(抑制側) |
  | 時間変化 | 新鮮さ逓減で下がり、新規member参加で回復し**上下する** | 滞在とともに飽和曲線で**単調に増え**、member入れ替わりでのみ減る |
  | 独立性 | 満足度が低くても愛着は高くなり得る(長く一緒にいた相手を残して移るのをためらう) | 愛着が弱ければ満足度が高くても他クラスタ関心に応じて動きやすい |

- **性質・寿命**: **joinごとに初期化し、episode終了時に破棄するruntime state**。
- **配置**: `ConversationEpisode.attachment?: CurrentClusterAttachmentState`
  (`Agent.currentEpisode`の中にネストする)。
  - 根拠: `ConversationEpisode`は既に「1回のjoin〜離脱の区間」を表す器であり、
    `departFromCluster` / `releaseMemberFromDissolvingCluster` / 所属先喪失(`membershipLost`)の
    **3つの終了経路すべてで`agent.currentEpisode = undefined`によって一括クリアされる**。
    ここへネストすれば、「同じclusterへ再参加した場合に前episodeの愛着を継承しない」という
    要件が**新しいクリア処理を1行も書かずに構造的に保証される**
    (`episodeId`は`${agentId}:${clusterId}:${joinedAtTick}`で毎回異なる、#186)。
    `Agent`直下の独立フィールドにすると3経路すべてでのクリア漏れが回帰リスクになる。
- **入力**: 現在エピソードそのものの性質に限る。
  1. 滞在tick(長くいるほど飽和値へ向けて単調増加)
  2. 同席memberの構成の安定(join時から継続しているmemberの比率が下がると愛着が減る)
  3. 新規member参加による希釈(「知らない人が増えると、この輪への愛着は少し薄まる」。
     満足度側では新鮮さ**回復**として正に効く同じ事象が、愛着側では負に効く
     ―― これが2つの概念が別物であることの具体例になる)
- **入力に含めないもの**: 他agentの満足度・愛着、過去エピソードの記憶、
  特定人物との長期的な接触回数。**長期的な接触記憶・人間関係の強化はPhase 4以降**へ残す。

### 1.3 離脱配慮・構造的影響 (DepartureConcern)

- **意味**: 「自分が今ここを離れることが**場に与える影響**への配慮」。有限範囲 `[0, 1]`。
- **性質・寿命**: 愛着と異なり**保存しない**。そのtickのcluster状態から毎tick導出する
  (1.1と同じ「一時的な評価」)。
- **評価する構造的影響**:

  | factor kind | 意味 | 判定 |
  | --- | --- | --- |
  | `clusterWouldDissolve` | 自分が抜けるとmember数が成立最小人数を割り、clusterが解散する | `memberIds.length - 1 < capacity.minGroupSize` |
  | `recentMemberJoined` | 直前に別memberが参加した／会話が形成されたばかり | 直近`recentMemberJoinedWindowTicks`以内に`memberIds`が増加した、または`joinedAtTick`が同ウィンドウ内 |
  | `episodeAttachment` | 1.2節の愛着そのものの寄与分 | `attachment.value * attachmentInhibitionWeight` |
  | `influenceAvoidance` | 自分が場を動かすことへの抵抗(既存trait) | 下記1.3.1 |

  「残存memberが強制releaseされる」は`clusterWouldDissolve`の**帰結**であり、独立factorにしない
  (責務10の`evaluatePostConfirmationLifecycle`が`minGroupSize`割れを唯一の解散条件としているため、
  1つの判定で両方を表現できる。別factorにすると同じ事象を二重計上する)。

#### 1.3.1 `influenceAvoidance`の再利用範囲(決定事項)

**`influenceAvoidance`は、構造的影響factorへの乗算係数としてのみ使う。単独では寄与0とする。**

```
concern = (clusterWouldDissolveContribution + recentMemberJoinedContribution)
          * (1 + influenceAvoidance * influenceAvoidanceGain)
        + episodeAttachmentContribution
```

- **なぜ乗算係数か**: `influenceAvoidance`は「**自分の行動が場を動かすこと**への抵抗」という意味の
  安定traitである。動かす対象(=構造的影響)が存在しない場面――抜けても誰も困らない大人数の輪――で
  離脱を抑制するのは、この語の意味からの逸脱であり、
  「influenceAvoidanceが高い人はただ動かない人」という**別traitへの退化**になる。
  乗算係数にすれば「影響があるときにだけ強く効き、影響がないときは0」という意味が保たれる。
- **`attractiveness()`との二重計上について**: `influenceAvoidance`は既に
  `engine.ts`の`attractiveness()`で`1 - influenceAvoidance * ...`として接近確率へ効いている。
  ただしそれは**`undecided`agentが輪へ入る**遷移の判定であり、本節は
  **`joined`agentが輪から出る**遷移の判定である。**同一のdecisionで2度読まれることはない**ため
  二重計上にならない。この境界(入る側 / 出る側)は実装Issueのコメントに明記すること。
- **`isObserverJoiner`による固定値付与は行わない**(1.4節)。

### 1.4 ObserverJoinerの葛藤の表現方針(決定事項)

**`isObserverJoiner`は、関心・愛着・配慮・遷移decisionの
いかなる式にも入力として渡さない。**これは#187が会話満足度で確立した方針
(「`isObserverJoiner`はこの関数のいかなる入力にも現れない」)の延長である。

葛藤は、**特別なシナリオ文言でも boolean 分岐でもなく、2つの連続値が同時に大きい状態**として定義する:

```ts
/** 表示・比較・検証のための派生値。decisionの式へは入力しない(1.4.1) */
conflictIntensity = Math.min(interestDrive, inhibition)   // [0, 1]
```

- `interestDrive` = 他クラスタ関心が生む離脱方向の駆動(4.1節)
- `inhibition` = 愛着 + 離脱配慮が生む抑制(4.1節)
- 片方が0なら0。両方が大きいときだけ大きい ―― これが「動きたいのに、自分が動くと場が壊れる」
  という葛藤の意味そのものになる。

observerJoinerが葛藤を示しやすいのは、`model.ts`が`observerInfluenceAvoidance`として
**高い`influenceAvoidance`を割り当てている既存の生成規則の帰結**であって、型や分岐による特別扱いではない。
逆に、observerJoinerでなくても`influenceAvoidance`が高ければ同じ葛藤が生じる
―― これが「人格類型を固定的に決めつけるモデルにしない」という要件の具体的な担保になる。

#### 1.4.1 なぜ`conflictIntensity`をdecisionの式へ入れないか

`interestDrive`と`inhibition`は既にそれぞれ独立してdecisionへ効いている(4.1節)。
そこへ両者の合成である`conflictIntensity`を第3の項として足すと、同じ2値を二重計上することになり、
「各要因の意味・上限・優先順位が不透明になる」という#200が排除したい状態に戻る。
`conflictIntensity`はInspector表示・比較preset・#203の定性検証のための**観察専用の派生値**とし、
`ClusterTransitionDecision`の出力には含めるが、`actionProbabilities`の計算には使わない。

### 1.5 移動意図 (PendingClusterTransition)

- **意味**: 「特定のクラスタへ移ると決めた後、そこへ到達するまでの一時的な意図」。
- **性質・寿命**: `switchToTargetCluster`確定と同時に生成し、
  join成功・無効化・TTL超過・`leaving`遷移・強制releaseのいずれかで破棄する(3.4節の寿命表)。
- **配置**: `Agent.pendingClusterTransition?: PendingClusterTransition`。
  episodeの外(agentが`undecided`/`approaching`の間)に生きるため、`ConversationEpisode`へは置けない。
- **`joinedGroupId`との正本関係(#201が求める明確化)**:
  - `agent.state === "approaching"`の間、**接近先の正本は従来どおり`agent.joinedGroupId`**である
    (engine step 3・整合性チェック・`recordApproachFailure`はすべてこれを読む。変更しない)。
  - `pendingClusterTransition.targetClusterId`は**意図の記録**であり、
    step 2 の候補選択において`nearestCandidate`の距離ベースの選択を**置き換える**ためだけに読む。
    step 2 が`agent.state = "approaching"`と`agent.joinedGroupId = target`を設定した後は、
    以降の処理はすべて既存経路と完全に同一になる。
  - **pending transitionは、cooldown除外・`isJoinable`・容量判定を一切バイパスしない。**
    targetがjoinable集合に含まれない場合は意図を破棄し(3.3節)、通常の`nearestCandidate`へfallbackする。
    容量の事前予約は行わない(#201の背景が指摘するとおり、既存の同一tick競合・capacity契約を壊すため)。

---

## 2. 既存概念との境界(明文化)

| 既存概念 | 意味 | Phase 3新概念との境界 |
| --- | --- | --- |
| `conversationSatisfaction`(#187) | 今の会話エピソードへの評価 | **愛着と同一視しない**(1.2節の対比表)。満足度は駆動側、愛着は抑制側。同じ事象(新規member参加)が満足度には正、愛着には負に効くことが両者の独立性を示す。 |
| `socialCirculationTendency`(#188) | 不満がなくても次の輪へ移りやすい安定trait | **他クラスタ関心と同一視しない**。回遊傾向は「**どこでもいいから**次へ動く」向きの trait(目的地を持たない)。他クラスタ関心は「**この輪へ**移りたい」という目的地を持つ一時評価。回遊傾向が高い人は`departAndExplore`が増え、関心が高い人は`switchToTargetCluster`が増える ―― この2つのactionを分けること自体が両者の分離の担保になる(4節)。 |
| `influenceAvoidance` | 自分の意思で場を動かしたくない度合い(安定trait) | 1.3.1節。**構造的影響factorへの乗算係数としてのみ**再利用し、単独の減点にはしない。`attractiveness()`での既存利用(入る側)とは別遷移のため二重計上にならない。 |
| `attractiveness()`(engine.ts) | **未所属**agentが候補へ接近する魅力度 | **他クラスタ関心と同一関数にしない**(#185 ADR 6節が満足度で下したのと同じ判断)。`attractiveness()`は`undecided` → `approaching`の判定で、`willingness`/`conformity`/`influenceAvoidance`/dominant clique占有率を掛け合わせる既存式。他クラスタ関心は**会話中**のagentが「今の輪と比べて」外を評価する式であり、入力(観察半径・join可能性・focus member)も出力の使われ方(遷移decisionへの寄与)も異なる。**Phase 3は`attractiveness()`の式に一切変更を加えない。** |
| `nearestCandidate()` | join可能な候補のうち最も近いものを返す | **削除も変更もしない**。pending transitionがある場合のみ step 2 でこれを**バイパス**し、無い場合・target無効時は従来どおり呼ぶ(既存の再探索契約を維持する)。 |
| `stress` / `leaveThreshold` | 未所属時の負荷 / **会場退出**の判定 | **クラスタ遷移decisionと接続しない**(#173 ADR 3.3節6、#185 ADR 2節を維持)。Phase 3の関心・愛着・配慮は責務9(`joined`→`undecided`)にのみ効き、責務4(`undecided`→`leaving`、会場退出)には一切効かない。「移りたい輪が見つからず、undecidedのままstressが溜まって帰る」は**既存2遷移の合成**でそのまま表現でき、新しい状態も新しい結線も不要である。 |
| `CLUSTER_REJOIN_COOLDOWN_TICKS` | 離脱直後の元clusterへの即時再接近の抑制 | **維持する**。加えて、関心評価側でも離脱直後のclusterへ`recentlyDeparted`の減点を入れる(cooldown期間が切れた直後に必ず元の輪へ戻る振動を防ぐ)。cooldownは**ハード除外**、`recentlyDeparted`は**score減点**であり、役割が重複しない2段構えとする。 |
| `relationshipTie.ts`(Phase 4) | 整合性履歴由来の±0.2に制限された補正 | 関心の`knownParticipant`factorから**参照してよい**(1.1.2節)。ただし補正幅はPhase 4の既存clampの範囲を超えて増幅しない(CLAUDE.mdの「preset 5の孤立ストーリーを swamp しない」方針と同じ理由で、関心側でも小さく保つ)。tie無効時は常に0。 |

---

## 3. tick更新順序と状態遷移

### 3.1 同一tick内の更新順序(engine.ts step番号との対応)

Phase 2の順序(#185 ADR 3.2節)へ、Phase 3の2ステップを**離脱評価(step 5b)の直前**に挿入する。
確定順序は次のとおり:

| # | step | 内容 | rng |
| --- | --- | --- | --- |
| 1 | 1〜3(既存) | 核形成 → 接近判断 → 移動・到着による合流(`joined`化・`clusterJoinedAtTick`設定・satisfaction/**attachment初期化**) | 消費する(既存) |
| 2 | 4, 5(既存) | forming/joined jitter、joined wander | 消費する(既存) |
| 3 | 5a(#187) | 会話満足度の更新 | しない |
| 4 | **5a2(新規 #199)** | **現在クラスタ愛着の更新** | **しない** |
| 5 | **5a3(新規 #198)** | **観察可能な他クラスタの列挙と関心評価** | **しない** |
| 6 | **5b(拡張 #200)** | Phase 2離脱圧力 + Phase 3関心・抑制を合成し、**1 drawでactionを抽選** | **1回だけ消費する(Phase 2と同数)** |
| 7 | 5b後半(拡張 #201) | 離脱・**移動意図の設定**・構造化イベント・membership更新(`departFromCluster`) | 消費する(既存) |
| 8 | 6, 7(既存) | undecided徘徊、stress蓄積・`leaving`判定 | 消費する(既存) |
| 9 | 8, 9(既存) | `leaving`移動、成立判定・責務10の縮小/解散・残存member release | 消費する(既存) |
| 10 | 整合性再検証(既存) | `joinedGroupId`の再検証、`membershipLost`によるepisodeクリア | ― |

**step 5b の抽選は「離脱するか」ではなく「3つのactionのどれを取るか」に拡張されるが、
消費するdrawは引き続き1回**である(4.2節)。

### 3.2 全ステップを「tick開始時点スナップショット」で評価する(決定事項)

**step 5a2(愛着)・5a3(関心)は、どちらも`stepSimulation`の入力である
`state.groupCandidates`(= 前tick終了時点のスナップショット)だけを観察対象とする。**
このtickの step 1〜3 で起きたjoin/leave、および同一tick内で先に処理された他agentの
step 5b の離脱結果は、**次tickまで見えない**。

- 根拠:
  1. **agentの処理順への依存を構造的に消す。** issueが「同一tickでtarget memberが離脱した場合、
     target clusterが満員になった場合の優先順位を明記する」と求めている問題は、
     このルールによって**優先順位を決める必要がなくなる**形で解消する
     ―― 同一tick内の変化は評価に一切入らないため、`agents`配列のどの位置で処理されても
     全agentが同じスナップショットを見る。
  2. #185 ADR 3.3節が満足度で確立した規則、および`speechEffects.ts`の
     「このtickで生じた変化は次tickから作用する」規則と完全に一致する。
  3. PRNG消費順序へ影響しない(5a2/5a3はrngを引かない)。
- **距離の測り方**: 「**このagent自身の現在位置**」と「**スナップショットのcluster中心(`candidate.x/y`)**」で測る。
  自分自身の位置は他agentの処理順に依存しないため、順序非依存性は保たれる。
- **同一tickでtargetが満員になった/target memberが離脱した場合**: 評価には影響せず、
  **次tickの無効化判定(3.3節)で初めて検出される**。この1tickの遅れは、
  上記1の順序非依存性と引き換えに受け入れる(#201の背景が指摘する「容量の事前予約はしない」方針とも整合する)。

### 3.3 移動意図の無効化と優先順位(決定事項)

`pendingClusterTransition`を持つagentは、**step 2(接近判断)の冒頭**で意図の有効性を検証する。
無効なら意図を破棄し、`clusterTransitionTargetInvalidated`を記録して、
その同じtickのうちに通常の`nearestCandidate`探索へfallbackする(agentを立ち往生させない)。

**同時に複数の条件が成立した場合、次の順で最初の1つだけを無効化理由として記録する:**

| 優先 | reason | 条件 |
| --- | --- | --- |
| 1 | `currentClusterLost` | 意図の生成元clusterが消滅済みで、意図自体が既に意味を失っている(防御的) |
| 2 | `targetMissing` | `targetClusterId`のcandidateが`groupCandidates`に存在しない |
| 3 | `targetDissolved` / `targetExpired` | targetの`status`が`dissolving`/`dissolved` / `expired` |
| 4 | `targetFull` | `isCandidateFull(target, capacity)`が真 |
| 5 | `focusAgentLeft` | `focusAgentId`が設定されており、そのagentがtargetの`memberIds`に含まれない |
| 6 | `intentExpired` | `tick >= expiresAtTick`(TTL超過) |

`approaching`中(step 3)にtargetが無効化された場合は、**既存の`recordApproachFailure`経路が
そのまま発火する**(`approachTargetInvalidated` / `joinFailedCapacity`)。
Phase 3は、その既存経路に「同時に`pendingClusterTransition`もクリアする」処理を1つ足すだけであり、
接近失敗・再探索・cooldownの契約自体は変更しない。

**現在clusterの解散と自発decisionの優先順位**: `engine.ts`の既存順序どおり、
step 5b(自発decision)が step 9(責務10の縮小・解散・残存member release)より**先**に走る。
したがって同一tickでは常に「自発decisionが先に適用され、その結果を含めて責務10が解散を判定する」。
強制release(`clusterMemberReleased`)されたagentは`currentEpisode`が`undefined`になるため愛着も同時に破棄され、
**強制releaseされたagentには自発的な葛藤・移動意図を一切付与しない**
(#199が要求する「cluster強制解散・所属先喪失では自発的な葛藤を適用しない」)。
なお、移動意図を持つのは`undecided`/`approaching`のagentだけであり、
`joined`中の強制releaseと移動意図が同時に存在することはない。

### 3.4 状態寿命表

| 状態 | 置き場所 | 生成 | 更新 | 破棄 |
| --- | --- | --- | --- | --- |
| `CurrentClusterAttachmentState` | `ConversationEpisode.attachment` | join時(`startConversationEpisode`) | step 5a2、毎tick | episode終了の3経路すべて(`voluntaryDeparture` / `memberReleased` / `membershipLost`)で`currentEpisode`ごと自動クリア |
| `AlternativeClusterInterest` | **保存しない** | step 5a3 で導出 | ― | 同一tick内で使用後に破棄。`switchToTargetCluster`確定時のみ`score`/`focusAgentId`を`PendingClusterTransition`へ写す |
| `DepartureInhibition` | **保存しない** | step 5b で導出 | ― | 同上(構造化イベントのmetadataへのみ残る) |
| `ClusterTransitionDecision` | **保存しない** | step 5b で導出 | ― | 同上。Inspectorは同じ入力で純粋関数を再計算して復元する |
| `PendingClusterTransition` | `Agent.pendingClusterTransition` | `switchToTargetCluster`確定時(離脱と同一処理内、原子的) | 生成後は不変(再評価しない) | join成功 / 3.3節の無効化 / TTL超過 / `leaving`遷移 / 強制release / シミュレーションreset |

「意図を生成後に再評価しない(不変)」のは、**意図が毎tick書き換わると振動が起きる**ためである
(#203が退化例として挙げる「target失敗後に元clusterとtargetの間を振動する」)。
意図は**生成されるか、破棄されるかのどちらか**であり、途中でtargetを乗り換えることはない。

---

## 4. 遷移decision契約(型案)

Phase 2の`ClusterDepartureContext`/`ClusterDepartureDecision`を維持したまま拡張する。
`afterParty`/`classroomPair`は引き続き`{ eligible: false, probability: 0 }`を返すため、
追加フィールドを一切無視できる。

```ts
// --- 他クラスタ関心 (#198) ---

export type AlternativeClusterInterestFactorKind =
  | "distance"             // 近いほど正、遠いほど小さい
  | "joinability"          // status/容量から見て入れる見込み
  | "knownParticipant"     // 既知のmember(clique/tie履歴の範囲)がいる
  | "cliqueCompatibility"  // 同clique比率による正の寄与
  | "outsiderBarrier"      // 単一cliqueに占有された輪への負の寄与
  | "recentlyDeparted"     // 直前に自分が離脱した輪への負の寄与
  | "capacityPressure";    // 満員に近いことによる負の寄与

export type AlternativeClusterInterestFactor = {
  kind: AlternativeClusterInterestFactorKind;
  /** この要因がscoreへ寄与した分。負の寄与を持つkindでは負値を取る */
  contribution: number;
  /** `knownParticipant`等、特定memberに由来する場合のみ設定する */
  relatedAgentId?: string;
};

export type AlternativeClusterInterest = {
  targetClusterId: string;
  /** 関心を主に駆動したmember(1.1.1)。距離・入りやすさだけで選ばれた場合はundefined */
  focusAgentId?: string;
  /** [0,1]。有限値であることを実装が保証する */
  score: number;
  /** contribution降順。寄与0のkindは含めない */
  factors: AlternativeClusterInterestFactor[];
  observedAtTick: number;
};

// --- 愛着・離脱配慮 (#199) ---

export type CurrentClusterAttachmentState = {
  /** [0,1] */
  value: number;
  initializedAtTick: number;
  lastUpdatedAtTick: number;
  /** 前tick終了時点で観測した同席人数(3.2節のスナップショット) */
  lastObservedMemberCount: number;
  /** join時から継続している同席memberのID集合(構成の安定を測るため) */
  foundingMemberIds: string[];
};

export type DepartureConcernFactorKind =
  | "episodeAttachment"
  | "clusterWouldDissolve"
  | "recentMemberJoined"
  | "influenceAvoidance";

export type DepartureConcernFactor = {
  kind: DepartureConcernFactorKind;
  /** 抑制へ寄与した分(0以上)。`influenceAvoidance`は乗算による増分を寄与として記録する(1.3.1) */
  contribution: number;
};

export type DepartureInhibition = {
  /** 愛着そのものの値 [0,1](表示用) */
  attachment: number;
  /** 構造的配慮の合計 [0,1] */
  concern: number;
  /** 実際に離脱確率へ掛かる総抑制 [0, maxInhibition]。maxInhibition < 1 */
  total: number;
  /** contribution降順 */
  factors: DepartureConcernFactor[];
};

// --- 遷移decision (#200) ---

export type ClusterTransitionAction = "stay" | "departAndExplore" | "switchToTargetCluster";

export type ClusterTransitionPrimaryReason =
  // Phase 2の3値をそのまま含む(後方互換。4.3節)
  | ClusterDeparturePrimaryReason
  // Phase 3で追加
  | "alternativeClusterInterest"
  | "mixedDepartureAndAlternativeInterest"
  | "stayedByAttachment"
  | "stayedByDepartureConcern"
  | "stayedByMixedInhibition";

export type ClusterTransitionDecision = {
  /** Phase 2と同じ。`ticksInCluster < minStayTicks`ならfalse(この場合drawを引かない) */
  eligible: boolean;
  /** 3つのactionの確率。すべて[0,1]、合計はちょうど1(4.1節の正規化規則) */
  actionProbabilities: Record<ClusterTransitionAction, number>;
  /** `switchToTargetCluster`の確率が0より大きい場合のみ設定 */
  selectedTargetClusterId?: string;
  focusAgentId?: string;
  /** Phase 2の離脱圧力(関心・抑制を適用する前の素の値) */
  departurePressure: number;
  departureFactors?: ClusterDepartureFactor[];
  alternativeInterest?: AlternativeClusterInterest;
  inhibition: DepartureInhibition;
  /** 観察専用の派生値。actionProbabilitiesの計算には使わない(1.4.1) */
  conflictIntensity: number;
  primaryReason?: ClusterTransitionPrimaryReason;
  decidedAtTick: number;
};

// --- 移動意図 (#201) ---

export type PendingClusterTransition = {
  targetClusterId: string;
  focusAgentId?: string;
  sourceClusterId: string;
  decidedAtTick: number;
  /** decidedAtTick + pendingTransitionTtlTicks */
  expiresAtTick: number;
  /** 決定時点の関心score(以後再評価しない、3.4節) */
  interestScore: number;
  primaryReason: ClusterTransitionPrimaryReason;
};

export type ClusterTransitionInvalidationReason =
  | "currentClusterLost"
  | "targetMissing"
  | "targetDissolved"
  | "targetExpired"
  | "targetFull"
  | "focusAgentLeft"
  | "intentExpired";
```

`ClusterDepartureDecision`(責務9の戻り値)は、Phase 2の`{ eligible, probability, factors,
primaryReason }`を**維持したまま**、任意フィールド`transition?: ClusterTransitionDecision`を追加する。
`probability`は引き続き「離脱する総確率」(= `departAndExplore` + `switchToTargetCluster`)を意味し、
既存の`engine.ts`・イベント・Inspector・集計が読む意味は変わらない。

### 4.1 確率の合成方針(実装Issueの指針)

Phase 2の`probability`(以下 `p2`)を出発点に、**関心で増やし、抑制で減らす**:

```
interestDrive = clamp01(bestInterest.score * interestToDepartureGain)          // 外部機会
inhibition    = min(clamp01(attachment * attachmentInhibitionWeight + concern),
                    maxInhibition)                                            // maxInhibition < 1
pDepart       = clamp01((1 - (1 - p2) * (1 - interestDrive)) * (1 - inhibition))
switchShare   = bestInterest.score >= minTargetInterestScore
                  ? clamp01(targetShareBase + bestInterest.score * targetShareGain)
                  : 0
pSwitch       = pDepart * switchShare
pExplore      = pDepart - pSwitch
pStay         = 1 - pDepart
```

設計上の性質(いずれも#203で単調性テストとして固定する):

- **Phase 2との合成形式が一致する**: 「不満由来」「回遊由来」を独立hazard `1-(1-a)(1-b)` で合成した
  Phase 2の方針を、第3の独立寄与`interestDrive`へそのまま延長する。
  各寄与が単調・`[0,1]`有界・「一方が0でも他方は機能する」を満たすという#188の採用理由がそのまま通る。
- **抑制は乗算で、完全ブロックにはならない**: `maxInhibition < 1`をvalidationで強制するため、
  `pDepart`が0に張り付くことはない。これはCLAUDE.mdが`attractiveness()`の
  outsider penaltyについて明記している「**確率を下げるだけで、ハードブロックはしない**」
  (十分なtickがあれば低確率事象も起きる)という既存の設計方針と同じである。
  #203が退化例として挙げる「愛着・配慮を上げると全agentが永久に同じclusterへ固定される」を、
  この上限が構造的に防ぐ。
- **単調性**: `interestDrive`が増えると`pDepart`は非減少、`inhibition`が増えると`pDepart`は非増加。
- **`interestDrive === 0`のとき`pDepart <= p2`**が常に成り立つ(抑制は減衰のみで増加させない)。
  ―― 「Phase 3を有効にしても、外部候補がない場面で離脱が増えることはない」という
  検証可能な不変条件になる(4.3節)。
- **`switchShare`は関心が閾値未満なら0**。閾値未満の弱い関心は`departAndExplore`(目的地なし)へ吸収され、
  「弱い関心で無理やり目的地を決める」ことがない。

### 4.2 RNG消費位置と抽選規則(決定事項)

**engine.tsは`u = rng.next()`を1回だけ引き、次の規則でactionを決める:**

```
u < pSwitch                 -> "switchToTargetCluster"
pSwitch <= u < pDepart      -> "departAndExplore"
u >= pDepart                -> "stay"
```

- `eligible === false`のときは**drawを引かない**(Phase 2の
  `if (!departure.eligible || !rng.chance(...)) continue;`の短絡評価を維持する)。
- `pSwitch === 0`のとき、この規則は`u < pDepart` ―― すなわち`rng.chance(pDepart)`と**完全に等価**である
  (`SeededRandom.chance(p)`は`next() < p`)。したがって
  **Phase 3を無効化した設定では、drawの回数も判定式もPhase 2とbyte-identicalになる**。
- 関心・愛着・配慮の計算(step 5a2/5a3、および4.1節の合成)は**すべて純粋関数でrngを一切消費しない**。
  乱数は上記の1 drawのみ。
- 派生RNG(`createInterventionRandom`型のストリーム)は**Phase 3では使わない**。
  target選択はtie-break(1.1.3)により完全に決定的であり、追加の乱数を必要としない。

### 4.3 外部候補が存在しない場合の後方互換(決定事項)

**2段階に分けて定義する。**

1. **設定による無効化(`transition.enabled === false`、既定)**
   `evaluateClusterDeparture`はPhase 2の`computeClusterDepartureDecision`へ完全にフォールバックし、
   `transition`フィールドを設定しない。step 5a2/5a3も実行しない。
   **確率・draw回数・イベント列・PRNG系列のすべてがPhase 2とbyte-identicalになる。**
   これが後方互換の本体であり、#185 ADR 6.1節の`satisfactionModelEnabled`と同じfall-backパターンである。

2. **有効時に外部候補が1つも存在しない場合**
   `interestDrive = 0`、`pSwitch = 0`となり、actionは`stay`/`departAndExplore`の2値に退化する。
   ただし**愛着・離脱配慮(抑制)は引き続き作用する**。
   これを「Phase 2の離脱decisionと**意味的に**同等」の定義とする
   ―― すなわち「外部関心由来の増分が0になり、Phase 2と同じ2択の意思決定形式へ退化する」ことであって、
   数値そのものの一致ではない。数値が完全に一致するのは、抑制側の全係数
   (`attachmentInhibitionWeight` / 各concern係数 / `influenceAvoidanceGain`)が0の場合である。
   - 根拠: 抑制は「外部候補の有無」とは独立した要因である(#199は「愛着が強ければ満足度が低くても
     留まる」を要求しており、これは周囲に別の輪があるかどうかに依存しない)。
     外部候補がないときだけ抑制を無効化すると、**「近くに輪がないときだけ躊躇しなくなる」**という
     説明のつかない非単調性が生じ、「各要因の意味・上限・優先順位を透明にする」という
     #200の目的に反する。
   - 代わりに、4.1節の`interestDrive === 0 → pDepart <= p2`という不変条件を保証することで、
     「Phase 3有効化がPhase 2比で離脱を**増やす**方向にだけは働かない」ことを検証可能にする。

`primaryReason`の導出も、この方針に沿って**Phase 2の値域を包含する**形にする:

| 状況 | primaryReason |
| --- | --- |
| 離脱側が支配的で、Phase 2寄与が主因 | `lowConversationSatisfaction` / `socialCirculation` / `mixedConversationAndSocialCirculation`(Phase 2と同一) |
| 離脱側が支配的で、関心寄与が主因 | `alternativeClusterInterest` |
| Phase 2寄与と関心寄与の差が`mixedReasonMargin`以内 | `mixedDepartureAndAlternativeInterest` |
| `stay`が選ばれ、抑制のうち愛着が主因 | `stayedByAttachment` |
| `stay`が選ばれ、抑制のうち構造的配慮が主因 | `stayedByDepartureConcern` |
| `stay`が選ばれ、両者の差が`mixedReasonMargin`以内 | `stayedByMixedInhibition` |
| 寄与がすべて0 | `undefined` |

`ClusterDepartureReason`(`types.ts`、構造化イベントの`departureReason`)は
`ClusterDeparturePrimaryReason | "clusterBelowMinimumSize"`という現在の定義を、
`ClusterTransitionPrimaryReason`が`ClusterDeparturePrimaryReason`を包含する形にしたことで
**既存の全消費者を壊さずに**拡張できる(Phase 2のコードは3値のまま読み続けられる)。

---

## 5. 観察可能情報と全知性の制限

Phase 3のdecisionが参照してよい情報を**明示的な許可リスト**として固定する。
実装Issueは、関心・愛着・配慮の各純粋関数の**引数にこれ以外の値を追加してはならない**
(`SimulationState`全体を渡さない ―― `schoolInterventionRuntime.ts`の
読み取り専用`SchoolInterventionContext`と同じ方針)。

### 5.1 参照してよいもの

| 情報 | 出所 | 備考 |
| --- | --- | --- |
| 自分の位置と、スナップショットのcluster中心座標 | `agent.x/y`, `candidate.x/y` | 3.2節。距離は`observationRadius`でカットオフ |
| cluster の `status` | `candidate.status` | `forming`/`confirmed`のみ候補。`dissolving`/`dissolved`/`expired`は除外 |
| cluster の人数と容量 | `candidate.memberIds.length`, `formationPolicy.resolveGroupCapacity` | `capacityPressure`/`joinability`の入力 |
| clusterのmember ID列 | `candidate.memberIds` | **IDと、そこから引ける公開属性のみ**(下記5.2の禁止事項に注意) |
| memberの`cliqueId` | `Agent.cliqueId` | 既存の関係情報。`attractiveness()`も同じものを見ている |
| `SimParams.existingTieStrength` | params | 既存 |
| Phase 4のtie補正(存在する場合のみ) | `relationshipTie.ts`の集約補正 | 無効時・未蓄積時は常に0 |
| 自分の満足度・愛着・滞在tick | `agent.currentEpisode` | 自分自身の状態 |
| 自分のtrait | `influenceAvoidance` / `socialCirculationTendency` 等 | 自分自身のtrait |
| 直前に離脱したcluster ID とtick | `agent.lastDepartedClusterId` / `lastDepartedClusterAtTick` | `recentlyDeparted`の入力 |
| 現在tick、シナリオ設定 | `tick`, `StandingPartyScenarioConfig` | ― |

### 5.2 参照してはいけないもの

- **他agentの非公開な内部状態**: `conversationSatisfaction`、`attachment`、`stress`、
  `leaveThreshold`、`willingness`等のtrait。
  ―― 「あの輪の人たちは満足していない」を知り得るのは全知であり、モデルの主張と矛盾する。
- **他agentの将来の行動・確率**: 離脱確率、次tickのdecision、pending transition。
- **観察範囲外のclusterを無条件に知ること**: `observationRadius`を超えるclusterは候補集合に入れない。
  「画面上に存在する全clusterを常に評価する」実装は禁止する。
- **実装都合だけで参照する将来状態**: このtickの step 1〜3 の結果、
  同一tick内で先に処理された他agentのdecision結果(3.2節で構造的に排除済み)。
- **`isObserverJoiner`**(1.4節)。

### 5.3 評価対象数の上限と、その明示

`observationRadius`内のcluster数が多い場合でも全件を評価するが、
`maxTrackedCandidates`(既定は十分大きい値)を超える場合は**距離昇順で切り捨てる**。
切り捨てが発生した場合は`AlternativeClusterInterest.factors`ではなく
**構造化イベントのmetadata(`observedCandidateCount` / `evaluatedCandidateCount`)へ記録する**
―― 「上限で打ち切ったのに全件を見たかのように読める」状態を作らない。

---

## 6. パラメータ一覧・範囲・validation方針

### 6.1 配置(決定事項)

**`SimParams`へは一切追加しない。** Phase 2で導入した`StandingPartyScenarioConfig`
(`standingPartyScenarioConfig.ts`、`FormationRuntimeOptions.standingPartyConfig`経由で
UI/プリセットから差し替え可能)へ**3ブロックを追加する**:

```ts
export type StandingPartyScenarioConfig = {
  conversationSatisfaction: ConversationSatisfactionConfig;   // 既存 (#187)
  clusterDeparture: ClusterDepartureDecisionConfig;           // 既存 (#188)
  circulationTendencyRange: SocialCirculationTendencyRange;   // 既存 (#189)
  alternativeInterest: AlternativeClusterInterestConfig;      // 新規 (#198)
  attachment: CurrentClusterAttachmentConfig;                 // 新規 (#199)
  transition: ClusterTransitionConfig;                        // 新規 (#200/#201)
};
```

`afterParty`/`classroomPair`では常に無視される(`resolveFormationPolicy`が
`standingParty`のときだけ設定を渡す既存の結線をそのまま使う)。

### 6.2 パラメータ一覧

`AlternativeClusterInterestConfig` (#198):

| 名前 | 範囲 | 意味 |
| --- | --- | --- |
| `observationRadius` | `> 0` | この距離を超えるclusterは候補集合に入れない(5.2) |
| `distanceDecayRadius` | `> 0` | 距離寄与の減衰スケール |
| `distanceWeight` | `[0,1]` | `distance` factorの上限寄与 |
| `knownParticipantWeight` | `[0,1]` | 既知memberによる上限寄与 |
| `cliqueCompatibilityWeight` | `[0,1]` | 同clique比率による上限寄与 |
| `outsiderBarrierPenaltyCap` | `[0,1]` | 単一cliqueに占有された輪への減点上限 |
| `capacityPressurePenaltyCap` | `[0,1]` | 満員に近いことによる減点上限 |
| `recentlyDepartedPenalty` | `[0,1]` | 直前に離脱した輪への減点 |
| `minTargetInterestScore` | `[0,1]` | これ未満の関心では`switchToTargetCluster`を選ばない(4.1) |
| `maxTrackedCandidates` | 正整数 | 評価対象の上限(5.3) |

`CurrentClusterAttachmentConfig` (#199):

| 名前 | 範囲 | 意味 |
| --- | --- | --- |
| `initialAttachment` | `[0,1]` | join時の初期値 |
| `attachmentGrowthPerTick` | `>= 0` | 1tickあたりの増加量 |
| `maxAttachment` | `[0,1]` | 飽和値(`initialAttachment <= maxAttachment`をvalidateする) |
| `memberTurnoverAttachmentLoss` | `>= 0` | 継続member比率の低下1あたりの減少量 |
| `newMemberDilution` | `>= 0` | 新規member1人あたりの希釈量 |
| `attachmentInhibitionWeight` | `[0,1]` | 愛着から抑制への変換係数 |
| `clusterWouldDissolveConcern` | `[0,1]` | 自分の離脱で解散する場合の配慮 |
| `recentMemberJoinedConcern` | `[0,1]` | 直前に誰かが参加した場合の配慮 |
| `recentMemberJoinedWindowTicks` | 非負整数 | 上記の判定ウィンドウ |
| `influenceAvoidanceGain` | `[0,4]` | 構造的配慮への乗算係数(1.3.1) |
| `maxInhibition` | `[0,1)` | **上限は1を含めない**(完全ブロック禁止、4.1) |

`ClusterTransitionConfig` (#200/#201):

| 名前 | 範囲 | 意味 |
| --- | --- | --- |
| `enabled` | boolean | Phase 3全体のゲート(既定`false`、4.3節1) |
| `interestToDepartureGain` | `[0,1]` | 関心scoreから離脱駆動への変換係数 |
| `targetShareBase` | `[0,1]` | `switchShare`の基礎値 |
| `targetShareGain` | `[0,1]` | 関心scoreに比例する`switchShare`の増分(`targetShareBase + targetShareGain <= 1`をvalidateする) |
| `pendingTransitionTtlTicks` | 正整数 | 移動意図の寿命(3.3節の`intentExpired`) |
| `mixedReasonMargin` | `[0,1]` | primaryReasonを`mixed*`にする寄与差の閾値(Phase 2と同じ意味) |

**agent個体差(trait)としてPhase 3で新設するものは無い。**
葛藤は既存の`influenceAvoidance`と、そのtickの状況から導出する(1.4節)。
これは「新しい人格類型のフラグを増やさない」という要件の直接の帰結である。

### 6.3 validation方針

既存3モジュール(`conversationSatisfaction.ts` / `clusterDepartureDecision.ts` /
`standingPartyScenarioConfig.ts`)と同一の方針を踏襲する:

- `assertFinite` / `assertRange` / `assertNonNegative` / `assertNonNegativeInteger`の同型ヘルパーを
  各モジュール内に置き、**NaN/Infinity・範囲外・不正な整数を安全に正規化せず、即座に throw する**。
- モジュール読み込み時に`DEFAULT_*_CONFIG`自身を検証する
  (`validateXxx(DEFAULT_XXX)`のトップレベル呼び出し)。
- `validateStandingPartyScenarioConfig`から3つの新validatorを呼び出し、
  **domain layerを最終防衛線とする**(UI側の入力検証だけに依存しない)。
- **相互制約**も検証する: `initialAttachment <= maxAttachment`、
  `targetShareBase + targetShareGain <= 1`、`maxInhibition < 1`、`observationRadius > 0`。
- `AlternativeClusterInterest.score`・`DepartureInhibition.total`・`actionProbabilities`の各値は、
  計算後に必ず`clamp01`を通す(#203の「常に有限範囲」を実装側でも保証する)。

### 6.4 既定値の決定は実装Issueへ委ねる

具体的な既定数値は本Issueでは確定しない(#185 ADR 5.1節と同じ扱い)。
実装Issue(#198/#199/#200)が、`conversationSatisfaction.ts`/`clusterDepartureDecision.ts`と同様に
**各定数へ「なぜその値か」のコメントを付けて**決定する。
既定値は「Phase 3を有効化しても、Phase 2の挙動から劇的に乖離しない」よう小さめに始め、
比較preset(#202)で意図した方向差を作る、という進め方を推奨する
(CLAUDE.mdの既存tuning方針と同じ性質)。

---

## 7. RNG・seed・既存シナリオ境界

- **関心・愛着・葛藤の計算は純粋関数とし、RNGを消費しない**(4.2節)。
  `AlternativeClusterInterest`のtie-breakも決定的(1.1.3)であり、派生RNGストリームも使わない。
- **actionの抽選のみ`engine.ts`が1 draw行う**。`eligible === false`ならdrawを引かない。
  `pSwitch === 0`のとき`rng.chance(pDepart)`と完全に等価(4.2節)。
- **Phase 3無効時(`transition.enabled === false`、既定)はPhase 2とbyte-identical**(4.3節1)。
- **`afterParty` / `classroomPair`への非影響**:
  両ポリシーの`evaluateClusterDeparture`は常に`{ eligible: false, probability: 0 }`を返すため、
  step 5b は**rngを一切消費しないno-op**のままである。step 5a2/5a3 も
  `formationPolicy.id === "standingParty"`のゲート(#187が`startConversationEpisode`/
  `updateConversationEpisode`で確立したパターン)の内側に置き、他シナリオでは実行しない。
  `Agent.pendingClusterTransition`は他シナリオでは常に`undefined`のままになる。
  回帰確認は`afterPartyRegression.test.ts` / `classroomPairInvariants.test.ts` /
  `nonInterference.test.ts` / `joinedGroupIntegrity.test.ts`が**無改修で通ること**とする。
- **設定は`SimParams`へ混在させない**(6.1節)。既存`StandingPartyScenarioConfig`の拡張として扱う。
  これにより二次会・学校のvalidation・UI・seed結果へは一切波及しない。
- **presentation層の非干渉**: Inspector/Canvasが遷移decisionを再計算しても、
  それは同じ入力に対する純粋関数呼び出しであり、PRNG消費もイベント列も変化させない
  (Phase 2の`inspection.ts`が確立した非干渉契約をそのまま維持する。#203の受入条件)。

---

## 8. 構造化イベント・記録方針

### 8.1 新規`SimulationEventType`案

**毎tick全候補をログへ出力しない。**記録するのは、意味のある**エッジ(変化点)**だけとする:

| イベント | 発火条件(エッジトリガ) |
| --- | --- |
| `alternativeClusterInterestChanged` | best targetの`targetClusterId`が前tickから**変わった**、または`score`が`interestEventDelta`を超えて変化した場合のみ。同一targetで微小変動する間は記録しない |
| `clusterTransitionInhibited` | 抑制が効いて`stay`になったことを、**1エピソードにつき最初の1回だけ**記録する(「関心はあったがなぜ留まったのか」を1件で説明できる) |
| `clusterTransitionTargetSelected` | `switchToTargetCluster`が確定し、`PendingClusterTransition`を生成した時 |
| `clusterTransitionTargetInvalidated` | 3.3節の無効化時。`metadata.invalidationReason`に理由を1つだけ持つ |
| `clusterTransitionCompleted` | 意図したtargetへ実際にjoinできた時(既存の`clusterRejoined`とは別に、意図の成否として記録する) |
| `clusterTransitionAbandoned` | 無効化後にfallback探索へ移った時。`targetInvalidated`の直後に続く1件で、「その後どうなったか」を補う |

既存の`clusterDepartureStarted` / `clusterDepartureCompleted` / `clusterResearchStarted` は
**そのまま維持**し、metadataへPhase 3のフィールドを追加する
(`departAndExplore`のときはPhase 2と同じ3件が従来どおり出る)。

`SimulationEventMetadata`への追加案(すべて任意フィールド、Phase 2の
`conversationSatisfactionAtDeparture`等と同じ扱い):

```ts
transitionAction?: ClusterTransitionAction;
targetClusterId?: string;
focusAgentId?: string;
alternativeInterestScore?: number;
alternativeInterestFactors?: AlternativeClusterInterestFactor[];
attachmentValue?: number;
departureConcern?: number;
inhibitionFactors?: DepartureConcernFactor[];
conflictIntensity?: number;
transitionPrimaryReason?: ClusterTransitionPrimaryReason;
invalidationReason?: ClusterTransitionInvalidationReason;
observedCandidateCount?: number;    // 5.3節
evaluatedCandidateCount?: number;   // 5.3節
```

### 8.2 文字列解析に依存させない

イベントの`message`(日本語の自然文)は**表示専用**であり、
UI・集計・テストは必ず`type`と上記のmetadataフィールドを読む。
これはPhase 2の`describeClusterDepartureReasonPhrase`が確立した分離
(構造化reason → 自然文言の一方向変換)をそのまま踏襲する。

文言は、Phase 2と同じ制約を守る:
**「飽きた」「つまらない人」等の人格・相手評価に見える断定表現を避け、
observerJoinerだけ異なる心理理由を捏造しない**(主語のみ出し分ける)。

### 8.3 エッジトリガ判定に必要な最小限の状態

`alternativeClusterInterestChanged`の「前tickから変わったか」を判定するには、
前tickのbest targetを1件だけ覚える必要がある。これは
`ConversationEpisode.lastReportedInterest?: { targetClusterId: string; score: number }`
として**episode内**に持ち、episode終了で自動的に破棄する(3.4節と同じ寿命)。
**decisionの入力には使わない**(記録の重複排除にのみ使う)ことを実装Issueのコメントで明記する。

---

## 9. 後続Issueへの分解と移行手順

`enabled`ゲート(4.3節1)により、各段階で既存挙動を壊さずに積み上げられる。

| 段階 | Issue | 内容 | 完了時点の挙動 |
| --- | --- | --- | --- |
| **P3-A** | #198 | `AlternativeClusterInterestConfig`・型・純粋関数(`deriveAlternativeClusterInterests` / `selectBestAlternativeCluster`)。engineからは**まだ呼ばない**か、呼んでも結果を捨てる(観察専用) | 変化なし |
| **P3-B** | #199 | `CurrentClusterAttachmentConfig`・型・`initializeAttachment`/`updateAttachment`/`computeDepartureInhibition`。step 5a2 をengineへ結線するが、**離脱式へはまだ入力しない**(Inspector表示のみ ―― #187がsatisfactionで採った段階と同じ) | 変化なし(rng不消費) |
| **P3-C** | #200 | `ClusterTransitionConfig`・`computeClusterTransitionDecision`。`evaluateClusterDeparture`を拡張し、`enabled`で Phase 2 式と切り替える。step 5b の抽選を4.2節の1 draw規則へ置換 | `enabled: false`のまま ⇒ 変化なし |
| **P3-D** | #201 | `PendingClusterTransition`の生成・step 2 の候補選択バイパス・3.3節の無効化とfallback・8.1節のイベント | 同上 |
| **P3-E** | #202 | standingParty専用UI設定・比較preset・Inspector・Canvasのtarget表示。Phase 2で残ったコンポーネントテスト/E2Eも回収 | presetでのみ`enabled: true` |
| **P3-F** | #203 | 単調性・再現性・不変条件・比較presetの定性差・E2E。安定後に既定を`enabled: true`へ倒すかを判断 | ― |

#198と#199は相互に依存しないため**並行実施可能**(ロードマップの推奨順
`#197 → (#198 / #199) → #200 → #201 → #202 → #203`と一致する)。

### 9.1 後続Issueが守るべき不変条件(#203のテスト対象)

- 1エージェント1クラスタ(#173 ADR 3.3節1)。pending transition中に別clusterへ所属して
  **二重membershipにならない**(意図は所属ではない)。
- 関心・愛着・配慮の全純粋関数が**入力をmutationせず、rngを消費しない**。
- `score`・`inhibition.total`・`actionProbabilities`が常に有限で`[0,1]`、確率の合計がちょうど1。
- 候補配列の順序を入れ替えてもbest targetが変わらない(1.1.3)。
- `interestDrive === 0`のとき`pDepart <= p2`(4.1節)。
- `maxInhibition < 1`のため`pDepart`が0に張り付かない(4.1節)。
- `enabled: false`でPhase 2とbyte-identical(確率・draw数・イベント列)。
- target消滅後に意図・episode・Inspector表示が残らない(3.4節の寿命表)。
- 強制release・所属先喪失では自発的な葛藤・移動意図を付与しない(3.3節)。
- presentation層(Inspector/Canvas)の有無でPRNG消費・イベント列が変わらない。
- `afterParty`/`classroomPair`の既存テストが無改修で通る(7節)。

### 9.2 本Issueで守る不変条件

**この文書は設計文書のみであり、既存runtime挙動・型・PRNG消費順序を一切変更しない。**
型・engineへの変更はP3-A以降で行う。

---

## 10. モデル上の注意(誤読防止)

Phase 2(#185 ADR 7節)と同じ立場をPhase 3でも維持する。
本文書と後続実装が観察対象とするのは、**個人の評価ではなく、ルール変更による集団ダイナミクスの差**である。

- **他クラスタ関心は、現実の好意・人気度の測定ではない。** 「今この状況で、どの輪へ移りやすいか」を
  行動生成のために`[0,1]`で表した一時的な評価値であり、特定の人物への感情を数値化・診断するものではない。
  `focusAgentId`は「なぜその輪を選んだか」の説明のための記録であって、好悪の順位づけではない(1.1.1)。
- **現在クラスタ愛着は、人間関係の深さの指標ではない。** 「今のエピソードから離れにくいか」という
  行動生成上の状態値であり、高い=良い関係/低い=浅い関係、ではない。
  長期的な接触記憶・関係性の学習は本フェーズの対象外である(1.2)。
- **ObserverJoinerの葛藤は、人格類型のラベルではない。** `isObserverJoiner`はいかなる式にも
  入力されず(1.4節)、葛藤は「外部への関心」と「場を動かすことへの配慮」という2つの連続値が
  同時に大きい状態として定義される。同じ条件が揃えばobserverJoiner以外にも同じ葛藤が生じる。
- **`influenceAvoidance`が高いことは、消極性の診断ではない。** 「自分の行動が場を動かすことへの
  抵抗」という行動パラメータであり、構造的影響が存在しない場面では一切作用しない(1.3.1)。
- **パラメータ値は実データ較正前の仮説的ルールである。** 減衰率・重み・閾値は心理学的妥当性を
  主張するものではなく、preset間・設定間の**コントラストを可視化するための調整値**である。
  #203の完了判定でも、特定の数値を現実の正解として固定せず、
  単調性・再現性・不変条件・比較preset間の定性的差で評価する。
- **観察対象は集団の挙動差である。** 「このagentは愛着が高い」を個人評価として読むのではなく、
  「この設定にすると、どれくらいの人がどのタイミングで意図を持って移動する/留まるか」という
  集団レベルの傾向の変化を見る。

これらはCLAUDE.mdの`observerJoiner` archetype方針
(「人格診断ではなくエージェントベースの社会過程の可視化」)と同じ立場である。
