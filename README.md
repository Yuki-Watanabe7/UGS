# グループ形成過程シミュレーター

二次会や教室で、人が相手を探してグループを作る過程を可視化するプロトタイプです。

このアプリは性格診断ツールではありません。**人が自由に相手を探してグループを形成する過程そのもの**——誰かが声を上げ、様子見していた人が輪に近づき、先に成立した組からあふれた人が相手を探し直す——という力学を、場面とパラメータを変えながら観察するためのシミュレーターです。

特に注目しているのは `observerJoiner` 型のエージェントです。

```ts
const observerJoiner = {
  willingness: 0.8,          // 二次会には行きたい
  initiative: 0.1,           // 自分から場を作ることはほぼしない
  ambiguityTolerance: 0.25,  // 曖昧な形成途中の時間に弱い
  influenceAvoidance: 0.9,   // 自分の意思で場を動かしたくない
  conformity: 0.5,           // 場ができればある程度乗れる
  leaveThreshold: 0.4,       // しんどくなると帰る
};
```

「行きたくない人」ではなく、**行きたい気持ちはあるが、場が形成される前の探り合いが苦手な人**です。画面上ではオレンジ色の太枠で強調表示されます。

## 公開版(GitHub Pages)

ビルド済みのUGSはGitHub Pagesで公開されています。インストール不要で、iPhoneのSafariを含む任意のブラウザから次のURLを開くだけで利用できます。

**https://yuki-watanabe7.github.io/UGS/**

トップページで利用目的を選ぶと、それぞれ固有のURLでシミュレーションを開けます。

| 種別 | URL | 内容 |
| --- | --- | --- |
| シナリオ選択 | https://yuki-watanabe7.github.io/UGS/ | 二次会または学校のシミュレーションを選ぶ |
| 二次会のグループ形成 | https://yuki-watanabe7.github.io/UGS/simulate/after-party | 二次会向け5プリセット。初期値は「自然に二次会が成立する場」 |
| 学校のペア・班作り | https://yuki-watanabe7.github.io/UGS/simulate/classroom | 学校向けプリセット。初期値は「教室で自由にペアを作る場」 |

各URLは直接アクセス・再読み込み・共有が可能です。シミュレーション画面上部の「シナリオ選択へ」からトップページへ戻れます。

- `main` ブランチへのpushをトリガーに、GitHub Actions(`.github/workflows/pages.yml`)が lint / test / build を実行して自動デプロイします
- 公開版は**利用向け**です。コードを変更しながら動作を確かめたい場合は、後述のローカル開発起動(`npm run dev`)や実機確認(`npm run dev:host`)を使ってください

### iPhoneのホーム画面に追加する(PWA)

公開版はPWA(Progressive Web App)に対応しており、iPhoneのホーム画面に追加するとアプリに近い形で起動できます。

1. iPhoneのSafariで **https://yuki-watanabe7.github.io/UGS/** を開く
2. 画面下部の**共有ボタン**(四角から上矢印が出ているアイコン)をタップする
3. メニューから**「ホーム画面に追加」**を選び、右上の「追加」をタップする
4. ホーム画面に追加された「UGS」アイコンをタップして起動する

通常のSafariタブ表示との違い:

- Safariのアドレスバーやツールバーが表示されず、**全画面のスタンドアロン表示**で起動します
- ホーム画面のアイコンから1タップで起動でき、他のタブに紛れません
- Service Workerが静的アセットをキャッシュするため再訪問時の読み込みが安定し、一度表示したあとであればオフラインでも最低限アプリシェルが表示されます(シミュレーション自体は全てブラウザ内で完結するため、起動後は通信不要で動作します)

中身は同じWebアプリであり、機能差はありません。プッシュ通知やApp Store配布には対応していません。

## 起動方法

```bash
npm install
npm run dev
```

