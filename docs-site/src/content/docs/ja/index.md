---
title: capture-scheduler
description: capture-ledger のクロールを Windmill の上で回す —— 1 段ずつ BrowserHive に撮らせ、毎日 04:00 に起こす
---

capture-scheduler は [capture-ledger](https://uraitakahito.github.io/capture-ledger/) のクロールを
**[Windmill](https://www.windmill.dev/) の上で回す**。仕事は 2 つ。

- **撮る** —— capture-ledger がクロールを 1 段ずつ webhook で渡してくる。flow はその段の URL を
  ホストで束ね、robots.txt を確かめ、BrowserHive に gRPC で撮らせて、見つけたものを返す。
  自分が起こしていないクロールも、ここで回る。**BrowserHive を呼ぶのはこの repo の flow だけ** ——
  capture-ledger はもう BrowserHive と話さない。
- **起こす** —— 毎日 04:00 に、`capture_targets` の有効な行を種にしたクロールを capture-ledger に
  頼み（`POST /api/crawls`）、終わるまで見届ける。

時刻どおりに起こす仕組みそのものは **Windmill の schedule** で、この repo が持つのはその設定
（`daily.schedule.yaml`）と、時刻が来たときに走る script だけ。中身の大半は撮る側にある。

## 境界

|                                |                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **capture-ledger が決める**    | 何を（`capture_targets` か種の URL）・どこまで（深さ・範囲・上限）・どの間隔で（方針の値）・どの形式で。何が起きたかを記録し、次の段があるかを決める                                  |
| **capture-scheduler が決める** | いつ起こすか（schedule）と、1 段をどう回すか（ホストで束ねる・並列の数を BrowserHive の口の数で頭打ちにする・ホスト内は逐次で完了の後に間隔をあける・robots.txt・空いている口を選ぶ） |

だから、この repo に **URL は 1 つも書いていない**。対象も方針の値も、capture-ledger から届く。

この切り分けは守る価値がある。「何を取るか」も知っているスケジューラは、
おかしなものが取り込まれたときに**見る場所が 2 つ**になる —— そして 2 つは、
いつか食い違う。例外は robots.txt で、禁じられたページを外すのは flow だが、外したページは
理由つきで capture-ledger に報告され、記録に残る。

## 撮る —— 1 段ずつ

capture-ledger が **1 段ずつ**渡し、capture-scheduler は見つけたものを返す。次の段があるかは
capture-ledger が決める。[リンクを辿る](/crawl/) を見ること。

面白い制約が集まっているのはこちら —— **他人のサーバを繰り返し叩く**のがこの道だから。

## 起こす —— 日次は 1 本のクロール

日次の仕事は、`capture_targets` の有効な行を種にしたクロールを
capture-ledger に頼む（`fromTargets`）。深さは 0 —— 一覧は取り込むが、リンクは辿らない。
[いつ走るか](/schedule/) を見ること。

以前はもう 1 つ、**実行**があった —— 同じ対象を全部、並列に投げるもの。あれは
間隔を持たない深さ 0 のクロールだったので、クロールに畳んだ（`POST /api/runs` は
もう無い）。日次の取り込みにも、同じホストへの間隔が効くようになっている。

## どこに何があるか

| したいこと                           | ページ                           |
| ------------------------------------ | -------------------------------- |
| 初めて立ち上げる                     | [クイックスタート](/quickstart/) |
| クロールの flow を理解する           | [リンクを辿る](/crawl/)          |
| 日次の時刻を変える                   | [いつ走るか](/schedule/)         |
| Windmill CE が黙って飛ばすことを知る | [Windmill CE](/windmill-ce/)     |
| 試験を走らせる・足す                 | [試験](/testing/)                |
| 変更を Windmill に戻す               | [開発](/development/)            |
