# 会話満足度・社交的回遊傾向・滞在時間のドメイン契約 (Issue #185, Phase 2 設計)

Parent Roadmap: #172。Depends on: #173(会話クラスタモデルADR), #178(Phase 1導線整備)。
Blocks: Phase 2の会話エピソード状態・満足度更新・離脱意思決定の**本実装**。

この文書は、立食パーティー(`standingParty`)の会話クラスタ離脱を、Phase 1の暫定ルール
(`standingPartyPolicy.evaluateClusterDeparture`、一定滞在tick超過後の**agent特性非依存の固定確率**)
から、心理モデルへ交換するための**ドメイン契約(ADR)**である。**本Issueでは実装しない**
(既存コードの挙動・PRNG消費順序は一切変更しない)。後続Issueが追加の設計判断なしに実装へ着手できるよう、
新規概念の意味・既存概念との境界・tick更新順序・離脱意思決定の型案・パラメータ方針・移行手順を残す。

`FormationPolicy`(Issue #130、[formation-policy-model.md](formation-policy-model.md))と会話クラスタ
ADR(Issue #173、[interaction-cluster-model.md](interaction-cluster-model.md))が確立した
「シナリオ固有ルールは`engine.ts`へ分岐を書かず、ポリシー実装へ委譲する」「新しい状態は現状態
(`joinedGroupId`/`memberIds`)を汚さず、生成専用ログ・スナップショットを別途持つ」という2つの拡張パターンを、
本Issueでも判断基準の軸として使う。

---

## 0. 交換対象の現状(Phase 1 暫定ルール)

`formationPolicy.ts`の`standingPartyPolicy.evaluateClusterDeparture`は、現在こうなっている
(Issue #176、社会的意味を持たない暫定プレースホルダー):

```ts
// STANDING_PARTY_MIN_TICKS_BEFORE_DEPARTURE = 15
// STANDING_PARTY_PROVISIONAL_DEPARTURE_PROBABILITY = 0.05
evaluateClusterDeparture(_agent, _candidate, ctx) {
  if (ctx.ticksInCluster < STANDING_PARTY_MIN_TICKS_BEFORE_DEPARTURE) {
    return { eligible: false, probability: 0 };
  }
  return { eligible: true, probability: STANDING_PARTY_PROVISIONAL_DEPARTURE_PROBABILITY };
}
```

`engine.ts`のtickループでは、step 5「joined jitter」の直後(step 5b)でこれを呼び出し、
`rng.chance(departure.probability)`で実際の抽選を行い、離脱した場合に構造化イベント
(`clusterDepartureStarted`/`clusterDepartureCompleted`/`clusterResearchStarted`)を記録して
`departFromCluster`でmembershipを更新する(`ClusterDepartureContext`は`ticksInCluster`/`memberCount`/
`tick`のみ、`ClusterDepartureDecision`は`eligible`+`probability`のみ)。

Phase 2は、この`ctx`と`decision`の型を拡張し、`agent`/`candidate`を実際に参照する心理モデルへ
`evaluateClusterDeparture`の中身を差し替える。**`engine.ts`側の結線(step 5b・イベント記録・
`departFromCluster`)とpolicy契約の分離は維持し、`engine.ts`にシナリオ分岐を足さない。**

---

## 1. 新規概念の定義

### 1.1 会話満足度 (conversationSatisfaction)

- **意味**: 「今いる会話エピソードに対する、その時点の満足の状態値」。有限範囲 `[0, 1]`。
- **性質**: agentの**恒久的な性格ではなく、joinごとに初期化され時間変化する状態(state)**。
  `stress`と同じ「runtime state」の仲間であり、`willingness`/`conformity`等の trait とは層が異なる。
- **配置**: `Agent`の任意ランタイムフィールド `conversationSatisfaction?: number`。
  `clusterJoinedAtTick`(Issue #176)と同じライフサイクルで扱う ―― `joined`になった瞬間に初期化し、
  クラスタ離脱・所属先喪失時にクリア(`undefined`)する。`joined`以外の状態では意味を持たない。
- **入力(Phase 2で参照してよいもの)**: 現在の会話エピソード**そのもの**の性質に限る。
  1. 滞在tick(`ticksInCluster`)による**新鮮さの逓減**(長くいるほど基準値がゆるやかに下がる)
  2. 現在の人数(`memberCount`)が「居心地のよい人数」からどれだけ離れているか
  3. 現在の構成が自分の既存関係と噛み合うか(`existingTieStrength`/`cliqueId`による**構成補正**。
     3.2節の境界どおり、個別人物への固定好悪ではなく「同席者の構成」への補正としてのみ使う)
  4. このエピソード中に**新規memberが加わったこと**による新鮮さ回復(3.3節の順序ルールに従う)
- **入力に含めないもの(Phase 3へ先送り)**: **他クラスタの魅力度**、**observerJoinerの遠慮・葛藤・
  愛着**、話題の内容、情報伝播。満足度は「今の会話の中だけ」で閉じた値であり、外の輪と比較しない
  (「外がもっと良さそうだから今が不満」という相対評価はPhase 3)。
- **明確に区別する**: 満足度が低い ≠ stressが高い。stressは「未所属・曖昧状態での負荷」(`undecided`の間だけ
  蓄積、3.2節)。満足度は「所属中の会話への評価」。両者は別の軸・別の状態(3.2節で境界を明文化)。

### 1.2 社交的回遊傾向 (socialCirculationTendency)

- **意味**: 「今の会話に不満がなくても、より多くの人と交流するため、一定時間後に次の輪へ移りやすい」
  という**安定的な個体特性(trait)**。有限範囲 `[0, 1]`。高いほど回遊しやすい。
- **満足度との独立性**: これは「満足度が低いから離れる」とは**別方向・別動機**の離脱を表す。
  高い回遊傾向のagentは、満足度が高くても(=今の会話に不満がなくても)一定滞在後に移動しやすい。
  逆に低い回遊傾向のagentは、満足度が保たれる限り同じ輪に留まりやすい。
  ―― issueが要求する「『社交性が低いから離れる』と逆向きの行動も表現できる」を満たす:
  「低回遊 = 留まる / 高回遊 = 満足でも動く」であり、"低社交だから離脱する" とは逆の向きになる
  (低社交=低回遊は**留まる**方向に効く)。
- **性質**: `willingness`/`initiative`等と同じ trait 層の値。runごとに seed から生成され、run中は不変。
- **配置**: `Agent`の trait フィールド `socialCirculationTendency: number`(必須ではなく、`standingParty`
  でのみ意味を持つため任意フィールド `socialCirculationTendency?: number` とし、未設定時は中立既定値
  `0.5` へフォールバック ―― 4節の後方互換方針)。

### 1.3 会話エピソード / 滞在時間 (conversation episode / dwell time)

- **会話エピソード**: 1回の`joined`〜離脱までの、ひとつながりの滞在期間。
- **滞在時間(dwell time)**: 現在エピソードの起点`clusterJoinedAtTick`(Issue #176)からの経過tick。
  `ticksInCluster = tick - clusterJoinedAtTick`(`ClusterDepartureContext.ticksInCluster`として既に存在)。
- **同一clusterへの再参加の扱い(決定事項)**: **新しいエピソードとして扱う**。
  再参加時にも`clusterJoinedAtTick`は再設定され(engine.tsの既存挙動、`agent.clusterJoinedAtTick = tick`)、
  `conversationSatisfaction`も再初期化する。「前のエピソードの満足度を引き継ぐ」ことはしない。
  - 根拠: `clusterJoinedAtTick`が既にjoinごとにリセットされる実装であり、それに満足度の寿命を揃えると
    「エピソード = join〜離脱の1区間」という単位が滑走面をまたいで一貫する。再参加時に前回満足度を
    引き継ぐ設計は「特定の輪への愛着・記憶」を意味し、これはPhase 3(愛着)の対象。Phase 2では
    エピソードは常に無記憶(memoryless)に初期化する。
  - 接触履歴(誰といつ同席したか)の記録自体は、会話クラスタADR 3.3節7の`ClusterMembershipEvent`
    (Follow-up D、未着手)へ委ね、満足度・エピソード状態には持ち込まない。

---

## 2. 既存概念との境界(明文化)

| 既存概念 | 意味 | Phase 2新概念との境界 |
| --- | --- | --- |
| `initiative` | 自分から場・会話の核を作る力 | **回遊傾向そのものではない**。initiativeは「輪を**作る**」頻度の重み(責務1)。回遊は「作った/入った輪から**次へ移る**」傾向。核形成の多寡と回遊の多寡は独立の軸として持つ(高initiative・低回遊=よく輪を作るが動かない、も表現可能)。 |
| `willingness` | 既存の参加意欲(二次会に行きたい気持ち) | **会話満足度や交流人数志向と同一視しない**。willingnessは「場に加わりたい/留まりたい」入口の意欲。満足度は加わった**後**の評価。回遊傾向は「多くの人と会いたい」志向で、参加意欲の高低とは別。 |
| `conformity` | 周囲の動きに乗る傾向 | **満足度の代替値にしない**。conformityは他者の行動への追従(責務1/2)。満足度は自分の内的評価。「周りが移動するから自分も」という同調由来の回遊はPhase 3(周囲の離脱観測)の範囲とし、Phase 2の満足度・回遊式へは畳み込まない。 |
| `stress` | 未所属・曖昧状態での負荷 | **会話中の満足度とは別状態**。stressは`undecided`の間**のみ**蓄積(CLAUDE.md明文化ルール)。満足度は`joined`の間の状態。両者を1フィールドに統合しない。会話参加時のstress扱いは2.1節で決定。 |
| `existingTieStrength` / `cliqueId` | 既存関係の強さ / 所属clique | 現在の会話**構成**による満足度補正には**利用可**。ただし**個別人物への固定好悪は表現しない**。「同clique率が高い構成は満足度が下がりにくい」といった構成レベルの補正に限り、「特定agent Bが同席だから満足」は不可(それはPhase 3の接触ネットワーク)。 |
| `leaveThreshold` | 帰宅判断の早さ(stressしきい値) | **会場退出**の判定用(責務4、`undecided`→`leaving`)。**会話クラスタ離脱**(責務9、`joined`→`undecided`)とは別の遷移(会話クラスタADR 3.3節6)。満足度・回遊は責務9側にのみ効き、`leaveThreshold`とは接続しない。 |

### 2.1 会話参加時の既存stressの扱い(決定事項)

**Phase 2では`stress`のライフサイクルを一切変更しない。** 会話参加(`joined`化)時に既存stressを
維持・減衰・リセットするいずれの操作も**行わない**(現状どおり、`joined`の間はstressが蓄積も減衰も
しない ―― Phase 3の"greet"由来効果を除く既存挙動を保つ)。

- 根拠: stressのreset/decayを会話参加へ紐づけると、二次会(`afterParty`)・学校(`classroomPair`)の
  `joined`挙動・UI表示・集計(`maxStress`等)の意味論に波及する(受入条件: 二次会・学校の既存stress
  意味論へ影響させない)。会話満足度は`stress`とは**別フィールドの独立した状態**として新設し、
  離脱動機を満足度側で表現する。「会話クラスタを離脱して`undecided`へ戻った後、再びstressが蓄積を
  再開する」という既存の合成(会話クラスタADR 3.3節6)もそのまま維持する。

---

## 3. tick更新順序と状態遷移

### 3.1 会話満足度エピソードの状態遷移

| 現在 | イベント | satisfaction / episode の扱い |
| --- | --- | --- |
| `undecided`/`approaching` | `joined`化(合流/参加/再参加) | `clusterJoinedAtTick = tick`、`conversationSatisfaction`を初期値へ**初期化**(新エピソード開始) |
| `joined` | 毎tick経過 | satisfactionを更新(3.3節の入力に基づき、`[0,1]`へclamp) |
| `joined` | 同席者が離脱し人数減 | 次tickの更新で人数由来項が反映(離脱そのものは即時にsatisfactionを書き換えない、3.3節) |
| `joined` | 新規memberが加入 | **次tick**の更新で新鮮さ回復が反映(3.3節、同一tick内の順序非依存化) |
| `joined` | 責務9で離脱判定成立 | エピソード終了。`conversationSatisfaction`と`clusterJoinedAtTick`をクリア(`departFromCluster`内) |
| `joined` | 責務10で強制解放(`clusterMemberReleased`) | 同上(自発でない解放でもエピソードは終了しクリア) |

`AgentState`列挙・`GroupCandidateStatus`列挙は**追加しない**(会話クラスタADR 3.3節3・6を踏襲)。
満足度は状態遷移の**駆動因**であって、新しい状態値ではない。

### 3.2 同一tick内の更新順序(engine.ts step番号との対応)

既存tickループ(会話クラスタADR 1節参照)へ、Phase 2の満足度更新を**離脱評価(step 5b)の直前**に
挿入する。確定順序は次のとおり:

1. (既存 step 1-3) 核形成 → 接近判断 → 移動・到着による合流(`joined`化・`memberIds`追加・
   `clusterJoinedAtTick`設定・satisfaction**初期化**)
2. (既存 step 4) forming/joined jitter、(既存 step 5) joined wander
3. **(新規 step 5a) 会話満足度の更新**: `joined`な各agentについて、3.3節の式で
   `conversationSatisfaction`を更新・clampする
4. (既存 step 5b) 責務9離脱評価: 更新済みsatisfaction・回遊傾向を`ClusterDepartureContext`へ渡し
   `evaluateClusterDeparture`→`rng.chance`で抽選
5. (既存 step 5b後半) 離脱イベント(`clusterDepartureStarted`/`Completed`/`clusterResearchStarted`)と
   membership更新(`departFromCluster`)、責務10の縮小・解散判定
6. (既存 step 6以降) stress蓄積・`leaving`判定・候補掃除・整合性再検証

### 3.3 「新鮮さ回復」と離脱判定の順序 ―― 非依存化のルール(決定事項)

**新規memberが tick T に加入したことによる新鮮さ回復は、tick T+1 の満足度更新(step 5a)で反映する。**
tick T の離脱評価(step 5b)は、step 5a で更新した ―― すなわち **T-1 までの加入だけを織り込んだ** ―― 
satisfactionを参照する。

- 具体化: step 5a のsatisfaction更新は、「このagentが現在のエピソードで最後に観測した同席人数」を
  runtime state に持ち、**前tick終了時点のmemberIds**と比較して新規加入を検出する(このtickの
  step 1-3 で加入した人は、次tickの step 5a まで新鮮さ回復に寄与しない)。
- 根拠(なぜこの順序か):
  1. **処理順による結果の暗黙変化を排除する**。もし「同一tickで加入 → 即座に既存memberのsatisfaction
     回復 → 同tickの離脱評価」とすると、agentを配列順に処理する過程で「先に評価されたか後に評価
     されたか」で結果が変わり得る。加入反映を次tickへ遅延させると、step 5b は常に「tick開始時点で
     確定した状態」のみを見るため、agentの処理順に依存しない。
  2. **既存の確立パターンと一致**。Phase 3の`speechEffects`は「このtickの発言から生成した効果は
     **次tick**から作用する」(`advanceActiveSpeechEffects`をstepSimulation冒頭で適用、CLAUDE.md明記)。
     `activeSpeechEffects`と同じく「今tickで生じた変化は次tickのスナップショットへ」という規則に
     satisfactionの新鮮さ回復も揃える。PRNG消費順序にも影響しない(satisfaction更新はrngを引かない)。
  3. 人数**減少**(離脱)由来の満足度変化も同様に次tick反映で統一する(離脱がその場で残存memberの
     満足度を書き換えて同tickの連鎖離脱を誘発する、という順序依存を避ける)。

---

## 4. 離脱意思決定契約(型案)

Phase 1の`ClusterDepartureContext`/`ClusterDepartureDecision`(`formationPolicy.ts`)を拡張する。
**既存フィールドは維持**し、Phase 2用フィールドを追加する(afterParty/classroomPairは引き続き
`{ eligible: false, probability: 0 }`を返すため、追加フィールドを無視して差し支えない)。

```ts
// formationPolicy.ts への拡張案(本Issueでは型のみ提示、実装しない)

/** 責務9の入力コンテキスト。Phase 1の3フィールドへPhase 2の心理入力を追加する */
export type ClusterDepartureContext = {
  // --- Phase 1 既存(維持) ---
  ticksInCluster: number;
  memberCount: number;
  tick: number;
  // --- Phase 2 追加 ---
  /** 現在の会話エピソードの満足度 [0,1](step 5a で更新済みの値) */
  conversationSatisfaction: number;
  /** このagentの社交的回遊傾向 [0,1](trait、run中不変) */
  socialCirculationTendency: number;
  /** シナリオ設定の最低滞在tick。これ未満は eligible: false(下限。5節) */
  minStayTicks: number;
};

/** 離脱理由の寄与要因コード(structuredに返す。表示文言の解析に依存させない) */
export type ClusterDepartureFactorKind =
  | "lowConversationSatisfaction" // 今の会話への満足度が低いため離れる
  | "socialCirculation";          // 不満はないが、より多くの人と交流するため次へ移る

/** 各要因の寄与(確率への加算分・その要因が支配的か)を構造化して返す */
export type ClusterDepartureFactor = {
  kind: ClusterDepartureFactorKind;
  /** この要因が離脱確率へ寄与した分(0以上) */
  contribution: number;
};

/** 責務9の判定結果。Phase 1の eligible + probability を維持しつつ理由を構造化する */
export type ClusterDepartureDecision = {
  // --- Phase 1 既存(維持) ---
  eligible: boolean;
  probability: number;
  // --- Phase 2 追加(任意。afterParty/classroomPairは未設定のままでよい) ---
  /** 寄与要因の内訳(probability > 0 のとき)。contribution降順 */
  factors?: ClusterDepartureFactor[];
  /** 最も寄与の大きい要因(離脱が起きた際に構造化イベントへ記録する主要理由) */
  primaryReason?: ClusterDepartureFactorKind;
};
```

### 4.1 離脱確率の合成方針(実装Issueの指針、式の定数は本Issueで確定しない)

`probability`は2つの独立要因の合成として構成する(いずれも「多いほど離脱しやすい」向き):

- **不満由来**(`lowConversationSatisfaction`): `conversationSatisfaction`が低いほど大きい。
  例: 満足度が或るしきい値`SATISFACTION_LEAVE_FLOOR`を下回る分に比例。満足度が高ければ 0。
- **回遊由来**(`socialCirculation`): `socialCirculationTendency`が高く、かつ滞在が長いほど大きい。
  満足度が高くても 0 にはならない(回遊はそもそも「不満がなくても動く」動機のため)。

`eligible`は`ticksInCluster >= minStayTicks`で判定(Phase 1の`MIN_TICKS_BEFORE_DEPARTURE`の役割を
`minStayTicks`へ移す)。合成した`probability`は`[0,1]`へclamp。`factors`には寄与が正の要因のみを
contribution降順で入れ、`primaryReason`はその先頭。`engine.ts`は既存どおり`rng.chance(probability)`で
抽選し、離脱成立時に`primaryReason`を構造化イベントの`departureReason`へ記録する(4.2節)。

### 4.2 離脱理由コード(`types.ts`の`ClusterDepartureReason`拡張案)

現状の`ClusterDepartureReason`(`types.ts`)は2値:

```ts
export type ClusterDepartureReason = "provisionalStayDuration" | "clusterBelowMinimumSize";
```

Phase 2実装で次のように拡張する(**`clusterBelowMinimumSize`は責務10由来のため維持**、
`provisionalStayDuration`はPhase 2完了後に**削除**する ―― 移行手順は6節):

```ts
export type ClusterDepartureReason =
  | "provisionalStayDuration"      // Phase 1暫定(Phase 2完了で削除予定)
  | "clusterBelowMinimumSize"      // 責務10(維持)
  | "lowConversationSatisfaction"  // Phase 2: 満足度低下による自発離脱
  | "socialCirculation";           // Phase 2: 回遊傾向による自発離脱
```

`SimulationEventMetadata`(`types.ts`)は既存の`departureReason?: ClusterDepartureReason`・
`ticksInCluster?`をそのまま使う。加えて、集計で満足度・回遊の寄与を追えるよう、任意フィールド
`conversationSatisfaction?: number` の追加を実装Issueで検討する(必須ではない ―― `factors`を
イベントへ落とすかは実装時の集計要求で判断)。

---

## 5. パラメータと設定境界

### 5.1 agent個体差 vs シナリオ設定の区別

| 値 | 層 | 配置 | 範囲 | 既定 |
| --- | --- | --- | --- | --- |
| `socialCirculationTendency` | **agent個体差(trait)** | `Agent.socialCirculationTendency?` | `[0,1]` | フォールバック`0.5` |
| `conversationSatisfaction` | **agentランタイム状態(state)** | `Agent.conversationSatisfaction?` | `[0,1]` | join時に`SATISFACTION_INITIAL`へ初期化、非所属時`undefined` |
| `minStayTicks` | **シナリオ設定** | standingParty policy定数(既定) | `>= 0` の整数 | 現`MIN_TICKS_BEFORE_DEPARTURE`(15)を継承 |
| 満足度の初期値・逓減率・新鮮さ回復量・居心地人数 | **シナリオ設定** | standingParty policy定数 | 各項で`[0,1]`等 | 実装Issueで初期値決定(6節) |
| 不満しきい値・回遊基礎率 | **シナリオ設定** | standingParty policy定数 | `[0,1]` | 同上 |

- **agent個体差**として持つのは`socialCirculationTendency`のみ(安定特性だから)。満足度は個体差でなく
  エピソードごとの状態。それ以外(逓減率・回復量・しきい値・最低滞在tick)は**シナリオ設定**であり、
  全agentで共有する。
- **シナリオ設定の配置**: 当面は`standingPartyPolicy`内の`const`(現在の`STANDING_PARTY_*`定数と
  同じ場所)に置く。`SimParams`へは**足さない**(受入条件: 二次会・学校の既存validation・UI・seed結果へ
  波及させない ―― `SimParams`拡張は全シナリオのvalidation/プリセット/UIへ影響する)。将来、UIから
  これらを可変にする要求が出た時点で、`classroomPair`が`formationClassroomGroupSize`
  (`SimulationState`の任意オーバーライド、`formationScenarioId`と同じfall-backパターン)で辿ったのと
  同じ方式で `standingPartyConfig?` を`SimulationState`へ追加する(本Issueでは追加しない)。

### 5.2 validation方針

- `socialCirculationTendency`は生成時に`[0,1]`へclamp。読み取り側(`evaluateClusterDeparture`)は
  未設定を`0.5`へフォールバック(4節の後方互換)。
- `conversationSatisfaction`は毎tick更新後に`[0,1]`へclamp。`joined`以外での参照は不正としない
  (未設定=`undefined`を、離脱評価が呼ばれない前提で許容 ―― step 5bは`joined`のみ対象)。
- `minStayTicks`は非負整数。既存の`classroomPair`policy factoryが`validateClassroomGroupFormationOptions`で
  やっているのと同様、standingParty設定を導入するIssueが専用のvalidatorを置く(本Issueでは型のみ)。

### 5.3 seed生成方針(既存の二次会・学校結果を変えないこと)

**`socialCirculationTendency`は、主系列`SeededRandom`とは独立した派生RNGストリームから生成する。**
`schoolInterventionRuntime.ts`の`createInterventionRandom(runSeed, ..., salt)`が確立した
「主RNGを乱さずに追加の乱数を引く」パターンを踏襲し、例えば`createTraitRandom(seed, "socialCirculation")`
のような別ストリームから各agent分を引く。

- 根拠(受入条件: 既存seedの二次会・学校結果を不必要に変えない): `createInitialAgents`の主系列で
  新たに1draw追加すると、それ以降の全draw(clique割当・leader指名など)がずれ、`afterParty`/
  `classroomPair`の既存seed結果が変わってしまう。派生ストリームから引けば、**全シナリオの主系列
  消費順序がbyte-identicalに保たれる**(`afterParty`/`classroomPair`はこのtraitを読まないため、
  値が生成されても挙動は不変)。`standingParty`も、Phase 2実装で初めてこの値を`evaluateClusterDeparture`
  が読むまでは挙動不変。
- 分布は既存trait(`willingness`等)の生成に倣い、中央寄せ or 一様のいずれかを実装Issueで決める
  (本Issueでは`[0,1]`一様を暫定基準とし、preset 5相当のコントラスト検証はstandingPartyには存在しない
  ため、5プリセット回帰の制約は受けない)。

---

## 6. 後方互換 / Phase 2無効化 / 移行手順

### 6.1 無効化(backward compat)スイッチ

Phase 3/4フラグ(`speechEffectsEnabled`等)と同じfall-backパターンで、Phase 2満足度モデルの
有効/無効を`SimulationState.satisfactionModelEnabled?: boolean`(仮称)で切り替えられるようにする。

- **無効時(既定、後方互換)**: `standingPartyPolicy.evaluateClusterDeparture`はPhase 1暫定ルール
  (`ticksInCluster >= minStayTicks`で固定確率)へフォールバックする。→ 本Issue直後〜移行完了までの
  既存挙動を保つ。
- **有効時**: 4節の満足度・回遊合成式を使う。
- `afterParty`/`classroomPair`はフラグに関わらず`{ eligible: false }`(責務9を持たない)なので、
  この設定は`standingParty`のみに作用し、二次会・学校へは一切影響しない。

### 6.2 後続Issueへの分解(依存関係順)

会話クラスタADR 4節の Follow-up 分解と同じ粒度で、本Issueの契約を実装へ落とす:

1. **Follow-up P2-A: 型・状態の器の追加(挙動不変)**
   `ClusterDepartureContext`/`ClusterDepartureDecision`の拡張、`ClusterDepartureReason`への
   2コード追加、`Agent.conversationSatisfaction?`/`socialCirculationTendency?`フィールド追加、
   `createTraitRandom`による回遊傾向のseed生成(派生ストリーム)。この時点では
   `evaluateClusterDeparture`はまだ暫定ルールのままで、追加フィールドは**読まれない**
   (`afterPartyRegression.test.ts`・`classroomPairInvariants.test.ts`・`standingParty*.test.ts`が
   無改修で通ることを回帰確認)。
2. **Follow-up P2-B: 満足度更新(step 5a)のengine結線**
   step 5a を追加し、`joined`agentの`conversationSatisfaction`を毎tick更新・clamp。新鮮さ回復の
   次tick反映(3.3節)を実装。この時点でもsatisfactionは離脱式に**まだ入力しない**(観察専用値として
   Inspector表示のみ ―― Issue #178のInspector拡張パターンに接続)。satisfaction更新はrngを引かないため
   PRNG系列は不変。
3. **Follow-up P2-C: 離脱式の交換(`satisfactionModelEnabled`ゲート付き)**
   `standingPartyPolicy.evaluateClusterDeparture`を4節の合成式へ差し替え、`satisfactionModelEnabled`で
   暫定ルールとの切り替えを実装。`factors`/`primaryReason`を構造化イベント(`departureReason`)へ結線。
   standingParty向けの新規テスト(満足度低下→離脱、高回遊→満足でも離脱、低回遊→留まる、の3系列)を
   追加。多seed × 継続実行(observation horizon)での集団ダイナミクス差を検証。
4. **Follow-up P2-D: 暫定ルールの撤去**
   C の安定後、`provisionalStayDuration`コードと`STANDING_PARTY_PROVISIONAL_DEPARTURE_PROBABILITY`を
   削除し、`satisfactionModelEnabled`の既定を有効へ倒す(standingParty presetで満足度モデルを標準に
   する)。この撤去まではA-Cを通じて既存seed結果を壊さない。

### 6.3 本Issueで守る不変条件(受入条件の対応)

- 会話満足度・社交的回遊傾向・滞在時間の責務が具体的に定義されている(1節)。
- 既存`initiative`/`willingness`/`conformity`/`stress`との違いが明記(2節、2.1節)。
- join・満足度更新・離脱判定のtick順序が決定(3.2節)、同一tick新規加入の順序も根拠つきで固定(3.3節)。
- 離脱判断の入力・出力・理由コードの型案(4節、4.2節)。
- agent特性とシナリオ設定の配置・validation・seed方針(5節)。
- Phase 3以降(他クラスタ魅力度・observerJoinerの遠慮/愛着/葛藤・話題/情報伝播・実データ較正)は
  対象外として明示(1.1節・1.3節・7節)。
- 後続Issueが追加の設計判断なしに着手できる分解(6.2節)。
- **既存コードの挙動は本Issueでは変更しない**(この文書はdocのみ。型・engineへの変更は Follow-up P2-A 以降)。

---

## 7. モデル上の注意(誤読防止)

この文書とPhase 2実装が観察対象とするのは、**個人の評価**ではなく、**ルール変更による集団ダイナミクスの
差**である。以下を明記する:

- **会話満足度は、現実の幸福度・好感度の測定ではない。** シミュレーション上の`[0,1]`の状態値であり、
  現実の人物の感情を数値化・診断するものではない。
- **社交的回遊傾向は、内向性／外向性の人格診断ではない。** 「多くの人と交流したくて動きやすいか」という
  行動生成上のパラメータであり、性格類型のラベルづけではない。高い=良い/悪い、でもない。
- **パラメータ値は実データ較正前の仮説的ルールである。** 逓減率・しきい値・回遊基礎率などの定数は、
  心理学的妥当性を主張するものではなく、preset間・介入前後の**コントラストを可視化するための調整値**
  (CLAUDE.mdの既存tuning方針と同じ性質)。
- **観察対象は個人評価ではなく、集団の挙動差である。** 「このagentは満足度が低い」を評価として読むのではなく、
  「この設定にすると、いつ・どれくらいの人が会話を渡り歩く/留まるか」という集団レベルの傾向の変化を見る。

これらはCLAUDE.mdの`observerJoiner`archetype方針(「人格診断ではなくエージェントベースの社会過程の
可視化」)と同じ立場であり、Phase 2でも維持する。

---

## 8. 実装ノート (Issue #187)

Issue #187は、6.2節のFollow-up P2-A(型・状態の器)とP2-B(満足度更新のengine結線)を1つのIssueとして
まとめて実装した。`evaluateClusterDeparture`(責務9)への入力接続はP2-C(#188)のまま未着手であり、
`conversationSatisfaction`は引き続き**離脱判定に一切使われない観察専用値**である。実装は次の点で
本文書の記述を具体化・一部調整している。

- **配置**: `src/simulation/conversationSatisfaction.ts`に、型・`DEFAULT_CONVERSATION_SATISFACTION_CONFIG`・
  validation・`initializeConversationSatisfaction`/`updateConversationSatisfaction`(いずれもrng不使用の
  純粋関数)を実装した。5.1節の「当面はstandingPartyPolicy内のconstに置く」方針を、
  「standingParty専用のscenario config」として独立モジュールに置く形で具体化した(`SimParams`は未変更)。
  `socialCirculationTendency`(4節の型案)は本Issueでは追加していない ―― 離脱式(#188)が実際に読むまでは
  意味を持たない値のため、P2-Cで導入する。
- **standingParty限定のゲート**: `engine.ts`の`startConversationEpisode`/`updateConversationEpisode`は
  `formationPolicy.id === "standingParty"`のときだけ満足度を計算する(`FormationPolicy`の既存の
  「シナリオ分岐はpolicyへ委ねる」パターンに倣う具体的な境界)。`Agent.currentEpisode`のコンテナ自体は
  #186どおり全シナリオ共通のため、この境界がないとafterParty/classroomPairの`conversationSatisfaction`が
  undefinedのままという既存の受入条件(二次会・学校への非影響)を壊してしまう。
- **人数観測の一本化**: 3.3節の「新規member参加は次tickへ反映、処理順に依存しない」というルールを、
  member離脱(人数減少)にも同様に適用した(3.3節末尾で示唆されている「人数減少由来の変化も次tick反映で
  統一する」を、新規member検出と同じ1つのスナップショット値(`observedMemberCount`、tick開始時点=
  `stepSimulation`の入力`state.groupCandidates`が持つ値)で表現することで実現)。この値を新規member検出・
  人数補正の両方に使うことで、同一tick内の他agentの処理順に一切依存しない。
- **「departure / size contribution」を1つの値に統合**: 7節の要求どおり、member離脱専用の固定ペナルティは
  設けず、`sizeContribution`(居心地のよい人数からの乖離)1つに一本化した。人数減少は`observedMemberCount`
  の減少を通じて自動的にこの項へ反映されるため、「member減少が必ず悪影響とは限らない」(元の輪が
  大きすぎた場合、減ることでむしろ`sizeContribution`が改善し得る)という設計上の要求を満たす。
- **同clique補正**: `attractiveness()`(engine.ts)の「dominant clique占有率」ベースの式とは別に、
  「エージェント自身のclique仲間比率」(`computeCliqueMateRatio`)を新設した。dominant cliqueは
  「輪を占有している向き」を見る指標で、必ずしもagent自身の所属cliqueと一致しないため、
  「同席者の構成が自分の既存関係とどれだけ噛み合うか」という満足度側の意味(1.1節)には
  自分視点の比率の方が直接対応する(6節「同一関数にしない」を踏まえた別式)。
- **テスト**: `src/simulation/conversationSatisfaction.test.ts`に純粋関数の単体テスト(範囲・決定性・
  decay/新規member/人数/clique各寄与の単体挙動・validation)と、engine結線レベルの結合テスト
  (standingParty限定・新規member反映の1tick遅延・同一seed再現性・Inspector呼び出しの有無による
  非干渉)を追加した。既存の`conversationEpisode.test.ts`(#186)は、合流と同時に満足度が決定的な
  初期値へ初期化されることを検証するよう更新した(以前は「Phase 2は対象外」として`undefined`を
  期待していた箇所)。`afterPartyRegression.test.ts`・`classroomPairInvariants.test.ts`・
  `standingParty*.test.ts`は無改修のまま全て通過し、既存シナリオへの回帰がないことを確認済み。
