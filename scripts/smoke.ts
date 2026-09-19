#!/usr/bin/env node
/**
 * 1 本撮って、撮れたか、なぜ撮れなかったかを言う (`pnpm run smoke [URL]`)。
 *
 * 本番と同じ道を通す —— capture-ledger の `POST /api/crawls` に、flow と同じトークン
 * (Windmill の変数 `u/admin/waggle_token`) で頼み、Windmill の flow に撮らせ、段の報告を待つ。
 * 「撮れた」は台帳の succeeded だけでは言わない。その回の archive を台帳の一覧から探し、
 * 署名付き URL で先頭 4 バイトを取り、`PK` (WACZ は zip) であることまで見る。
 *
 * 撮れなかったら、落ちた段と直し方を言う (`smoke/read-crawl.ts`)。**自分が起こしたクロールは
 * 必ず締める** —— running のまま残すと、以後の起動が全部 409 になる。
 *
 *   --timeout <秒>     待つ上限 (既定 180)
 *   --no-doctor        先に doctor を走らせない (直した直後の撮り直しと、壊して確かめるとき)
 *   --close-running    409 のとき、走っている 1 本を締めてから撮る。**明示したときだけ**
 *                      —— 他人の走行中のクロールを黙って締めない
 */
import { parseArgs } from "node:util";

import { guardEnv, windmillFetch, windmillUrl, windmillWorkspace } from "./env.js";
import { API, runDoctor } from "./doctor/checks.js";
import { formatFixes, formatTable, pad } from "./doctor/run.js";
import {
  parseCrawl,
  readBusy,
  readFinished,
  readRefused,
  readRun,
  readStuck,
  stepMessage,
  type Crawl,
  type Reading,
} from "./smoke/read-crawl.js";

guardEnv();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    timeout: { type: "string", default: "180" },
    "no-doctor": { type: "boolean", default: false },
    "close-running": { type: "boolean", default: false },
  },
});

const say = (label: string, text: string): void => console.log(`${pad(label, 9)}${text}`);

/** 1 行言って rc 1 で終わる。function 宣言なのは、呼んだ後の型の絞り込みを効かせるため。 */
function stop(label: string, text: string): never {
  say(label, text);
  process.exit(1);
}

const url = (() => {
  const raw = positionals[0] ?? "https://example.com/";
  try {
    return new URL(raw).href;
  } catch {
    return stop("URL", `${raw} は URL として読めない`);
  }
})();
const timeoutMs = Number(values.timeout) * 1000;
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  stop("--timeout", `${values.timeout} は秒数でない`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

// ── 点検 ──────────────────────────────────────────────────────────────

if (!values["no-doctor"]) {
  const results = await runDoctor();
  if (results.some((r) => r.state === "fail")) {
    for (const line of formatTable(results)) console.log(line);
    console.log("");
    for (const line of formatFixes(results)) console.log(line);
    console.log("");
    // クロールは起こさない —— 撮れないと分かっている 1 本で running の行を残さない。
    stop("点検", "撮る前に直すものがある (上の ✗)。直して pnpm run smoke をもう一度");
  }
  const skipped = results.filter((r) => r.state === "skip").length;
  say(
    "点検",
    skipped === 0
      ? `doctor の ${String(results.length)} 本とも ✓`
      : `doctor の ✓ ${String(results.length - skipped)} 本・点検しない ${String(skipped)} 本`,
  );
}

// ── 起こす ────────────────────────────────────────────────────────────

/** flow が名乗るのと同じトークン。撮るのも締めるのもこれで。 */
const token = await windmillFetch(
  `/api/w/${windmillWorkspace()}/variables/get_value/u/admin/waggle_token`,
  { token: process.env["WINDMILL_TOKEN"] ?? "" },
).then(
  (value) => (typeof value === "string" && value !== "" ? value : undefined),
  () => undefined,
);
if (token === undefined) {
  stop(
    "トークン",
    "Windmill の変数 u/admin/waggle_token が読めない → pnpm run windmill:capture-ledger-token " +
      "(.env の WINDMILL_TOKEN も要る)",
  );
}
const auth = { authorization: `Bearer ${token}` };

const ledger = async (
  path: string,
  init: RequestInit = {},
): Promise<{ status: number | undefined; body: string }> => {
  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...auth, ...init.headers },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: undefined, body: "" };
  }
};