表示されたURL(通常 http://localhost:5173/UGS/ )をブラウザで開いてください。GitHub Pages公開のため `vite.config.ts` で `base: '/UGS/'` を設定しており、開発サーバーのURLにも `/UGS/` が付きます。ローカルでも `/UGS/simulate/after-party` と `/UGS/simulate/classroom` へ直接アクセスできます。

- `npm run build` — 型チェック + 本番ビルド
- `npm run test` — Vitestによるシミュレーションロジックのユニットテスト
- `npm run lint` — oxlintによる静的解析

### iPhone実機で確認する方法

`npm run dev` の `localhost` はMac自身を指すため、iPhoneからはそのまま開けません。同一Wi-Fi上のiPhone Safariから開発中の画面を確認するには、開発サーバーをLANに公開して起動します。

1. MacとiPhoneを**同じWi-Fi**に接続する
2. Mac側でLAN公開モードの開発サーバーを起動する

   ```bash
   npm run dev:host
   ```

3. MacのローカルIPアドレスを確認する
   - ターミナルで `ipconfig getifaddr en0` を実行する(Wi-Fi接続時の一般的なインターフェース。表示されない場合は `ifconfig | grep "inet "` で確認)
   - または「システム設定 → Wi-Fi → 接続中のネットワークの詳細」でIPアドレスを確認
   - `npm run dev:host` 起動時にViteが表示する `Network:` のURLをそのまま使ってもよい
4. iPhoneのSafariで `http://<MacのIPアドレス>:5173/UGS/` を開く(例: `http://192.168.1.23:5173/UGS/`)

#### 注意点

- 社内Wi-Fiや公共Wi-Fiなど、端末間通信(クライアントアイソレーション)が遮断されるネットワークでは接続できない場合があります
- Macのファイアウォール設定によってはアクセスがブロックされることがあります(「システム設定 → ネットワーク → ファイアウォール」で許可が必要な場合あり)
- `dev:host` はあくまで**開発中の実機確認用**です。開発サーバーをそのまま本番公開する用途には使わないでください
- 通常のPCローカル開発はこれまでどおり `npm run dev` を使ってください

### 3つの起動・利用方法の使い分け

| 方法 | URL | 用途 |
| --- | --- | --- |
| GitHub Pages公開版 | https://yuki-watanabe7.github.io/UGS/ | 開発環境なしで利用する(iPhone含む)。`main` の最新ビルドが反映される |
| `npm run dev` | http://localhost:5173/UGS/ | PC上での通常開発。コード変更が即時反映される |
| `npm run dev:host` | http://\<MacのIP\>:5173/UGS/ | 開発中のコードを同一Wi-Fi上のiPhone実機で確認する |

## 画面の見方

- **シミュレーション領域**: 円1つ1つが1人のエージェント。色が状態を表します。
  - `gray`: 未定 / `blue`: 二次会に向かう意思が強まりつつある(接近中) / `green`: 輪に合流済み(形成中の輪への合流・成立済みグループへの参加のどちらも含む) / `red`: 帰宅方向 / `purple`: 核を作っている主導者 / `orange`: observerJoiner型(注目対象)
  - 円が大きいほど主導性(initiative)が高い人です。太いオレンジの縁取りが観察対象。
  - 点線の輪は「形成中の輪」、実線の緑の輪は「成立済みの二次会グループ」で、内側にメンバー数が表示されます。
- **操作パネル**: Start/Pause、Step 1 tick、Reset、Seed、シナリオプリセット、各種パラメータのスライダー。
- **状態ログ**: 「なぜその人が動いたのか」を日本語の文章で記録します(例: 「Aさんが『もう一軒行く?』と発言し、核を作り始めた」)。

### 心の声吹き出し

シミュレーション領域の各エージェントの近くに、点線枠+括弧書き(「（〜）」)の吹き出しが一時的に表示されることがあります。これが**心の声**です。

- **これは何か**: エージェントの既存の内部状態・判断・状態遷移(輪を作り始めた、輪に近づき始めた、輪に合流した、ストレスが高まってきた、離脱を決めた、離脱完了した、声をかけられたことに気づいた、等)を、観察者向けに短い一言として言語化したものです。新しい判断ロジックや発言行動を追加するものではありません。
- **これは何ではないか**: シミュレーション上の「発言」ではありません。**他のエージェントには聞こえず、認知もされません**。心の声の生成・表示が状態遷移や乱数列に影響することは一切なく、シミュレーション結果(誰が参加・離脱するか、いつグループが成立するか等)を変えることもありません。あくまで既存の内部状態を後から言語化した観察用の演出であり、実在の人物の本心を推定・断定する機能ではありません。
- **見た目の区別**: 点線の枠・本体から離れた小さな丸が連なる「しっぽ」・括弧書きの文字列という3つの特徴で、実際の発言吹き出し(Phase 2で実装。実線の枠+矢羽根しっぽ+💬アイコン)と視覚的に区別しています。オレンジ枠のobserverJoinerの心の声は、他のエージェントよりやや長く表示されます。
- **表示のタイミング**: 1エージェントにつき同時に1件まで表示されます。表示されている間に次の心の声が発生した場合は、一定時間(最短表示tick数)が経過してから新しいものに切り替わります。Start/Pauseを止めている間はtickが進まないため、心の声も進行・消滅しません。

#### 代表的な観察例

| 観察例 | 対応する心の声(例) |
| --- | --- |
| willingnessが高いのに輪へ近づけず迷う | 「行きたいけど、今入るのは少し気まずいな…」(近くに輪はあるがまだ近づいていない状態) |
| stressが上がり離脱判断へ近づく | 「まだ決まらないのか…少し疲れてきた」→「そろそろ潮時かもしれない」(ストレス比率が段階的な閾値を超えたタイミング) |
| 成立済みグループができて接近しやすくなる | 「もう決まってるグループに合流しよう」(未確定の輪ではなく成立済みグループへ近づき始めた) |
| 参加後に安心する | 「よかった、自然に入れた」(observerJoinerがグループへの合流を完了した直後) |

これらの文言はインスペクターの`attractiveness score`のように数値では見えない、その瞬間の「気持ちの動き」を短い一言で補足するものです。数値の裏付けが必要な場合は、後述のインスペクターと併用してください。

### 心の声・状態ログ・Inspectorの使い分け

3つの観察手段は目的が異なります。混同せず、知りたいことに応じて使い分けてください。

| 手段 | 役割 | 向いている使い方 |
| --- | --- | --- |
| **心の声** | 進行中の直感的な観察。今この瞬間、その人がどう感じていそうかを一言で示す演出。 | アニメーションを眺めながら、ある瞬間の「気持ちの動き」をざっくり掴みたいとき |
| **状態ログ** | 出来事の時系列確認。いつ・誰が・何をしたかを検証可能な文章として記録し続ける。 | 「いつ誰が何をしたか」を後から追う・比較したいとき(ログフィルタと併用) |
| **observerJoinerインスペクター** | 内部パラメータと判断要因の詳細確認。stress・attractiveness scoreなど数値そのものを見る。 | 「なぜその判断に至ったか」を数値的根拠まで掘り下げたいとき |

心の声は状態ログ・インスペクターが持つ数値やイベント記録を置き換えるものではなく、あくまでそれらを直感的に補助する表現です。

### 表示設定

操作パネル付近の「心の声表示」パネル(`ExpressionDisplaySettings`)で、心の声の表示を調整できます。

- **心の声を表示する(ON/OFF)**: チェックを外すと心の声の吹き出しを一切表示しません。OFFにしてもシミュレーション本体の結果・ログ・インスペクターの値は変わりません。
- **表示対象**:
  - `全エージェント` — 画面上の全員分の心の声を表示対象にする
  - `observerJoinerのみ` — observerJoinerの心の声だけに絞り込む
  - `重要イベントのみ` — 核形成・接近開始・参加・離脱開始・離脱完了・招待通知など、一度きりの出来事に基づく心の声だけに絞り込む(ストレス上昇や様子見など継続的な状況を表すものは表示対象から外れる)
- **表示密度**: `少なめ` / `標準` / `多め` の3段階。画面上に同時表示する心の声の最大件数を切り替えます(混雑時は優先度の低いものから順に表示から外れます)。

いずれの設定も、SimulationCanvasへ渡す**表示リストを絞り込むだけ**の表示層の処理です。シミュレーションのstate・ログ・終了サマリー・Monte Carlo集計には一切影響しません。

### seed再現性と非介入性

- 心の声の文言は `seed`・tick・エージェントID・発生理由から決定的に選ばれます。乱数(本体の`SeededRandom`)は一切消費しないため、**同一条件(同一seed)であれば、心の声を含めて毎回同じ内容が同じタイミングで表示されます**。
- 心の声の表示ON/OFF・表示対象・表示密度をどう変更しても、シミュレーション本体の結果(誰が参加・離脱するか、グループ成立tick等)は変わりません。表示設定は観察のしやすさだけに関わる設定です。

### Phase 1で表現していないもの

このアプリの心の声は、段階的に拡張予定のロードマップのうち**Phase 1**にあたります。現時点で表現していないものは以下のとおりです。

- **Phase 1(実装済み・本機能)**: 非介入の心の声。既存の内部状態・判断を観察者向けに言語化するだけで、他エージェントへの影響や新しい判断ロジックは持ちません。
- **Phase 2(実装済み)**: 発言イベント(`SpeechEvent`)。エージェントが実際に「発言」し、その記録が`speechLog`に蓄積され、実線+矢羽根しっぽの発言吹き出しやobserverJoinerインスペクターで確認できます。既存の「軽い声かけ」介入(下記[介入シナリオの使い方](#介入シナリオの使い方)参照)の発言もこの仕組みで記録されます。ただし、他エージェントがその発言を「聞いた」ことでstress・attractiveness・参加/離脱判断が変化することはありません(それはPhase 3の範囲)。詳しい使い方・データモデル・境界は次節[発言(SpeechEvent) — Phase 2](#発言speechevent--phase-2)を参照してください。
- **Phase 3(実装済み)**: 発言の認知・解釈・介入効果。ある発言を他エージェントが「聞いた」ことで、そのエージェントのstress・attractiveness・接近確率・離脱しきい値がどう変化するかを、決定的なモデルとして持続・減衰付きで適用します。詳しくは後述の[発言の認知・解釈・効果(Phase 3)](#発言の認知解釈効果--phase-3)を参照してください。
- **Phase 4(実装済み)**: 本心・対外表現・行動の不一致。心の声(本心)と実際の発言(対外表現)が食い違う「乖離」、その乖離の真実性・受け手ごとの信頼更新・関係性変化までを扱います。詳しくは後述の[本心・対外表現・行動の三層モデル(Phase 4)](#本心対外表現行動の三層モデル--phase-4)を参照してください。

Phase 1の心の声は、あくまで「今の内部状態をどう言語化して見せるか」の範囲にとどまり、Phase 2以降の発言・認知・乖離のロジックは持ちません。

## 発言(SpeechEvent) — Phase 2

心の声(Phase 1)とは別に、Phase 2では`SpeechEvent`(`src/simulation/speech.ts`)という「実際にエージェントが発した発言」を追加しました。両者は見た目・意味ともに区別されます。

### 心の声と発言の違い

| | 心の声(`ExpressionEvent`、Phase 1) | 発言(`SpeechEvent`、Phase 2) |
| --- | --- | --- |
| 何を表すか | 既存の内部状態・判断を観察者向けに言語化した非介入の演出 | 話者・意図・宛先を持つ、シミュレーション上で実際に発せられた発言 |
| 他エージェントへの影響 | 一切なし(誰にも聞こえない) | Phase 2時点ではまだ一切なし(記録・表示のみ。Phase 3で「聞いた」ことによる影響を追加予定) |
| 保持場所 | `SimulationState`には保持されない(表示層のみで組み立て) | `SimulationState.speechLog`に記録として蓄積される |
| 見た目 | 点線枠+括弧書き | 実線枠+矢羽根しっぽ+💬アイコン |

**重要(Phase 2の境界)**: 発言吹き出しやログに表示される発言は、他のエージェントの`stress`・`attractiveness`・参加/離脱判断には一切影響しません。「発言が見える=もう関係性が変わった」わけではなく、Phase 2は発言を生成・記録・表示できる基盤を作る段階にとどまります。この効果(発言を聞いた相手の判断が変わる)はPhase 3で扱う予定です。

### UIでの観察方法

- **発言吹き出し(SpeechBubble)**: シミュレーション領域上、発言したエージェントの近くに実線枠+矢羽根しっぽ+💬アイコン付きで一時的に表示されます。心の声の吹き出し(点線枠)とは視覚的に区別されています。
- **発言表示設定**: 操作パネル付近の「発言表示」パネル(`SpeechBubbleDisplaySettings`)で、発言吹き出しの表示ON/OFFを切り替えられます。心の声の表示設定(`ExpressionDisplaySettings`)とは独立したパネルです。OFFにしてもシミュレーション本体の結果・ログ・インスペクターの値は変わりません。
- **状態ログのフィルタ**: 状態ログ(`EventLog`)の表示フィルタに「発言のみ」があり、発言だけを抽出して確認できます。発言行は先頭に💬アイコンが付き、`intent`(誘う/歓迎/挨拶/辞退)・`reason`・`speaker`・`target`/`audience`を1行で確認できる補足行(meta)も併記されます。「全ログ」を選ぶと状態ログと発言ログがtick順に混在表示されます。
- **observerJoinerインスペクターの関連発言履歴**: `ObserverJoinerInspector`の各カード下部「関連する発言」に、そのobserverJoinerが話者(speaker)・対象(target)・周囲(audience)のいずれかとして関わった発言だけが時系列で一覧表示されます。
- **Pause / Step / Replayでの確認**: `speechLog`はtickごとに確定した記録であるため、ある時点の`SimulationState`が表す「そのtickの発言」は常に一意に決まります。Start/Pauseで止めて眺める、Stepで1tickずつ進めながら発言吹き出し・ログ・インスペクターを確認する、あるいは同一seedで最初から実行し直す(Reset)、いずれの経路でも同じtickなら同じ発言が再現されます(このアプリには過去tickへ巻き戻す専用の「Replay」ボタンはなく、Pause中の観察とStepでの逐次確認、同一seedでの再実行が実質的な「発言の確認手段」です)。

### `SpeechEvent`の主要属性

`SpeechEvent`(`src/simulation/speech.ts`)は以下のフィールドを持ちます。

| 属性 | 意味 |
| --- | --- |
| `id` | 発言を一意に識別するID(`tick`/`speakerId`/`reason`/`target`または`idSuffix`から組み立て) |
| `tick` | 発言が発生したtick |
| `speakerId` | 発言したエージェントのID |
| `intent` | 発言の分類。`invite`(誘う)/`welcome`(歓迎)/`greet`(挨拶)/`decline`(辞退)の4種 |
| `reason` | 発言が発生した構造的な理由(例: `initiativeFormedCore`核形成、`approachWelcome`歓迎、`joinGreeting`合流挨拶、`leaveDeclaration`離脱表明、`lightObserverInvitation`軽い声かけ介入 など) |
| `target` | 発言の名宛先。特定の1人に向けた発言(軽い声かけ等)の場合のみ設定(`audience`とは排他) |
| `audience` | 発言が届く範囲。周囲全体に向けた発言の場合のみ`"nearby"`が設定される(`target`とは排他) |
| `textKey` | 表示文言そのものではなく、テンプレート参照キー。実際の文言解決は`speechTemplates.ts`(UI側)の責務 |

**Phase 2時点で持たないもの**: 「到達範囲(range)」「聞こえやすさ(audibility)」「発言の強さ(strength)」に相当するフィールドは、Phase 2の`SpeechEvent`にはまだ実装されていません。`audience: "nearby"`は実座標に基づく近接判定を持たず、全エージェントを対象とみなす簡略化です。詳細は[`docs/speech-event-intervention-boundary.md`](docs/speech-event-intervention-boundary.md)の「4. Phase 3への拡張点」を参照してください。

### 発言が生成される代表的な場面 / されない条件

`SpeechEvent`は`engine.ts`内の2経路のみから生成されます(状態遷移の副産物として導出する経路、または話者がrngで選ばれるため直接生成する経路)。

代表的な生成場面:

- 主導者または既存グループ(clique)が核を作り始めたとき(`initiativeFormedCore`/`cliqueFormedCore`、`invite`)
- 既にできかけの核へ新たな1人が加わったとき、founderが重ねて誘う(`formingGroupRecruitment`、`invite`)
- undecidedの人がforming/confirmedな輪へ接近を始めたとき、その輪の代表が歓迎する(`approachWelcome`、`welcome`)
- 誰かが輪・グループへ合流を完了したとき、本人が挨拶する(`joinGreeting`、`greet`)
- 誰かが曖昧な時間に耐えられず離脱を始めたとき、本人が辞退・帰宅を表明する(`leaveDeclaration`、`decline`)
- 介入シナリオ「observerJoinerへの軽い声かけ」が発動したとき(`lightObserverInvitation`、`invite`。詳しくは次項参照)

生成されない代表的な条件:

- undecidedのまま状態が変わらずに様子見を続けているtick(接近も離脱も核形成もしていない)
- 既にapproaching/forming/joined/leaving状態のエージェントが、状態を変えずに移動しているだけのtick
- 輪が解散(dissolving/expired)するとき(現時点のreasonカタログに対応する発言は定義されていない)
- 介入シナリオが「介入なし」、または「軽い声かけ」以外の介入が選ばれているとき(軽い声かけ以外の介入は`SpeechEvent`を生成しない)

### 再現性・非介入性

- 発言の内容は`tick`・`speakerId`・`reason`などシミュレーション状態から決定的に組み立てられます。**同一seed・同一パラメータであれば、`speechLog`の件数・内容・順序が毎回完全に一致します**(`speechReproducibility.test.ts`で全プリセットについて検証)。
- `createSpeechEvent`/`deriveSpeechEvents`はどちらも`SimulationState`・他エージェント・乱数(`SeededRandom`)のいずれも参照/変更しない純粋関数です。発言の生成自体が乱数を消費したり状態を書き換えたりすることはありません。
- 発言吹き出しの表示ON/OFF(「発言表示」設定)を変更しても、シミュレーション本体の結果(誰が参加・離脱するか、グループ成立tick等)・状態ログ・インスペクターの値は一切変わりません。これは心の声の表示設定と同じ非介入の保証です(`speechBubbleNonInterference.test.ts`で検証)。

### 既存の「軽い声かけ介入」との関係

介入シナリオ「observerJoinerへの軽い声かけ」(`light-observer-invitation`)は、Phase 2以前から存在する既存の介入で、`agent.invitedAtTick`を直接設定してobserverJoinerの`influenceAvoidance`の壁を緩和し、接近確率を上げ、追加ストレスを軽減する、という**シミュレーション本体の状態遷移そのものを変更する効果**を持ちます。

Phase 2ではこの「声かけ」という出来事を`reason: "lightObserverInvitation"`の`SpeechEvent`としても記録・表示するようにしましたが、これは既存の効果メカニズムに変更を加えるものではありません。`SpeechEvent`自体は「声かけが発生した」という事実を記録するだけで、効果の発生・強さには一切関与しません。両者の詳しい概念対応・責務境界は[`docs/speech-event-intervention-boundary.md`](docs/speech-event-intervention-boundary.md)にまとめています。

**Phase 3導入後の重要な注意(二重効果)**: Phase 3では`reason: "lightObserverInvitation"`の`SpeechEvent`も他の発言と全く同じパイプライン(認知→解釈→効果)を通ります。そのため、observerJoinerへの軽い声かけが発生すると、次の2つの効果が**独立に・同時に**重なって作用します。どちらか一方だけが効くわけではなく、両方が別経路で加算される設計です。

1. **既存の介入効果**(`agent.invitedAtTick`/`isUnderLightInvitationBoost`経由、変更なし): 接近確率に`LIGHT_INVITATION_APPROACH_MULTIPLIER`(1.6倍)を乗算、`influenceAvoidance`の壁を緩和、追加ストレスを軽減。
2. **Phase 3の発言効果**(`intent: "invite"` → `approachProbability`次元、他のinvite発言と同じ扱い): 声をかけられた本人(`target`)に対して接近確率へ`+0.25`(5tick、線形減衰)を加算。

両者は適用箇所(1は乗算・influenceAvoidance残差・ストレス倍率、2は接近確率への加算値)が異なるため単純な二重カウントではありませんが、「軽い声かけ」1回の出来事から2つの独立した後押し効果が発生する点は、介入の効き目を解釈する際に注意してください。詳しくは後述の[発言の認知・解釈・効果(Phase 3)](#発言の認知解釈効果--phase-3)を参照してください。

### Phase 3以降との境界

- **Phase 2(実装済み・本機能)**: 発言の生成・記録・表示。他エージェントが発言を「聞いた」ことによる状態変化は一切持たない。
- **Phase 3(実装済み)**: 発言の認知・解釈・介入効果。ある発言を他エージェントが聞いたことで、そのエージェントの`stress`・`attractiveness`・接近確率・離脱しきい値がどう変化するかのモデル化。詳しくは[発言の認知・解釈・効果(Phase 3)](#発言の認知解釈効果--phase-3)を参照。
- **Phase 4(実装済み)**: 本心・対外表現・行動の不一致。ここでいう`SpeechEvent`(発言)は「対外表現」層が実際に発せられたものにあたり、その裏にある「本心」との乖離、乖離発言の真実性、受け手ごとの信頼更新、関係性変化までを扱う。詳しくは[本心・対外表現・行動の三層モデル(Phase 4)](#本心対外表現行動の三層モデル--phase-4)を参照。

README・UI上に表示される発言は、Phase 2時点では見えるだけで誰にも効果を及ぼしませんでしたが、**Phase 3では実際に受け手の判断へ影響します**(デフォルトで有効)。詳細・注意点は次節を参照してください。Phase 4を有効にすると、この発言自体が本心とは異なる「対外表現」として生成されうる点にも注意してください(次々節参照)。

### PC/iPhoneでの操作上の注意点

発言吹き出し・発言表示設定・ログの「発言のみ」フィルタ・インスペクターの関連発言履歴は、いずれもPC/iPhoneで機能差はありません。「発言表示」パネル(`SpeechBubbleDisplaySettings`)は、心の声の表示設定と同様にモバイル時もスライダー群のような折りたたみ対象にはならず、常に表示されます(モバイルで折りたたまれるのは操作パネルのパラメータスライダー部分のみ)。iPhoneでの起動方法自体は前述の[3つの起動・利用方法の使い分け](#3つの起動・利用方法の使い分け)を参照してください。

### 開発者向けの主要ファイル

| 関心 | ファイル |
| --- | --- |
| `SpeechEvent`の型・生成関数 | `src/simulation/speech.ts` |
| 生成呼び出し(engine内の2経路) | `src/simulation/engine.ts` |
| 既存の「軽い声かけ介入」定義 | `src/simulation/interventions.ts` |
| `speechLog`を持つ状態の型 | `src/simulation/types.ts`(`SimulationState.speechLog`/`SpeechRelation`/`ObserverSpeechHistoryEntry`) |
| 表示文言のテンプレート解決 | `src/simulation/speechTemplates.ts` |
| observerJoiner向け関連発言の抽出 | `src/simulation/inspection.ts` |
| 発言吹き出しの寿命・競合制御 | `src/simulation/activeSpeechBubbles.ts` |
| 発言吹き出し(SVG描画) | `src/components/SpeechBubble.tsx` / `src/components/SimulationCanvas.tsx` |
| 発言表示設定パネル | `src/components/SpeechBubbleDisplaySettings.tsx` / `src/components/speechBubbleDisplayFilter.ts` |
| ログ・インスペクター向け表示文組み立て | `src/components/speechDisplay.ts` |
| tickごとの表示駆動フック | `src/hooks/useActiveSpeechBubbles.ts` |
| 再現性・非介入性・生成条件のテスト | `src/simulation/speechReproducibility.test.ts` / `speechGeneration.test.ts` / `speech.test.ts` / `speechBubbleNonInterference.test.ts` |
| 既存介入との概念対応・責務境界の設計文書 | `docs/speech-event-intervention-boundary.md` |

## 発言の認知・解釈・効果 — Phase 3

Phase 2までの`SpeechEvent`は「生成・記録・表示されるだけで、誰にも効果を及ぼさない」観察用の記録でした。Phase 3では、ある発言を他エージェントが実際に「聞いた」ことで、その受け手の`stress`・`attractiveness`・接近確率・離脱しきい値が変化する**介入イベント**へと拡張します。デフォルトで有効(ON)です。

**重要な注意(モデル仮説であり診断ではない)**:

- これは決定論的なモデル仮説であり、現実の個人の心理状態を診断・断定するものではありません。
- 「信頼」(話者への基礎信頼)はPhase 3では既存関係性(同一clique/`existingTieStrength`)から一意に導出する固定値であり、発言を重ねても学習・変化しません。
- 指標の差(後述のON/OFF比較を含む)は統計的有意差や現実の効果量を示すものではありません。実行回数が少ないと偶然に大きく左右されます。
- 本心/建前の不一致や発言の真実性判定(「言っていることと感じていることが食い違う」表現)はPhase 4の範囲であり、Phase 3では扱いません。

### 全体の流れ: 心の声・SpeechEvent・認知・解釈・active effect・状態遷移の関係

```
心の声(ExpressionEvent)  … 非介入の演出。誰にも聞こえず、以下のパイプラインには一切関与しない

SpeechEvent(発言)
  └─(1. 認知: deriveSpeechReceptions)──▶ SpeechReceptionEvent(聞こえたか/聞こえなかったか)
        └─(2. 解釈: deriveSpeechInterpretations)──▶ SpeechInterpretationEvent(どれだけ・どの方向で受け止めたか)
              └─(3. 効果登録: deriveSpeechEffects → deriveSpeechActiveEffects)──▶ SpeechEffectEvent(構造化記録) / SpeechActiveEffect(実際に効く持続効果)
                    └─(4. 次tick以降: engine.tsの各計算式)──▶ stress増分・attractiveness・接近確率・leave判定への加算
```

- 1〜3はすべて`SimulationState`・他エージェント・`SeededRandom`のいずれも参照/変更しない純粋関数です。発言の認知・解釈・効果登録それ自体が乱数を消費したり状態を書き換えたりすることはありません。
- **あるtickに生成された発言の効果は、そのtick自身の意思決定には使われず、次tick以降で初めて参照されます**(`stepSimulation`冒頭で前tickまでの効果を減衰させてから、その回の接近・stress・leave判定に使う設計)。
- 心の声は今まで通りこのパイプラインの外側にあり、SpeechEventにも効果にも一切影響しません。

### 1. 認知(`deriveSpeechReceptions`)

`SpeechEvent`ごとに、対象になりうる受け手全員について「聞こえたか」を判定し`SpeechReceptionEvent`を記録します。

- **候補の決定**: 話者自身と`state === "left"`のエージェントはそもそも候補から除外されます(記録自体が作られません)。`target`が設定されている発言はその1人だけが候補になり、`audience: "nearby"`の発言は残り全員が候補になります(圏外で聞こえなかった人も`heard: false`として記録されるため、後から「誰が・なぜ聞こえなかったか」を追跡できます)。
- **発言時点の位置**: `SpeechEvent`は発言が生成された瞬間の話者位置を`originX`/`originY`としてスナップショット保持します。発言後に話者が移動しても、この距離判定には影響しません。
- **range / strength / audibility**: `range`(基礎到達距離、既定`200`)と`strength`(発言の強さ・`range`への倍率、既定`1`)から、生成時に`audibility = range * strength`を一度だけ計算し固定します。既存介入「軽い声かけ」(`reason: "lightObserverInvitation"`)だけはワールド対角線(約`954`)より広い専用range(約`1004`)を持ち、`selectInvitationAgent`が遠方のobserverJoinerにフォールバックしても声かけが必ず届くようにしています。
- **判定式**: `distance = Math.hypot(originX - receiver.x, originY - receiver.y)`、`heard = distance <= audibility`(閾値ちょうどは「聞こえた」側)。
- **聞こえなかった場合**: `heard: false`の`SpeechReceptionEvent`が`reason: "outOfRange"`とともに記録されます(名指し=`target`だからといって必ず`heard: true`になるわけではありません)。以降の解釈(2.)はこのレコードを対象から除外します。

### 2. 受け手別解釈(`deriveSpeechInterpretations`)

`heard: true`のレコードごとに、受け手の性格・関係性・現在状態から、その発言をどれだけ・どの方向で受け止めたか(`intensity` / `valence`)を決定的に計算します。

```
intensity = clamp(magnitude(intent) × conformity係数 × influenceAvoidance係数 × 話者への基礎信頼 × stress係数 × state関連度 × relation係数 × strength係数, 0, 1)
```

| 要因 | 効果の向き |
| --- | --- |
| `conformity` | 高いほど場の方向性を強く受け止める(`0.5 + 0.5 × conformity`) |
| `influenceAvoidance` | 高いほど弱く受け止める。名指し(`target`)されるほど減衰が大きい(`target`側の重み0.6、`nearby`側0.25) |
| clique / `existingTieStrength`(話者への基礎信頼) | 同一cliqueなら既存関係性が強いほど信頼が上がる(`0.5 + 0.5 × tie`)。別cliqueなら既存関係性が強い場ほど部外者への基礎信頼が下がる(`0.5 - 0.4 × tie`) — `attractiveness()`のoutsiderPenaltyと同じ非対称性 |
| `stress` / `state` | 現在のstressが高いほど正方向の発言を素直に受け止めにくく(`1 - stress × 0.4`)、負方向の発言をより強く受け止めてしまう(`1 + stress × 0.5`)。すでに決着へ進んでいる`state`ほど関連度が下がる(`undecided: 1` 〜 `left: 0`) |
| `target` / `nearby`(relation) | 名指しされた発言は周囲向けより強く受け止められる(`target: 1.0`, `nearby: 0.7`) |
| `SpeechEvent.strength` | そのまま倍率として使う(`[0, 2]`にclamp) |

intentごとの基礎方向・基礎magnitude(他要因で減衰する前の上限値)は次の通りです。

| intent | 方向 | 基礎magnitude |
| --- | --- | --- |
| invite(誘う) | 正 | 0.6 |
| welcome(歓迎) | 正 | 0.6 |
| greet(挨拶) | 正 | 0.35 |
| decline(辞退) | 負 | 0.5 |

`intensity`が`0.05`未満まで弱まった場合は、基礎方向によらず`valence: "neutral"`(「ほぼ何も感じなかった」)として扱われ、効果(3.)は生成されません。`SpeechInterpretationEvent.factors`には各要因の生値・正規化値・寄与係数が固定順で残るため、「なぜその強度になったか」をどのイベントからでも遡って説明できます。

### 3. 効果のdimension・持続時間・減衰・競合/上限

**intentごとの作用対象・方向・基礎強度・持続tick数(固定)**:

| intent | dimension | 作用対象 | 方向 | 基礎強度(intensity=1時) | 持続tick |
| --- | --- | --- | --- | --- | --- |
| invite | `approachProbability`(接近確率) | 発言を聞いた周囲のundecided全員 | 正: 接近確率を後押し | 0.25 | 5 |
| welcome | `attractiveness`(魅力度) | 受け手が今近づいている輪 | 正: その輪の魅力度を後押し | 0.35 | 8 |
| greet | `stress`(ストレス蓄積率) | 発言を聞いた周囲のundecided全員 | 正の発言ほどstress蓄積率を緩和(符号反転) | 0.03 | 6 |
| decline | `leaveThreshold`(離脱しきい値) | 発言を聞いた周囲のundecided全員 | 負: 実効leaveThresholdを引き下げ、離脱の伝染を後押し | 0.15 | 10 |

`willingness`/`conformity`/`influenceAvoidance`等の性格値、および`agent.leaveThreshold`本体は一切変更されません。常に一時的な補正(`SpeechActiveEffect`)として計算式に加算されるだけです。

**減衰式(線形固定)**:

```
remaining(tick) = clamp(1 - (tick - startedAtTick) / (expiresAtTick - startedAtTick), 0, 1)
strength(tick)  = initialStrength × remaining(tick)
```

`tick >= expiresAtTick`では常に0。`tick`のみに依存する純粋関数でrngは使いません。

**複数発言の競合・上限(`aggregateActiveEffects`)**: 同一受け手・同一dimension(`attractiveness`のみ同一対象グループも含む)の効果をまとめて集約します。

- 上限付き加算: 正方向・負方向それぞれを独立に合計し、`基礎強度 × 3`(例: `approachProbability`なら`0.75`、`attractiveness`は`1.05`、`stress`は`0.09`、`leaveThreshold`は`0.45`)でclampします。
- net化: clamp後の正負合計を単純加算して最終値にしますが、どちらの方向にどの発言が効いていたかという内訳(`positiveContributions`/`negativeContributions`)はそのまま保持され、遡って説明できます。
- 同一`speechEventId`の重複適用は禁止: 同じ発言由来の効果が複数一致しても最初の1件のみを数え、以降は`duplicateContributions`に分離します。
- 同一話者・同一intentの再発言は置換(更新): 新しい効果は、同じ受け手・dimension・話者・intentの既存効果を置き換えます(cooldownではなく「常に最新の発言が効く」という単純な規則)。話者やintentが異なる複数の発言は置換対象にならず、通常通り上限付き加算・net化の対象になります。

### 4. engineのtick順序

```
1. SpeechEvent生成(このtick)
2. 認知    deriveSpeechReceptions
3. 解釈    deriveSpeechInterpretations
4. 効果登録 deriveSpeechEffects → deriveSpeechActiveEffects → nextState.activeSpeechEffectsへ登録
5. 状態・行動判断への参照(※次tick以降。advanceActiveSpeechEffectsで減衰させた値を接近・ストレス蓄積・leave判定が読む)
6. 期限切れ効果の破棄(advanceActiveSpeechEffects、tick >= expiresAtTickのものを除去)
```

`engine.ts`内の適用箇所は4つです: 接近確率(`clamp(..., 0, 0.9)`する直前に加算)・`attractiveness()`(対象グループが一致する場合のみ加算)・stress蓄積の増分(負値になり増分を打ち消す方向)・leave判定の実効しきい値(`stress > leaveThreshold + 加算値`)。

### 状態ログ・observerJoiner Inspectorで因果を追う

- **状態ログ(`EventLog`)**: フィルタに「発言効果のみ」を追加しました。選ぶと解釈イベント(`SpeechInterpretationEvent`)・効果イベント(`SpeechEffectEvent`)がtick順に一覧表示されます。「発言のみ」フィルタ(SpeechEvent自体)と組み合わせて、ある発言→その解釈→その効果、という流れを時系列で追えます。
- **observerJoinerインスペクター(`ObserverJoinerInspector`)**:
  - 各カードの「関連する発言」の各行に「発言効果の詳細」という折りたたみがあり、その発言がそのobserverJoinerにとって認知されたか(`SpeechReceptionEvent`)・どう解釈されたか(`SpeechInterpretationEvent`)・どんな効果が登録されたか(`SpeechEffectEvent`)を段階ごとに表示します。認知されなかった場合は非認知理由(圏外など)、解釈が中立だった場合はその旨を明示します。
  - 「現在作用中の発言効果」に、dimensionごとの集約値(`AggregatedActiveEffect`)と、正方向・負方向・重複・不採用の個別寄与(どの発言由来か)が一覧表示されます。
  - `attractiveness(適用後)`の下に`attractiveness(適用前)`と「うち発言効果による補正」が表示されるカード(効果が0でない場合のみ)があり、発言効果がスコアをどれだけ動かしたかを数値で確認できます。

### 発言効果ON/OFFのpaired Monte Carlo比較

画面左側の「発言効果ON/OFFの比較」パネル(`SpeechEffectsComparisonPanel`)で、現在のプリセット・パラメータ・介入シナリオ・baseSeedを固定したまま、Phase 3発言効果だけをOFF(`enabled: false`)/ON(`enabled: true`)で切り替えて同じseed列でMonte Carloを2回実行し、run単位で対応付けて比較します。

**操作方法**: 1) プリセット・パラメータ・介入シナリオ・seedを設定する → 2) 実行回数(1〜100回)を指定する → 3) 「発言効果OFF/ONを比較して実行」を押す。既存の「介入あり/なし比較」(`InterventionComparisonPanel`)とは独立したパネルで、比較する軸(介入の有無 / 発言効果の有無)が異なります。

**paired比較が成立する理由**: 認知(距離としきい値)・解釈(性格・関係性・現在状態からの決定的な計算)・効果生成のいずれもrngを一切使わないため、`enabled`をfalse/trueのどちらにしても`SeededRandom`が消費される順序・回数は完全に同じになります。つまりOFF/ON同じseedのrunは、Phase 3効果が実際に計算式へ加算されるかどうかだけが異なり、それ以外の乱数選択(誰が接近するか等)は同一列をたどります。

**指標の読み方**: 既存指標(observerJoiner参加率・離脱率・グループ不成立率・平均グループ成立tick・後乗り成功率・平均参加人数・平均帰宅人数)に加え、Phase 3固有指標が並びます。

- **observerJoiner発言認知率**: observerJoinerが1件以上の発言を認知(`heard: true`)したrunの割合。
- **解釈/効果が発生したrun率**: 中立でない解釈、または効果が1件以上発生したrunの割合。
- **状態遷移へ発言効果が寄与したrun率**: 効果の有効期間内に対応する状態遷移イベント(`observerApproached`/`observerJoinedForming`・`observerJoinedConfirmed`/`observerLeaveStarted`)が発生したかを見る近似的なヒューリスティックです。`stress`次元(`greet`由来)は「その分だけ離脱しなかった」という非イベントにしか現れないため、この判定からは除外されています(常に寄与なし側)。反実仮想的な厳密検証(効果を無効化した場合の再実行比較)ではない点に注意してください。
- **平均累積補正(dimensionごと)**: `SpeechEffectEvent.outputValue`の絶対値のrun平均で、効果の強さの目安です。

解釈上の注意は既存のMonte Carlo比較と同様です: 実行回数が少ないと偶然に大きく左右されるため、傾向として読みたい場合はある程度の実行回数で確認してください。指標の差が偶然か効果によるものかを判定する統計的検定・信頼区間の算出は行っていません。

### 既存介入シナリオとの関係

Phase 3の発言効果は、6つの介入シナリオすべてに対して同じように適用されます(介入固有の特別扱いはありません)。ただし「observerJoinerへの軽い声かけ」(`light-observer-invitation`)だけは、既存の直接効果メカニズム(`isUnderLightInvitationBoost`)と同一tick・同一発言から二重に効果が発生します。詳しくは前掲の[既存の「軽い声かけ介入」との関係](#既存の軽い声かけ介入との関係)の「Phase 3導入後の重要な注意(二重効果)」を参照してください。

### 開発者向けの主要ファイル

| 関心 | ファイル |
| --- | --- |
| `SpeechReceptionEvent`/`SpeechInterpretationEvent`/`SpeechEffectEvent`/`SpeechActiveEffect`の型・生成関数・集約/登録関数 | `src/simulation/speechEffects.ts` |
| 3段パイプラインのengine結線・tick順序・4箇所の適用先 | `src/simulation/engine.ts`(`stepSimulation`) |
| `SpeechEffectsConfig`/`activeSpeechEffects`等を持つ状態の型 | `src/simulation/types.ts` |
| インスペクター向けの認知/解釈/効果詳細・集約サマリーの組み立て | `src/simulation/inspection.ts`(`buildObserverJoinerInspection`) |
| インスペクターの因果表示・active effectサマリー表示 | `src/components/ObserverJoinerInspector.tsx` / `src/components/speechEffectsDisplay.ts` |
| 状態ログの「発言効果のみ」フィルタ | `src/components/EventLog.tsx` |
| 発言効果ON/OFF paired Monte Carlo比較のロジック・UI | `src/simulation/speechEffectsMonteCarlo.ts` / `src/components/SpeechEffectsComparisonPanel.tsx` |
| Phase 3固有指標(runサマリー)の集計 | `src/simulation/summary.ts`(`buildSpeechEffectsRunSummary`) |
| 型・パイプライン境界・engine結線・距離モデル・解釈モデル・適用モデル・集約モデル・paired比較のテスト | `src/simulation/speechEffects.test.ts` / `speechEffectsWiring.test.ts` / `speechEffectsReproducibility.test.ts` / `speechEffectsMonteCarlo.test.ts` |
| 設計文書(責務境界・距離モデル・解釈モデル・適用モデル・集約モデル・paired比較) | `docs/speech-effects-phase3-boundary.md` / `docs/speech-reception-distance-model.md` / `docs/speech-interpretation-model.md` / `docs/speech-effects-application-model.md` / `docs/speech-effects-aggregation-model.md` / `docs/speech-effects-paired-monte-carlo.md` |

## 本心・対外表現・行動の三層モデル — Phase 4

Phase 3までは、`SpeechEvent`(発言)がそのまま「実際に起きたこと」の唯一の記録でした。Phase 4では、その発言の裏側にある**本心(privateEvaluation)**と、実際に外へ発せられる**対外表現(publicExpression)**を分離し、両者が「遠慮」「同調圧力」「印象管理(社交辞令)」によって食い違う場合(**乖離**)を表現します。さらに、その乖離した発言がどれだけ「本心に忠実だったか(真実性)」、それを聞いた相手の話者への**信頼(trust)**がどう動くか、発言と実際の行動の整合性が積み重なって**関係性(tie)**そのものをどう変えるかまでを扱います。デフォルトで有効(画面上は常にON)です。

**重要な注意(観察可能なモデル仮説であり、現実の人間を断定的に分類するものではない)**:

- 乖離・真実性・信頼更新・関係性変化のいずれも、既存のpersonalityパラメータ・関係性(clique/`existingTieStrength`)・現在の場の状態から決定的に導出される**観察用のモデル仮説**です。現実の個人の本心・性格・人間関係を診断・断定するものではありません。
- 「この人は遠慮するタイプ」「この人は社交辞令を言うタイプ」のように、現実の人間を型に断定的に分類する機能ではありません。あくまでシミュレーション内のエージェントについて、既存の判断式のどの入力がどう寄与して乖離が起きたか(要因内訳)を、後から遡って説明できるようにするための仕組みです。
- 信頼(trust)・関係性(tie)の数値化は、シミュレーション内の判断式を透明にするための表現であり、現実の会話における「信頼度」や「親密さ」を測定・診断する心理テストではありません。
- 指標の差(後述のpaired Monte Carlo比較を含む)は統計的有意差や現実の効果量を示すものではありません。実行回数が少ないと偶然に大きく左右されます。

### 三層の概要と対応する既存概念

| 層 | 型 | 何を表すか | 対応する既存概念 |
| --- | --- | --- | --- |
| 本心(`PrivateEvaluation`) | `socialExpression.ts` | エージェント内部の評価。`willingness`・leave判定・`attractiveness()`など既存の判断式の入力・中間値をそのまま写しとった観察用スナップショット。他エージェントには一切認知されない | Phase 1の心の声(`ExpressionEvent`)は本心側を観察者向けに言語化した演出 |
| 対外表現(`PublicExpression`) | `socialExpression.ts` | 対外的に表現される立場。遠慮・同調圧力・印象管理の3要因で本心から決定的に乖離しうる | Phase 2の発言(`SpeechEvent`)は対外表現側が実際の発言として観測されたもの |
| 行動(actualAction) | 新しい型は導入しない | 実際にどう動いたか(状態遷移・移動そのもの) | 既存の`AgentState`遷移・`engine.ts`の状態遷移ロジック |

本心→対外表現の乖離は3要因(`PublicExpressionFactorKey`)から決定的に計算されます。personality基礎値(`willingness`/`conformity`/`influenceAvoidance`など)そのものは一切変更されません。

| 要因 | 作用次元 | 内容 |
| --- | --- | --- |
| 遠慮・拒否回避(`reserve`) | 参加意欲 | `influenceAvoidance`が高いほど、本心が積極的(中立0.5超)なぶんだけ表明を弱める(無表明までが上限で、積極→消極への反転はしない) |
| 同調圧力(`conformityPressure`) | 参加意欲 | `conformity`が高いほど、可聴範囲内の多数派の方向(forming/approaching/joined優勢か、undecided/leaving優勢か)に表明が引っ張られる |
| 印象管理・社交辞令(`impressionManagement`) | 離脱傾向 | 可聴範囲内に近い関係(同一clique)の相手がいるほど、本心の離脱傾向の表明を緩和する(0未満へは反転しない) |

3要因の計算式・clamp規則・データ構造の詳細は[`docs/social-expression-phase4-boundary.md`](docs/social-expression-phase4-boundary.md)を参照してください。

### 使い方(有効化・観察の入口)

- **UIでの有効化**: 画面(`App.tsx`)では、Phase 3の発言効果とあわせてPhase 4の3設定(三層モデル・信頼更新・関係性変化)がすべて**デフォルトでON固定**です。個別に切り替えるUIトグルはなく、常時観察できます。
- **プログラム的な有効化**: `createInitialState`/`stepSimulation`(`src/simulation/engine.ts`)は、Phase 3の`speechEffects`に続けて`socialExpression`・`speechTrust`・`relationshipTie`の3つの`Partial<...Config>`引数を受け取ります。いずれも既定値は`enabled: false`(後方互換)で、UI側が明示的に`{ enabled: true }`を渡すことで有効化しています。信頼更新・関係性変化はPhase 3の認知記録(`SpeechReceptionEvent`)が前提のため、`speechEffects`を無効にしたまま`speechTrust`/`relationshipTie`だけ有効にしても観測は発生しません。
- **観察の入口**:
  - **observerJoinerインスペクターの「本心 / 建前」セクション**: 現在tickの参加意欲・離脱傾向を本心→対外表現の順で表示し、乖離がある場合は「⚠ 乖離あり」と要因内訳(遠慮/同調圧力/印象管理)を折りたたみ表示します。
  - **インスペクターの「話者ごとの信頼(trust)」**: 受け手→話者pairごとの現在trust値と、更新履歴(一致/不一致・観測した状態遷移・変化量)を確認できます。
  - **状態ログのフィルタ**: 「乖離発言のみ」(本心と異なる建前で発言したイベント)・「信頼更新のみ」・「関係性変化のみ」が追加されています。
  - **心の声(本心)と発言吹き出し(建前)の見比べ**: 乖離場面(遠慮による軟化・建前の歓迎・社交辞令の辞退)では、心の声と発言吹き出しがシナリオプリセット・アーキタイプ(observerJoiner/designatedLeader/cliqueMember/general)ごとに異なる対の文言(`DivergencePair`)から決定的に選ばれて表示されるため、同一tick・同一エージェントで本心と建前の言葉の違いを直接見比べられます。

### 観察観点

| 観点 | 何を見るか | 参照ドキュメント |
| --- | --- | --- |
| 乖離(divergence) | 本心(`privateStance`)と対外表現(`expressedStance`)がどの要因(遠慮/同調圧力/印象管理)でどれだけずれたか。observerJoinerの典型は「本心=積極的(参加希望)・対外表現=無表明」 | [`docs/social-expression-phase4-boundary.md`](docs/social-expression-phase4-boundary.md) |
| 真実性(truthfulness) | 乖離した発言が本心にどれだけ忠実だったか(0〜1、乖離なしは常に1)。intentが置換された発言ほど値が下がる | [`docs/speech-trust-model.md`](docs/speech-trust-model.md) |
| 信頼更新(trust) | 発言intentとその後の話者の行動が一致/不一致だったのを受け手が観測するたびに動く、受け手→話者pair単位の動的信頼値(一致は小さく上げ、不一致は大きく下げる非対称) | [`docs/speech-trust-model.md`](docs/speech-trust-model.md) |
| 関係性変化(relationship tie) | 整合性の観測が積み重なった履歴から導かれる、`attractiveness()`の同clique bonus/outsiderペナルティや発言の解釈への補正 | [`docs/relationship-tie-model.md`](docs/relationship-tie-model.md) |
| シナリオ別・性格別の表現テンプレート | 乖離場面の本心/建前の文言が、プリセット・アーキタイプごとにどう変わるか(表示専用、シミュレーション結果には非干渉) | [`docs/divergence-templates-model.md`](docs/divergence-templates-model.md) |

### 検証方法: paired Monte Carlo

Phase 3の発言効果には画面上の比較パネル(`SpeechEffectsComparisonPanel`)がありますが、Phase 4には現時点で対応するUIパネルはありません。Phase 4の効果を確認するには、`src/simulation/phase4MonteCarlo.ts`の`runPhase4MonteCarlo`/`comparePhase4Model`をNode実行(`vitest`経由のスクリプトや一時テストなど)から直接呼び出します。

- **paired比較が成立する理由**: `socialExpression.ts`/`speechTrust.ts`/`relationshipTie.ts`の導出関数はいずれも乱数(`SeededRandom`)を一切読み取らないため、Phase 4の3設定をOFF/ONのどちらにしても`SeededRandom`の消費順序は完全に同じになります。OFF/ON同じseedのrunは、Phase 4の判定・補正が実際に計算式(発言intent選択・解釈のtrust/関係性係数・attractivenessのtie補正)へ加算されるかどうかだけが異なります。
- **`comparePhase4Model`が返す指標**: 既存指標(observerJoiner参加率・離脱率・グループ不成立率・平均グループ成立tick・後乗り成功率・平均参加人数・平均帰宅人数)に加え、Phase 4固有指標(平均乖離発言数・平均対外表現発言数・平均信頼変化量・平均関係性変化量)が、条件間の差分として得られます。
- **5プリセットでの実行結果**: [`docs/phase4-preset-contrast-verification.md`](docs/phase4-preset-contrast-verification.md)に、`App.tsx`のデフォルトと同じ条件(Phase 3/4全機能ON)で5プリセットそれぞれを複数seed実行した結果と、Phase 4導入前後でプリセット間のコントラスト(特にプリセット5のobserverJoiner孤立)が維持されていることの確認結果を記録しています。
- **受入・回帰テスト**: `src/simulation/phase4Acceptance.test.ts`に、config OFF時の従来互換性・全機能ON時の再現性・乖離要因からtrust/関係性更新までの因果追跡・数値安全性・プリセット5のobserverJoiner孤立維持を確認するテストがあります。

**解釈上の注意**は既存のMonte Carlo比較(Phase 3含む)と同様です。実行回数が少ないと偶然に大きく左右されるため、統計的検定・信頼区間の算出は行っていません。判断は利用者に委ねられています。

### 開発者向けの主要ファイル

| 関心 | ファイル |
| --- | --- |
| 本心/対外表現の型・導出関数(乖離判定) | `src/simulation/socialExpression.ts` |
| 発言の真実性評価・受け手ごとの動的信頼更新 | `src/simulation/speechTrust.ts` |
| 整合性履歴に基づく関係性(tie)補正 | `src/simulation/relationshipTie.ts` |
| シナリオ別・性格別の本心/建前表現テンプレート(表示専用) | `src/simulation/divergenceTemplates.ts` |
| Phase 4 paired Monte Carlo比較ロジック | `src/simulation/phase4MonteCarlo.ts` |
| `socialExpressionEnabled`/`speechTrustEnabled`/`relationshipTieEnabled`等を持つ状態の型 | `src/simulation/types.ts` |
| engine結線(発言生成後の乖離調整・trust観測・関係性観測・tick順序) | `src/simulation/engine.ts`(`stepSimulation`) |
| インスペクター向けの本心/建前・信頼サマリーの組み立て | `src/simulation/inspection.ts`(`buildObserverJoinerInspection`) |
| インスペクターの本心/建前・信頼更新表示 | `src/components/ObserverJoinerInspector.tsx` |
| 状態ログの「乖離発言のみ」「信頼更新のみ」「関係性変化のみ」フィルタ | `src/components/EventLog.tsx` |
| 型・境界・乖離判定・真実性/信頼モデル・関係性モデル・テンプレート・プリセットコントラスト検証のテスト | `src/simulation/socialExpression.test.ts` / `socialExpressionSpeech.test.ts` / `speechTrust.test.ts` / `relationshipTie.test.ts` / `divergenceTemplates.test.ts` / `inspectionPhase4.test.ts` / `phase4MonteCarlo.test.ts` / `phase4Acceptance.test.ts` |
| 設計文書(三層モデルの土台・乖離判定・発言生成統合・真実性/信頼モデル・関係性モデル・表現テンプレート・プリセットコントラスト検証) | [`docs/social-expression-phase4-boundary.md`](docs/social-expression-phase4-boundary.md) / [`docs/speech-trust-model.md`](docs/speech-trust-model.md) / [`docs/relationship-tie-model.md`](docs/relationship-tie-model.md) / [`docs/divergence-templates-model.md`](docs/divergence-templates-model.md) / [`docs/phase4-preset-contrast-verification.md`](docs/phase4-preset-contrast-verification.md) |

## 観察機能(Phase A)

「誰が」「なぜ」参加・離脱するのかを外から追いやすくするため、observerJoiner専用のインスペクターと、状態ログのフィルタリング機能があります。単なる画面の操作説明ではなく、**非公式なグループ形成の過程を読み解くための道具**として使ってください。

### observerJoinerインスペクター

シミュレーション領域の下に、画面上のobserverJoiner全員分のカードが並びます。各カードは次の項目を表示します。

| 項目 | 意味 |
| --- | --- |
| `state` | そのobserverJoinerの現在の状態(未定 / 輪を形成中 / 接近中 / 参加済み / 離脱中 / 離脱済み)。 |
| `stress` | 曖昧な時間にどれだけ耐えているかの蓄積度。100%に近いほど限界が近い。 |
| `willingness` | 二次会そのものへの参加意欲。高いほど本来は参加したい人。 |
| `ambiguityTolerance` | 曖昧な状態(輪が形成される前)にどれだけ耐えられるか。低いほどストレスが早く溜まる。 |
| `influenceAvoidance` | 自分から場を動かすことへの抵抗感。高いほど自分から輪に飛び込みにくい。 |
| `leaveThreshold` | ストレスがこの値を超えると離脱(帰宅方向)に転じる、そのしきい値。 |
| 離脱までの余裕(`leaveThreshold - stress`) | 離脱までどれだけ余裕があるかの目安。0%に近い、または警告表示(⚠ 離脱間近)が出ている場合、次の数tickで離脱に転じる可能性が高い。 |
| nearest group(状態・人数・距離) | そのobserverJoiner から最も近い輪・グループの状態(形成中/成立済み/解散中など)、現在の人数、距離。 |
| attractiveness score | その最寄りの輪に対して、このobserverJoinerがどれだけ「近づきたい」と感じているかのスコア。willingness・conformity・influenceAvoidanceに加え、同じ既存グループ(clique)かどうかのボーナスや、特定cliqueに偏った輪への忌避感(アウトサイダーペナルティ)を反映した合成値。 |

**読み方のポイント**: `willingness` が高いのに `attractiveness score` が低いままだと、「本人は行きたいのに、その輪には近づきたいと思えていない」状態を意味します。これがobserverJoiner特有の「行きたいが動けない」状況の中身です。

### ログフィルタの使い分け

状態ログ上部のボタンで、表示するイベントの種類を絞り込めます。

- **全ログ**: すべてのイベントを時系列で表示。全体の流れを俯瞰したいときに。
- **observerJoinerのみ**: observerJoinerに関するイベントだけを表示。特定の1人がどう動く(動けない)かを追いたいときに。
- **核形成イベントのみ**: 誰か(主導者や既存グループ)が輪を作り始めた瞬間だけを表示。「いつ・誰が」場を作り始めたかを確認したいときに。
- **グループ成立イベントのみ**: 輪が `groupConfirmSize` 人以上集まって正式な二次会グループになった瞬間だけを表示。輪が実際に「成立」した数・タイミングを把握したいときに。
- **離脱イベントのみ**: 誰かが曖昧さに耐えられず離脱を始めた・離脱を完了したイベントだけを表示。プリセットごとに何人が/いつ離脱するかを比較したいときに。

### 典型的な観察シナリオ

- **observerJoinerの「行きたいが動けない」状態を読む**: プリセット2(曖昧なまま解散する場)またはプリセット5(自由グループ作りで余りやすい場)を実行し、インスペクターで対象observerJoinerの `willingness` が高い一方で `attractiveness score` が低いまま推移し、`stress` がじりじり増えて「離脱までの余裕」が減っていく様子を観察する。ログを「observerJoinerのみ」に絞ると、本人視点の動きだけを追える。
- **核形成後にattractivenessが上がるかを見る**: ログを「核形成イベントのみ」にして輪ができたタイミングを確認したら、同時刻付近のインスペクターで対象observerJoinerの `attractiveness score` が上昇するかを見る。上昇していれば「輪ができたことで近づきやすくなった」、上昇しなければ「輪ができても、その輪自体に魅力を感じていない(既存グループに占められている等)」ことが読み取れる。ログを「グループ成立イベントのみ」に切り替えれば、輪が実際に成立した瞬間との対応も確認できる。

Phase Aのインスペクター/ログは「1回のシミュレーションを画面で追う」ための機能です。これに加えて、Phase Bでは「1回の実行が最終的にどうなったか」をまとめる終了サマリーと、「同じ条件で何度も試したらどのくらいの確率で起きるか」を見るMonte Carlo集計を追加しました。さらにPhase Cでは、同じプリセットに対して「介入シナリオ」(場の設計・働きかけ)を重ねて実行し、介入なしとのMonte Carlo比較によって「場の設計がobserverJoinerの参加可能性にどう影響するか」を見られるようにしています。詳細は後述の[介入シナリオの使い方](#介入シナリオの使い方)を参照してください。

## 観察の流れ

このシミュレーターには、目的が異なる5つの観察手段があります。

- **単発seed(Phase A: なぜそう動いたかを見る)**: 1つのseedでシミュレーションを動かし、「なぜその動きになったか」を過程ごと読む。インスペクターやログフィルタで途中経過を追い、終了後は終了サマリーで結果を確認する。
- **Monte Carlo集計(Phase B: どの程度起きやすいかを見る)**: 同じプリセット・パラメータのまま複数のseedで繰り返し実行し、「その条件でどの程度起きやすいか」を確率・平均値として見る。1回ごとの過程は見ないが、たまたまその回だけ起きたのか、その条件で起きやすい傾向なのかを区別できる。
- **介入あり/なし比較(Phase C: 場の設計でどう変わるかを見る)**: 同じプリセット・パラメータのまま、介入シナリオを重ねた場合と重ねない場合(介入なし)をそれぞれMonte Carlo集計し、指標の差分を見る。「場の設計・働きかけを変えると、observerJoinerの参加可能性がどちらの方向にどれだけ動きそうか」を比較できる。
- **発言効果あり/なし比較(Phase 3: 発言の認知・解釈がどう効くかを見る)**: 同じプリセット・パラメータ・介入シナリオのまま、Phase 3の発言効果だけをOFF/ONで切り替えてMonte Carlo集計し、指標の差分を見る。詳しくは[発言の認知・解釈・効果(Phase 3)](#発言の認知解釈効果--phase-3)の[発言効果ON/OFFのpaired Monte Carlo比較](#発言効果onoffのpaired-monte-carlo比較)を参照。
- **三層モデルあり/なし比較(Phase 4: 本心と対外表現の乖離・信頼・関係性がどう効くかを見る)**: 同じプリセット・パラメータ・介入シナリオのまま、Phase 4の3設定(三層モデル・信頼更新・関係性変化)をOFF/ONで切り替えてMonte Carlo集計し、指標の差分を見る。画面上のパネルはなく、`phase4MonteCarlo.ts`をNode実行から直接呼び出す形になります。詳しくは[本心・対外表現・行動の三層モデル(Phase 4)](#本心対外表現行動の三層モデル--phase-4)の[検証方法: paired Monte Carlo](#検証方法-paired-monte-carlo)を参照。

まず単発seedでobserverJoinerの挙動を眺めて仮説を立て、その仮説がその条件でどの程度一般的に起きるのかをMonte Carlo集計で確認し、さらに介入シナリオを重ねて介入あり/なし比較で「場の設計を変えるとどう変わりそうか」を確認し、発言効果あり/なし比較で「発言の認知・解釈がどれだけ効いていそうか」を確認し、最後に三層モデルあり/なし比較で「本心と対外表現の乖離・信頼・関係性の変化がどれだけ効いていそうか」を確認する、という順序で使うことを想定しています。

## 終了サマリーの読み方

画面右側に常時表示される「終了サマリー」パネルは、現在動作中(または直前に停止した)単発シミュレーションの結果をまとめたものです。シミュレーションが終了する前は「現在時点の暫定集計」として表示され、値はその時点までのログから暫定的に計算されます。終了は、全エージェントが `joined`(参加済み)または `left`(離脱済み)のいずれかに達したとき、またはtick 400に達したときと判定されます。

- **終了状態**: `終了済み` / `実行中` と、終了と判定されたtick(未終了の場合は「未発生」)。
- **人数サマリー**: `参加人数`・`帰宅人数`に加え、未定/輪を形成中/接近中/参加済み/離脱中/離脱済みの内訳人数。
- **observerJoinerサマリー**: 画面上のobserverJoinerごとに1枚のカードで、以下を表示します。
  - `参加tick` / `参加先`(成立済みグループ・未確定の輪・未参加のいずれか)
  - `離脱開始tick` / `帰宅完了tick`
  - `後乗り成功`(成功/いいえ) — 参加済みの場合に、成立済みグループへ参加したか、または「輪が最初に成立したタイミングより後」に参加した場合を成功とみなす。未確定の輪への参加のまま全体の最初のグループ成立より前に合流した場合は「いいえ」になる。
- **グループ形成サマリー**: `最初の核形成tick`・`最初のグループ成立tick`・`成立グループ数`・`グループ不成立`(グループが1つも成立しなかった場合に「はい」)。

## Monte Carlo集計の使い方

画面左側の「Monte Carlo実行」パネルでは、現在選択中のシナリオプリセット・パラメータ・seedをそのまま使って、シミュレーションを指定回数(1〜100回)繰り返し実行し、結果を集計できます。

- **実行回数**: 1〜100回の範囲で指定します。
- **base seed**: 現在操作パネルで設定しているseedがそのまま base seed として使われ、1回目は base seed、2回目は base seed + 1 …という具合に、runごとに異なるseedで実行されます(同じseedの重複はありません)。
- **現在のプリセット・パラメータを使うこと**: プリセットを切り替えたりスライダーを動かしたりした状態でMonte Carloを実行すると、その時点の条件がそのまま使われます。結果表示後にプリセット・seed・パラメータを変更すると「現在の条件と異なる結果です」という警告が出るので、条件と結果がずれていないかを確認できます。
- **単発シミュレーション状態とは独立して集計すること**: Monte Carloの各runは、画面上で動いている単発シミュレーションとは別に、新しい状態・新しい乱数列で最初から実行されます。実行すると単発シミュレーションは一時停止しますが、その状態(現在のtickやエージェント位置など)がリセットされたり書き換えられたりすることはありません。

## 指標の解釈

Monte Carlo集計の「集計結果」には、以下の指標が表示されます。

- **observerJoiner参加率**: 画面上のobserverJoinerのうち、少なくとも1人が最終的に参加済みになったrunの割合。
- **observerJoiner離脱率**: 少なくとも1人のobserverJoinerが離脱を開始した(離脱中・離脱済みを含む)runの割合。
- **グループ不成立率**: 二次会グループが1つも成立しなかったrunの割合。
- **平均グループ成立tick**: グループが成立したrunに限定した、最初のグループ成立tickの平均値(1回も成立しなかった場合は「—」)。
- **後乗り成功率**: 少なくとも1人のobserverJoinerが「後乗り成功」の条件を満たしたrunの割合。
- **平均参加人数**: 全runの参加人数の平均値。
- **平均帰宅人数**: 全runの帰宅人数の平均値。

各runの個別結果は「個別run一覧」で、seedごとのobserverJoinerの最終状態・参加/離脱tick・最初のグループ成立tick・成立グループ数として確認できます。

**解釈上の注意**:

- 実行回数が少ないと、上記の指標はrunごとの偶然に大きく左右されます。傾向として読みたい場合は、実行回数をある程度増やしてから解釈してください。
- 単発seedのアニメーション・ログ・終了サマリーは「なぜその動きになったか」という過程理解に向いており、Monte Carlo集計は「その条件でどの程度起きやすいか」という傾向比較に向いています。どちらか一方だけで結論を出さず、両方を行き来して確認することを推奨します。
- 現時点では、指標の差が偶然によるものか条件によるものかを判定する統計的検定や信頼区間の算出は行っていません。指標はあくまで単純な比率・平均値であり、その解釈(有意差の判断など)は利用者に委ねられています。

## 通常プリセットと介入シナリオの違い

このシミュレーターには、性質の異なる2種類の「条件設定」があります。混同すると比較の意味が変わってしまうため、区別して理解してください。

- **通常プリセット(シナリオプリセット)**: その場の**初期条件・文化・人間関係**を決めるものです。主導者の人数、全体の二次会意欲、既存の仲良しグループ(clique)の強さなど、エージェント生成時に固定される性質を表します。プリセットを変えると、そもそも違う「場」を見ていることになります。
- **介入シナリオ**: 選んだプリセットは変えずに、**同じ場に対して追加で行う場の設計・働きかけ**を表します。「集合場所を明示する」「途中参加OKを明示する」など、幹事や場の設計側が働きかけを行ったら何が変わるか、を近似的に表現したものです。介入シナリオはどのプリセットとも組み合わせられ、プリセット自体を書き換えることはありません。

つまり、「プリセットを変える」ことは前提となる場そのものを変えることであり、「介入シナリオを選ぶ」ことは同じ場に対して設計上の工夫を加えることです。両者を同時に変えると何が効いたのか分からなくなるため、比較したいときはプリセット・パラメータ・seedを固定したまま介入シナリオだけを切り替えることを推奨します(後述の[介入あり/なし比較の読み方](#介入あり/なし比較の読み方)はこれを自動的に行います)。

## 介入シナリオの使い方

画面左側の「介入シナリオ」パネル(`InterventionSelector`)で、通常プリセットとは別に介入シナリオを選べます。デフォルトは「介入なし」で、通常プリセットのみの挙動になります。

**利用手順**:

1. シナリオプリセットを選ぶ(場の初期条件・文化・人間関係を決める)
2. 必要に応じてseed・パラメータを設定する
3. 介入シナリオを選ぶ(同じ場に対する場の設計・働きかけを追加する)
4. 単発シミュレーションで過程を観察する(Start/Pause・Stepやインスペクター・ログフィルタで、介入がどう作用しているかを個別に追う)
5. Monte Carloで傾向を確認する(その介入込みの条件で、どの程度の確率で何が起きるかを見る)
6. 介入あり/なし比較で差分を読む(同じ条件で介入なしと比べて、指標がどちらにどれだけ動いたかを見る)

介入シナリオを選ぶと、パネル内にその介入の説明・期待される効果・分類・効きやすい観察指標が表示されます。

**Phase Cの6介入シナリオ**:

| シナリオ | 分類 | 説明 | 期待される効果 | 効きやすい観察指標 |
| --- | --- | --- | --- | --- |
| 集合場所の明示 | 場の調整 | 幹事が「行く人は店の前に集まりましょう」と、集合場所を明示的にアナウンスする。 | どこに向かえばよいかが明確になり、様子見のまま留まる時間が減る。後乗りもしやすくなる。 | 平均グループ成立tick / グループ不成立率 |
| 途中参加OKの明示 | 社会的許可 | 「途中参加OK」「後から合流もOK」と誰かが明示的に宣言する。 | 後から合流することへの心理的ハードルが下がり、成立済みグループへの参加確率が上がる。 | 後乗り成功率 / observerJoiner参加率 |
| observerJoinerへの軽い声かけ | 個別への働きかけ | 参加者のうち1人が、observerJoinerに「一緒行く?」と軽く声をかける。 | observerJoiner自身が場を動かさなくても接近のきっかけが生まれ、影響回避の壁がある人でも輪に近づきやすくなる。 | observerJoiner参加率 / observerJoiner離脱率 |
| 曖昧時間の短縮 | 時間設計 | 店外で全員が様子見になる曖昧な時間そのものを短くする(例: 早めに意思確認の声をかける)。 | 曖昧フェーズが長引く負担が減り、ストレスが閾値を超えて離脱する前に決着がつきやすくなる。 | グループ不成立率 / observerJoiner離脱率 |
| 二次会会場の事前決定 | 場の調整 | 二次会に行くかどうかは曖昧なままでも、場所だけは先に決めておく。 | 「どこに行くか」の不確実性だけを先に取り除くことで、行くかどうかの判断に集中しやすくなり、輪への接近もしやすくなる。 | 後乗り成功率 / 平均グループ成立tick |
| 匿名・低圧の意思表明 | 社会的許可 | 参加表明を匿名・低圧な方法にする(例: 挙手ではなく紙に丸をつける、こっそりスタンプを押す等)。 | influenceAvoidanceが高い人でも、目立たない形でなら「行きたい」という意思を表明しやすくなる。 | observerJoiner参加率 / 平均グループ成立tick |

「効きやすい観察指標」は、それぞれの介入が内部的にどのロジック・パラメータへ作用するかから見た目安であり、必ずその指標だけが動くことを保証するものではありません(モデル上の近似です)。

## 介入あり/なし比較の読み方

画面左側の「介入なしとの比較」パネル(`InterventionComparisonPanel`)では、現在選択中のプリセット・パラメータ・seedを固定したまま、「介入なし」と現在選択中の介入シナリオをそれぞれ同じ実行回数・同じseed列でMonte Carlo実行し、指標ごとの差分を並べて表示します。

- 「介入なし」が選択されている間は比較できません。介入シナリオを選ぶと実行できるようになります。
- 実行すると、baseSeedから始まる同じseed列を使って、介入なし側・介入あり側の両方をそれぞれ指定回数実行します(条件はプリセット・パラメータ・seedとも完全に同一で、介入の有無だけが異なります)。
- 比較表には次の指標が「介入なし」「介入あり」「差分」の3列で並びます: observerJoiner参加率、observerJoiner離脱率、グループ不成立率、平均グループ成立tick、後乗り成功率、平均参加人数、平均帰宅人数。
- プリセット・パラメータ・seed・介入シナリオを結果表示後に変更すると、Monte Carlo集計と同様に「現在の条件と異なる結果です」という警告が表示されます。

**解釈上の注意**:

- 単発seedのアニメーション・ログ・終了サマリーは「なぜその動きになったか」という過程理解に向いています。介入の効果を数値で比較したい場合は、単発seed1回だけで判断せず、必ずMonte Carlo比較(傾向比較)と併せて確認してください。
- Monte Carlo比較は「傾向としてどちらに動きやすいか」を見るためのものであり、実行回数が少ないと結果は偶然に大きく左右されます。差分を解釈する際は、ある程度の実行回数(数十回程度)で確認することを推奨します。
- 介入の効果はあくまでモデル上の仮説的近似(パラメータ補正・確率補正)であり、現実の人間関係やコミュニケーションの効果を断定するものではありません。
- 指標の差が偶然によるものか介入によるものかを判定する統計的検定・信頼区間の算出は行っていません(指標の解釈と同様、判断は利用者に委ねられています)。
- 介入は「observerJoiner本人の努力不足」を補うためのものではありません。observerJoinerの特性(willingness、influenceAvoidanceなど)そのものは変えず、あくまで**場の設計・働きかけ側に何ができるか**を見るためのものです。

## Phase Cで観察できること

Phase Cの介入シナリオと介入あり/なし比較を使うと、次のようなことが確認できます。

- 同じ「場」(プリセット・パラメータ・関係性)のままでも、集合場所の明示や声かけなど場の設計・働きかけを変えるだけで、observerJoinerの参加率・離脱率や後乗り成功率がどちらの方向にどれだけ動きそうかを比較できる。
- どの介入がどの指標に効きやすいかを、単発seedでの過程観察とMonte Carlo比較の両方から確認できる。
- 「observerJoinerが参加できない/しない」ことが、本人の意欲や努力の問題ではなく、場の設計側の工夫(集合場所の明示、声かけ、途中参加のしやすさなど)で変わりうる余地があることを、モデル上の一つの仮説として観察できる。

## パラメータの反映タイミング

パラメータはスライダーを動かした瞬間にすべて画面上の数値には反映されますが、実際にシミュレーションの挙動へ反映されるタイミングはパラメータによって異なります。操作パネルの各スライダーには、どちらのタイプかを示すバッジ(`即時反映` / `Resetで反映`)が付いています。

- **即時反映**: `groupConfirmSize`(二次会成立に必要な人数)、`ambiguityDuration`(曖昧な時間の長さ)、`lateJoinEase`(後乗り参加のしやすさ)は、実行中のシミュレーションにも次のtickから反映されます。
- **Resetで反映**: `populationSize`(人数)、`numLeaders`(主導者の人数)、`overallWillingness`(全体の二次会意欲)、`existingTieStrength`(既存関係性の強さ)、observerJoinerの初期特性(`observerAmbiguityTolerance` / `observerInfluenceAvoidance` / `observerLeaveEase`)は、エージェントの生成時にのみ使われるパラメータです。これらは既存のエージェント集団には反映されず、**Reset(またはSeed変更・プリセット変更による再生成)を行って初めて反映されます**。Resetが必要な変更を行うと、操作パネルに「一部の変更はReset後に反映されます」という案内が表示されます。

## シナリオプリセット

1. **自然に二次会が成立する場** — 主導者がいて、二次会意欲の高い人も複数いる標準ケース
2. **曖昧なまま解散する場** — 主導者がおらず、皆が様子見のまま時間切れになる
3. **強い主導者が場を作る場** — 一人の強い主導者が早期に核を作り、多くの人が引き寄せられる
4. **後乗りしやすい文化** — 成立済みグループへの参加コストが低く、observerJoinerも参加しやすい
5. **自由グループ作りで余りやすい場** — 全体をまとめる主導者はおらず、既存の仲良しグループ同士が固まっていくため、observerJoinerが孤立しやすい
6. **教室で自由にペアを作る場** — 上記5つ(二次会シナリオ)とは前提そのものが異なる、教室のペア形成シナリオ。詳細は次の[教室ペア形成プリセット(classroom-pair)](#教室ペア形成プリセットclassroom-pair)を参照

## 教室ペア形成プリセット(classroom-pair)

上記5つの二次会プリセットとは別に、「先生が教室で『自由にペアを作ってください』と指示する」という
別の場を観察するためのプリセットです。プリセット選択で **「6. 教室で自由にペアを作る場」** を選ぶと、
`formationScenarioId: "classroomPair"` の[`FormationPolicy`](src/simulation/formationPolicy.ts)へ切り替わり、
二次会シナリオとは異なる成立・終了ルールでシミュレーションが進みます。二次会の5プリセットと同様に、
Start/Pause/Step・Monte Carlo・observerJoinerインスペクター・ログフィルタもそのまま使えます。

**目的**: 定員が固定された(二次会のように無制限に混ざれない)状況で、同時に複数のペア形成が競合し、
参加に失敗した人が再探索する、という力学を観察します。observerJoiner相当の人(自分から誘わず、
誘われるのを待ちやすい人)がこの制約下でどうなりやすいかも、二次会シナリオでの孤立と対比して観察できます。

**起動方法**: 画面左側のプリセット選択で「6. 教室で自由にペアを作る場」を選び、通常どおりStart/Step/Monte
Carloを実行するだけです。人数を増やしたい場合はpopulationSizeスライダーを変更してReset(Resetで反映)。

### 二次会シナリオとの違い

| | 二次会(afterParty、プリセット1〜5) | 教室ペア形成(classroomPair、プリセット6) |
| --- | --- | --- |
| 定員 | 実質無制限(`groupConfirmSize`人以上集まれば成立し、以後も自由に混ざれる) | 2人固定(`minGroupSize = maxGroupSize = 2`)。成立後は3人目が参加できない |
| 退出可否 | ストレスが`leaveThreshold`を超えると`leaving`→`left`で離脱できる | 退出不可。ストレスは観察用の値として蓄積するが、`leaving`/`left`へは絶対に遷移しない |
| 終了条件 | 全員が`joined`または`left`で決着(`allSettled`)、または安全上限tick(400)到達(`maxTicksReached`) | 全員が`joined`(`allAssigned`)、または`formationDeadlineTick`到達(`deadlineReached`)。全員割当なら締切前でも即終了する |
| 未割当の扱い | 未割当という終端状態は存在しない(最終的に`joined`か`left`のいずれか) | 締切時点でペアが決まっていない人は`unassigned`という終端状態になる。人口が奇数なら少なくとも1人は必然的に未割当になる |

どちらのシナリオも、`initiative`/`willingness`/`influenceAvoidance`/`conformity`/`cliqueId`/`stress`と
いった既存のエージェント特性、および核形成→接近→合流という1 tickの処理順序自体は共有しています
(`engine.ts`はシナリオ固有の分岐を持たず、上記の違いはすべて`FormationPolicy`の差し替えで表現されています)。
違いの実装詳細・将来シナリオへの拡張方法は[FormationPolicyの設計](docs/formation-policy-model.md)を参照してください。

### 「最後まで残る」ことについて

この教室ペア形成プリセットも、冒頭で述べた通り性格診断ツールではありません。締切時点で`unassigned`
(ペア未割当)のまま残ることは、その人の人格や社交性の欠陥を意味しません。モデル化された特性
(`initiative`/`willingness`/`influenceAvoidance`など)・既存の人間関係(`cliqueId`/`existingTieStrength`)・
定員という構造的制約(2人固定で、人口が奇数なら誰か1人は数学的に必ず余る)・時間制約
(`formationDeadlineTick`)が組み合わさった結果として観察される、モデル上の一つの帰結です。特に人口が
奇数の場合は、どんなに特性を調整しても「必ず1人は未割当になる」こと自体は避けられません
(`docs/core-agent-dynamics.md`の[6.3節](docs/core-agent-dynamics.md#63-学校のペア形成ポリシー)を参照)。

### 既知の制約

現時点の教室ペア形成プリセットには、次の制約があります(将来の拡張候補であり、実装済みではありません)。

- **教師による介入は未実装**: 二次会シナリオの介入シナリオ(集合場所の明示、声かけなど)に相当する、
  「先生が未割当の人同士を引き合わせる」といった教師側の働きかけはモデル化されていません。
- **3〜4人班は未実装**: 定員は常に2人固定で、人口が奇数でも3人班へは自動的に広がりません。
  3〜4人の班分けシナリオを追加する場合の拡張方法は[FormationPolicyの設計](docs/formation-policy-model.md)を参照してください。
- **現実データによる較正は未実装**: 二次会シナリオと同様、係数やしきい値は「挙動の対比が観察できる」
  ことを基準に調整した値であり、実際の教室でのペア形成に関する実証データによる較正は行っていません。

## シミュレーションルールの概要

行動ルールは `src/simulation/engine.ts` に集約されています。主なルール:

固定特性・関係性表現・主要な判断式・Agent/GroupCandidateの状態遷移・1 tickの処理順序を
まとめて確認する場合は、[UGSコアモデル: エージェントのミクロ力学と状態遷移](docs/core-agent-dynamics.md)
を参照してください。

- **核形成**: `initiative >= 0.5` の人(主導者)、または既存の仲良しグループ(clique)のメンバーが近くに揃っている人だけが、確率的に「輪」を作り始める(`forming`)。主導者0人・既存関係性も弱い場では誰も自分から輪を作らない。
- **接近**: 未定の人は近くの輪を観察し、`willingness` と `conformity` が高いほど近づく。`influenceAvoidance` が高い人は、まだ確定していない輪には極めて近づきにくいが、確定済みの輪には抵抗が下がる。既存の仲良しグループに占められた輪は、そのグループに属さない人(observerJoiner含む)には既存関係性の強さに応じて入りにくい。
- **ストレス**: 未定状態が続くほど蓄積する。`ambiguityTolerance` が低いほど早く溜まる。observerJoinerは「行きたいのに参加できる輪がまだない」状態が続くと追加でストレスが溜まる。
- **離脱**: ストレスが `leaveThreshold` を超えると帰宅方向へ移動し、画面端に到達すると離脱完了。
- **グループ成立**: 輪の周辺に `groupConfirmSize` 人以上が集まると成立(緑色)。成立後は後乗り参加のしやすさ(`lateJoinEase`)の分だけ参加のハードルが下がる。

## ファイル構成

```text
src/
  App.tsx                 画面の状態管理(Start/Pause/Reset/Step、パラメータ)
  simulation/
    types.ts              Agent / GroupCandidate / SimParams などの型定義
    random.ts              seed固定の疑似乱数生成器
    model.ts               初期エージェント生成(seedから再現可能)
    presets.ts              5つのシナリオプリセットとデフォルトパラメータ
    engine.ts               1tickごとの状態遷移ロジック(描画とは完全に分離)
    summary.ts              終了サマリー(SimulationSummary)の集計ロジック
    monteCarlo.ts           Monte Carlo実行・集計ロジック(介入あり/なし比較を含む)
    interventions.ts        Phase Cの介入シナリオ定義とパラメータ補正・engineロジック
    speech.ts               発言(SpeechEvent)の型・生成関数(Phase 2)
    speechEffects.ts        発言の認知・解釈・効果・active effectのモデル(Phase 3)
    speechEffectsMonteCarlo.ts 発言効果ON/OFFのpaired Monte Carlo比較ロジック(Phase 3)
    socialExpression.ts     本心/対外表現の型・乖離判定のモデル(Phase 4)
    speechTrust.ts           発言の真実性評価・受け手ごとの動的信頼更新(Phase 4)
    relationshipTie.ts       整合性履歴に基づく関係性(tie)補正(Phase 4)
    divergenceTemplates.ts   シナリオ別・性格別の本心/建前表現テンプレート(表示専用、Phase 4)
    phase4MonteCarlo.ts      Phase 4 (三層モデル・信頼・関係性) ON/OFFのpaired Monte Carlo比較ロジック
  components/
    SimulationCanvas.tsx    SVGによる描画のみを担当
    ControlPanel.tsx        操作パネルとパラメータスライダー
    EventLog.tsx            状態ログの表示(発言・発言効果・乖離・信頼・関係性フィルタを含む)
    AgentLegend.tsx         凡例
    SimulationSummaryPanel.tsx  終了サマリーの表示
    MonteCarloPanel.tsx     Monte Carlo実行・集計結果の表示
    InterventionSelector.tsx        介入シナリオの選択・説明表示
    InterventionComparisonPanel.tsx 介入あり/なしのMonte Carlo比較表示
    ObserverJoinerInspector.tsx     observerJoinerインスペクター(発言効果・本心/建前・信頼の因果詳細を含む)
    SpeechEffectsComparisonPanel.tsx 発言効果ON/OFFのMonte Carlo比較表示(Phase 3)
```

シミュレーションロジック(`simulation/`)と描画(`components/`)は分離されており、`engine.ts`・`model.ts` はUIに依存しないため単体テスト可能です。

## テスト

`src/simulation/*.test.ts` に、シミュレーションロジックに対するユニットテストがあります(Vitest)。

- 同じseedなら初期エージェント配置・特性が再現される
- 主導者の人数を増やすと高initiativeな人が増える
- 既存関係性の強さに応じてクラスタ(clique)が形成される/されない
- グループ候補は`groupConfirmSize`人以上集まると成立する
- `ambiguityTolerance`が低いエージェントほど早く離脱する
- observerJoinerは「成立済みグループ」には「未確定の輪」よりも近づきやすい
- 主導者が多いプリセットは、主導者不在のプリセットよりも早く輪が形成される

Phase 3(発言の認知・解釈・効果)に関するテストは主に次のファイルにあります。

- `speechEffects.test.ts` — 認知/解釈/効果/集約(`aggregateActiveEffects`/`registerActiveSpeechEffects`)の型・生成関数の単体テスト
- `speechEffectsWiring.test.ts` — `engine.ts`結線(4箇所の適用先)・OFF時に既存挙動を完全維持することの検証
- `speechEffectsReproducibility.test.ts` — 同一seedでの`activeSpeechEffects`・各種ログの再現性
- `speechEffectsMonteCarlo.test.ts` — 発言効果ON/OFFのpaired Monte Carlo比較(`compareSpeechEffects`)

Phase 4(本心・対外表現・行動の三層モデル)に関するテストは主に次のファイルにあります。

- `socialExpression.test.ts` — `derivePrivateEvaluations`/`derivePublicExpressions`の型・乖離判定・clamp規則の単体テスト
- `socialExpressionSpeech.test.ts` — `applyPublicExpressionsToSpeech`によるSpeechEvent生成への統合(intent置換表・rng非消費)の検証
- `speechTrust.test.ts` — 真実性導出(`truthfulnessOf`)・動的trust更新(観測条件・更新式)の単体テスト
- `relationshipTie.test.ts` — 整合性履歴・tie補正のモデル、およびプリセット5のobserverJoiner孤立が維持されることの検証
- `divergenceTemplates.test.ts` — 乖離場面分類・アーキタイプ分類・テンプレート決定的選択の検証
- `inspectionPhase4.test.ts` — インスペクター向けの本心/建前スナップショット・信頼サマリー組み立ての検証
- `phase4MonteCarlo.test.ts` — Phase 4 ON/OFFのpaired Monte Carlo比較(`comparePhase4Model`)
- `phase4Acceptance.test.ts` — 従来互換・再現性・因果追跡(乖離要因→SpeechEvent→認知/解釈/効果→trust/関係性更新)・数値安全性・プリセット5孤立維持の受入回帰テスト

```bash
npm run test
```

## 今後改善できる点

- クラスタ(既存の仲良しグループ)同士の空間的な引力・反発をもう少し明示的にモデル化すると、preset 5の「孤立」がより安定して観察できる
- D3-forceなどを使った衝突回避や、より自然な群衆の動きの導入
- グループが複数同時に競合する際の、observerJoinerの「どちらに近づくか」の意思決定をより詳細に
