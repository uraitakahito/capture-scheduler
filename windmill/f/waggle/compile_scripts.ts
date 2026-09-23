/**
 * 台帳が送った TS を、ts-compile-service で型検査して JS にする。**1 段に 1 回。**
 *
 * ## なぜ flow の段なのか
 *
 * 目録が持つのは書いたままの TS のバイト列で、BrowserHive が評価するのは JS。その間のどこかで
 * 変換しなければならず、ここがその 1 か所。`crawl_host` は運ぶだけのまま (「flow は運ぶだけで中身を
 * 見ない」は変えていない —— 変換するのはこの段で、それも中身を見ずに送るだけ)。
 *
 * ## 型が通らなければ段ごと落ちる
 *
 * 変換サービスは 1 本でも型が通らなければ 422 を返し、JS を 1 本も返さない。ここで投げるので
 * flow は failure_module (`fail_crawl`) へ落ち、台帳のクロールは failed になる。**通らない TS を
 * 黙って走らせない** —— 走らせれば「何も起きなかったのに成功したアーカイブ」が出る。
 *
 * ## hash の継ぎ目
 *
 * 台帳 → ここは TS の sha256 で、ここ → BrowserHive は JS の sha256 で継ぐ。変換サービスが
 * 送られた sha256 を source と照合し (違えば 409)、JS に打ち直す。BrowserHive はその JS の
 * sha256 を照合する。
 */
import * as wmill from "windmill-client";

/** 目録の 1 本。`crawl_host.ts` の CrawlScript と同じ形。入力は TS、出力は JS。 */
export interface CrawlScript {
  id: string;
  version: number;
  phase: "preload" | "behavior";
  source: string;
  sha256: string;
  options: Record<string, unknown>;
}

export interface Compiled {
  scripts: CrawlScript[];
  /** 何で変換したか (typescript の版)。`report_level` が台帳に運ぶ */
  typescript: string;
  /** 何に向けて変換したか (受け皿の型の capture-scripts の tag)。同じく台帳に運ぶ */
  hostTypes: string;
  /** 同じ TS の並びを、変換サービスが前にも変換していたか */
  cached: boolean;
}

/**
 * 変換サービスの答えを読む。**ok でなければ投げる** —— 422 (型エラー) も 409 (hash 違い) も
 * 400 (形の違反) も、この段が赤くなる理由になる。診断は例外の文に畳んで、fail_crawl が
 * 台帳に報告する reason に載せる。
 */
export const readAnswer = (status: number, errorType: string | null, body: unknown): Compiled => {
  if (status === 200) return body as Compiled;
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const detail = JSON.stringify(record["diagnostics"] ?? record["fieldList"] ?? body);
  throw new Error(`compile ${String(status)} ${errorType ?? ""}: ${detail}`);
};

export async function main(scripts: CrawlScript[]): Promise<Compiled> {
  // **設定は変数から読む。引数では受けない。** Windmill は schema の既定値を UI からの実行にしか
  // 埋めない —— webhook で起こすと引数は素通りになる (`crawl_host.ts` に詳しい)。
  const base = await wmill.getVariable("u/admin/ts_compile_url");
  const res = await fetch(`${base}/compile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scripts }),
    // 固まるより落ちる。初回の型検査でも 1 秒かからない (実測 608 ms)
    signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await res.json();
  return readAnswer(res.status, res.headers.get("x-amzn-errortype"), body);
}