/** 締める。締めたかどうかを 1 行で言う。 */
const close = async (crawlId: string, reason: string): Promise<void> => {
  const { status, body } = await ledger(`/api/crawls/${crawlId}/failed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (status === 200) {
    say("締めた", `${crawlId} (${reason})`);
    return;
  }
  say(
    "締められない",
    `POST /api/crawls/${crawlId}/failed → ${String(status)} ${body.slice(0, 200)} —— ` +
      "次の起動は 409 になる。capture-ledger のクイックスタートの「409 が続くとき」",
  );
};

const start = async (): Promise<{ status: number | undefined; body: string }> =>
  ledger("/api/crawls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seeds: [url], maxDepth: 0 }),
  });

let started = await start();
if (started.status === 409) {
  const busy = readBusy(parse(started.body));
  const who =
    busy.crawlId === undefined
      ? "走行中のクロールがある (capture-ledger が v0.43.0 より古く、どれかは分からない)"
      : `走行中のクロールがある: ${busy.crawlId} (${busy.startedAt ?? "?"} から)`;
  if (!values["close-running"] || busy.crawlId === undefined) {
    say("起こす", `POST /api/crawls → 409 —— ${who}`);
    stop(
      "直す",
      busy.crawlId === undefined
        ? "capture-ledger のクイックスタートの「409 が続くとき」"
        : "終わるのを待つか、締めてから撮る: pnpm run smoke --close-running",
    );
  }
  say("起こす", `409 —— ${who}。--close-running なので締める`);
  await close(busy.crawlId, "smoke --close-running で締めた");
  started = await start();
}
if (started.status !== 202) {
  const refused = readRefused(started.status, started.body);
  say("起こす", refused.evidence);
  stop("直す", refused.fix);
}
const crawlId = String((parse(started.body) as { crawlId?: unknown }).crawlId);
say("起こす", `POST /api/crawls → 202  crawl ${crawlId}  ${url}`);

// Ctrl-C で抜けても、自分が起こしたクロールは締める。
process.once("SIGINT", () => {
  void close(crawlId, "smoke を Ctrl-C で止めた").finally(() => process.exit(130));
});

// ── 待つ ──────────────────────────────────────────────────────────────

const runUrl = (id: string): string =>
  `${windmillUrl()}/run/${id}?workspace=${windmillWorkspace()}`;

const windmillJob = async (id: string): Promise<unknown> =>
  windmillFetch(`/api/w/${windmillWorkspace()}/jobs_u/get/${id}`, {
    token: process.env["WINDMILL_TOKEN"] ?? "",
  }).catch(() => undefined);

/** run の URL は、分かった時点で 1 度だけ出す (待っている間に Windmill で開けるように)。 */
let shownRun: string | undefined;
const showRun = (crawl: Crawl): void => {
  if (!crawl.lastJob || crawl.lastJob.id === shownRun) return;
  shownRun = crawl.lastJob.id;
  say("run", runUrl(crawl.lastJob.id));
};

function report(reading: Reading, crawl: Crawl): never {
  say("原因", reading.evidence);
  say("直す", reading.fix);
  showRun(crawl);
  process.exit(1);
}

const seconds = (crawl: Crawl): string => {
  const end = crawl.finishedAt === null ? Date.now() : Date.parse(crawl.finishedAt);
  return `${String(Math.round((end - Date.parse(crawl.startedAt)) / 1000))} 秒`;
};

const deadline = Date.now() + timeoutMs;
let crawl: Crawl | undefined;
let warnedOld = false;
say("待つ", "running");
for (;;) {
  const got = await ledger(`/api/crawls/${crawlId}`);
  crawl = parseCrawl(parse(got.body));
  if (crawl === undefined) {
    say("待つ", `GET /api/crawls/${crawlId} → ${String(got.status)} ${got.body.slice(0, 200)}`);
    await close(crawlId, "smoke: クロールの状態が読めなかった");
    process.exit(1);
  }
  if (!("lastJob" in crawl) && !warnedOld) {
    warnedOld = true;
    say("注意", "capture-ledger が v0.43.0 より古い —— run と、取れなかったページが分からない");
  }
  showRun(crawl);
  if (crawl.state !== "running") break;
  // 締める段まで落ちると、クロールは running のまま残る。run が失敗で終わっていれば、待っても変わらない。
  if (crawl.lastJob) {
    const run = readRun(await windmillJob(crawl.lastJob.id));
    if (run.state === "failed") {
      say("終わり", `run が失敗で終わったが、クロールは running のまま (${seconds(crawl)})`);
      const message =
        run.stepJob === undefined ? undefined : stepMessage(await windmillJob(run.stepJob));
      const reading = readStuck(run, message);
      await close(crawlId, "smoke: run が失敗し、クロールが running のまま残った");
      report(reading, crawl);
    }
  }
  if (Date.now() >= deadline) {
    say("終わり", `${String(timeoutMs / 1000)} 秒で終わらなかった`);
    const run = crawl.lastJob ? readRun(await windmillJob(crawl.lastJob.id)) : undefined;
    await close(crawlId, `smoke: ${String(timeoutMs / 1000)} 秒で終わらなかった`);
    report(
      {
        evidence:
          run === undefined
            ? "Windmill の run の記録が無い (lastJob が null) —— capture-ledger が job の id を受け取れていない"
            : run.state === "running"
              ? "run はまだ走っている —— 撮るのに時間がかかっている"
              : `run は ${run.state} —— それでもクロールが running のまま`,
        fix:
          run?.state === "running"
            ? "run を開いて、どの段で止まっているかを見る。遅いだけなら --timeout で延ばす"
            : "run を開いて、段の報告が capture-ledger に届いたかを見る (pnpm run doctor の container→api)",
      },
      crawl,
    );
  }
  await sleep(2000);
}

// ── 終わり ────────────────────────────────────────────────────────────

const why =
  crawl.stopReason !== null && crawl.stopReason !== crawl.state ? ` (${crawl.stopReason})` : "";
say(
  "終わり",
  `${crawl.state}${why} —— 撮ったページ ${String(crawl.pagesCaptured)}・${seconds(crawl)}`,
);
const finished = readFinished(crawl);
if (finished !== undefined) report(finished, crawl);

// ── 取り出す ──────────────────────────────────────────────────────────

/**
 * 台帳に載ったこの回の archive。一覧は新しい順なので、最初に当たったもの。
 *
 * **一覧に出るまで待つ。** 一覧は見てよいかを OpenFGA に訊いて絞っていて、archive の関係は
 * capture-ledger の outbox が 5 秒ごとに書く (CAPTURE_LEDGER_DRAIN_INTERVAL_MS)。succeeded の
 * 直後に訊くと、まだ無い (2026-09-19 に実測。数秒後に出た)。
 */
const findArchive = async (startedAt: string): Promise<{ id: string } | undefined> => {
  const until = Date.now() + 30_000;
  for (;;) {
    const listed = parse((await ledger("/api/archives")).body) as
      | { archives?: { id: string; sourceUrl: string; capturedAt: string }[] }
      | undefined;
    const found = listed?.archives?.find(
      (a) => a.sourceUrl === url && Date.parse(a.capturedAt) >= Date.parse(startedAt),
    );
    if (found !== undefined || Date.now() >= until) return found;
    await sleep(2000);
  }
};

const archive = await findArchive(crawl.startedAt);
if (archive === undefined) {
  report(
    {
      evidence: `succeeded だが、30 秒待っても台帳の一覧に ${url} のこの回の archive が出ない`,
      fix:
        "見てよいかの関係が書かれていない —— capture-ledger の API のログの " +
        "「Scheduled outbox drain failed」と、OpenFGA (pnpm run doctor の openfga)",
    },
    crawl,
  );
}
const signed = parse(
  (await ledger(`/api/archives/${archive.id}/url`, { method: "POST" })).body,
) as { url?: string };
const head =
  signed.url === undefined
    ? undefined
    : await fetch(signed.url, { headers: { range: "bytes=0-3" } })
        .then(async (res) =>
          Buffer.from(await res.arrayBuffer())
            .subarray(0, 2)
            .toString("latin1"),
        )
        .catch(() => undefined);
if (head !== "PK") {
  report(
    {
      evidence: `archive ${archive.id} の中身を取り出せない (先頭が ${JSON.stringify(head)})`,
      fix: "署名付き URL の先 (capture-ledger の CAPTURE_LEDGER_S3_ENDPOINT) に host から届くか",
    },
    crawl,
  );
}
say("取り出す", `archive ${archive.id} の先頭が PK (WACZ = zip)`);
say("撮れた", url);
