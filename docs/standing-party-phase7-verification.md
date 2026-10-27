# standingParty Phase 7 統合検証 (Issue #267)

## 目的

Phase 7は、立食パーティーに料理台とドリンク台を置き、空腹・喉の渇きでそこへ移動し、受け取ったあと会場の会話へ戻れるようにする。この文書は、その一連の流れを短いfixtureと固定seedで確認した記録である。食欲や人流の現実データへの較正、統計的な有意差検定はしない。

台の型と優先順位の契約は [`standing-party-phase7-venue-anchors.md`](standing-party-phase7-venue-anchors.md) にある。

## 画面での最短再現

1. シナリオ「立食パーティー」を開く。初期presetは「飲食による会場回遊」(`standing-party-venue-refreshment`) である。
2. Seed に `267` を入れる。訪問を始める欲求の閾値は既定の 0.7 のままにする。
3. Reset してから Start する。

観察点:

- Canvasに「料理台」と「ドリンク台」が常時ある。座標はmodelのanchorそのもので、Canvasが別の位置を作らない。
- イベントログに「料理を取りに移動を始めた」または「ドリンクを取りに移動を始めた」、続いて「受け取った」、そのあと「料理台を離れ、会場の回遊に戻った」または「ドリンク台を離れ、会場の回遊に戻った」が出る。毎tickの移動は出ない。
- agentインスペクターの「飲食の目的行動(会話への参加とは別)」で、空腹と喉の渇きは `0.72 / 0.31` のように1行で出る。移動中は、取りに出た方の値がおおよそ 0.7 以上である。受け取り後はその値が 0.15 付近まで下がり、0.45 未満になる。phaseの文言は「移動中」「受け取り中」「消費中」「訪問していない」である。
- 比較preset「飲食なし比較」(`standing-party-venue-off-baseline`) では台が消え、同じ区画は「この実行では飲食台は無効です」と出す。従来の「立食パーティー」(`standing-party`) も飲食は無効のままである。

`e2e/standingPartyPhase7.desktop.spec.ts` は二つに分けている。一つは閾値を 0.05 まで下げ、Canvasの移動表示・表示トグル・受け取り・回遊復帰・飲食なし比較を見る。もう一つは seed `267` と既定閾値のまま、受け取り後の需要低下をインスペクターの数値で見る。閾値を 0.05 にすると補充後の 0.15 より低い状態で出発し得るので、需要低下はその手順では見ない。`e2e/standingPartyPhase7.mobile.spec.ts`（幅320px）は台・説明・移動表示・横overflowを見る。Canvas内部の座標一致はassertしない。

## 決定的fixture

`src/simulation/standingPartyPhase7Verification.test.ts` が次を固定する。

- joinedのagentは、thirstが閾値未満のtickの次にドリンク台へ離脱する。離脱理由は `venueRefreshmentBreak` で、社会的な `clusterDepartureStarted` ではない。元のepisodeは閉じ、同席していた相手とのcontact intervalもそのtickで終わる。`venueVisitStarted` / `venueVisitArrived` / `refreshmentObtained` / `venueVisitCompleted` は同じ `venueVisitId` を持つ。受け取り後、別のconfirmed clusterへjoinし、新しいepisodeが付く。
- 料理台も同様に到達し、別の輪へ戻る。未所属からの直接訪問、同時到着の満席放棄、台の不在、移動TTL、再訪cooldown、同じstateからの再開、Resetで訪問が消えることも同じファイルで見る。
- ドリンク台でサービス中に二人が近くても、contact intervalも内容発話も受信も作られない。訪問完了後の `venueEncounterFormed` で通常の `GroupCandidate` ができてから、contactが始まる。輪の中心は台の円の外に出る。

## 固定seedのON/OFF

比較は「立食パーティー(空間回遊あり・分散型)」(`standing-party-spatial-roaming`) に飲食台とencounterを足したものと、同じpresetで飲食台をオフにしたもの。seedは `11` / `42` / `77`、各500tick。件数は説明用で、差の検定はしていない。

| seed | ON food完了 | ON drink完了 | ON 複数領域のagent | ON active cluster tick | ON episode | ON contact | OFF 飲食event | OFF active cluster tick | OFF episode | OFF contact |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 11 | 35 | 44 | 24 | 437 | 130 | 666 | 0 | 499 | 298 | 1963 |
| 42 | 38 | 44 | 23 | 420 | 135 | 420 | 0 | 496 | 274 | 1289 |
| 77 | 34 | 44 | 24 | 441 | 168 | 679 | 0 | 500 | 287 | 1759 |

ONではどのseedでも料理とドリンクの完了がともにあり、agentは会場の複数象限を使う。会話のepisodeとcontactも残る。OFFは飲食eventがゼロで、clusterはほぼ毎tickある。ONのepisodeとcontactがOFFより少ないのは、飲食のために輪を離れる時間があるためで、会話が消えたという意味ではない。

同じpresetで1000tick・seed `11` と `42` を回し、NaN、world外座標、訪問の孤児、serviceや移動の寿命超過、cooldown前の同じ台への往復、終盤の社会的cluster消失がないことを確認した。

## 無効時のPhase 6

飲食台を無効にした二つのconfig（catalog空と、閾値を極小にした未使用catalog）は、200tick・seed `5` と `11` で次が一致した。

- 空間回遊presetの座標、所属、event、PRNGの次のdraw
- 情報伝播を有効にしたconfig（`standing-party-info-rich` の伝播設定に空間回遊を足したもの）の内容発話、受信、採用、発言

afterParty（preset `natural`）と classroomPair（preset `classroom-pair`）は、standingParty用の飲食configを渡しても40tickで飲食eventを出さず、渡さない実行と座標・所属・eventが一致する。

## 既知の限界

- 空腹・喉の渇きの上昇量は、数百tick以内に訪問が見えるように置いた仮説値であり、現実の食欲ではない。
- 初期preset「飲食による会場回遊」は、台への移動に加えて、台のそばで新しい輪を作る encounter も有効である。詳細設定の「料理台とドリンク台を置く」だけをオンにした従来presetでは encounter はオフのままで、受け取り後は通常の回遊と輪の探索に戻る。
- インスペクターが見せるのは現在の空腹・喉の渇きと訪問phaseであり、needの時系列グラフではない。
- 上表は3 seedの記述であり、飲食をオンにすると会話が増える、または減る、という一般則ではない。
