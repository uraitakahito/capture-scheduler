#!/usr/bin/env node
/**
 * 1 本撮って、撮れたか、なぜ撮れなかったかを言う (`pnpm run smoke [URL]`)。
 *
 * 本番と同じ道を通す —— capture-ledger の `POST /api/crawls` に、flow と同じトークン
 * (Windmill の変数 `u/admin/ledger_client` の資格で取る) で頼み、Windmill の flow に撮らせ、段の報告を待つ。
 * 「撮れた」は capture-ledger の succeeded だけでは言わない。その回の archive を capture-ledger の一覧から探し、
 * 署名付き URL で先頭 4 バイトを取り、`PK` (WACZ は zip) であることまで見る。
 *
 * **合本と索引と検索まで見る (CAPTURE-57・CAPTURE-53)。** capture-ledger は段の報告の時点で succeeded にし、合本の段と
 * 索引の段はその後に走るので、段の run の終わりを待つ。合本の段の答え (書けた・検められなかった 0 本) を照らし、
 * capture-ledger が指す合本の `replay.json` を replayweb-server の `/wacz/<鍵>` から読んで、この回の archive が入っているかを見る
 * (`smoke/read-replay-bundle.ts`)。合本の段は capture-ledger の 200 の失敗では投げない (クロールを止めないため) ので、
 * run が緑でも合本が書けたとは限らない。続けて索引の段の答え (載らなかった 0 本・載せた 1 本以上) を照らす。
 * 既定の頁 (capture-fixtures の印付きの頁。印は撮るたびに変える) なら、その印で capture-ledger の検索を引き、
 * この回の archive の当たりの時点が、WACZ のページ一覧から予想した時点と同じかまで照らす
 * (`smoke/read-search.ts`)。URL を渡したときは、検索は照らさない (その頁で当たる語が分からない)。
 *
 * 撮れなかったら、落ちた段と直し方を言う (`smoke/read-crawl.ts`)。**自分が始めたクロールは
 * 必ず締める** —— running のまま残すと、以後の起動が全部 409 になる。flow がまだ走っていれば、
 * Windmill の run を取り消してから締める (`cancelRun`)。
 *
 *   --timeout <秒>     待つ上限 (既定 180)
 *   --no-doctor        先に doctor を走らせない (直した直後の撮り直しと、壊して確かめるとき)
 *   --close-running    409 のとき、走っている 1 本を締めてから撮る。**明示したときだけ**
 *                      —— 他人の走行中のクロールを黙って締めない
 */
import { parseArgs } from "node:util";

import { guardEnv, windmillFetch, windmillUrl, windmillWorkspace } from "./env.js";
import { LEDGER_CLIENT_VAR, hostClientCredentials, parseLedgerClient } from "./ledger-client.js";
import { API, runDoctor } from "./doctor/checks.js";
import { formatFixes, formatTable, pad } from "./doctor/run.js";
import { strFromU8, unzipSync } from "fflate";

import {
  parseCrawl,
  readBusy,
  readFinished,
  readRefused,
  readRun,
  readStepFailure,
  readStuck,
  stepMessage,
  type Crawl,
  type Reading,
} from "./smoke/read-crawl.js";
import {
  readLedgerReplayBundle,
  readReplayBundleFailure,
  readReplayBundleOutcome,
  readReplayBundleStep,
  readReplayJson,
  replayBundleJobOf,
  replayJsonKeyUrl,
} from "./smoke/read-replay-bundle.js";
import {
  compareSearchHits,
  expectedStages,
  indexJobOf,
  readIndexFailure,
  readIndexOutcome,
  readIndexStep,
  readSearchHits,
  smokeTarget,
  stagesOf,
} from "./smoke/read-search.js";

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

/** 既定で撮る capture-fixtures (capture-ledger のスタックの物。BrowserHive のコンテナがこの名前を引く)。 */
const FIXTURES = "http://capture-fixtures.capture-ledger:8080";
/**
 * host から見た capture-ledger のスタックの replayweb-server (compose が loopback の 8899 に出すポート)。合本の `replay.json` を
 * `/wacz/<鍵>` から読む —— ReplayWeb.page が合本を開くときと同じエンドポイントで読めるかを見る。`API` と同じく、capture-ledger の
 * 開発のスタックの決まったポート。
 */
const REPLAYWEB_SERVER = "http://127.0.0.1:8899";
/** 既定の頁と、検索に使う語 (撮るたびに変わる印)。URL を渡したときは無い。 */
const target =
  positionals[0] === undefined
    ? smokeTarget(FIXTURES, Date.now(), Math.random().toString(36).slice(2, 8))
    : undefined;
const url = (() => {
  const raw = positionals[0] ?? target?.url ?? "";
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
    // クロールは始めない —— 撮れないと分かっている 1 本で running の行を残さない。
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

// ── 始める ────────────────────────────────────────────────────────────

/** flow が名乗るのと同じ資格で取ったトークン。撮るのも締めるのもこれで。 */
const client = parseLedgerClient(
  await windmillFetch(`/api/w/${windmillWorkspace()}/variables/get_value/${LEDGER_CLIENT_VAR}`, {
    token: process.env["WINDMILL_TOKEN"] ?? "",
  }).then(
    (value) => (typeof value === "string" ? value : undefined),
    () => undefined,
  ),
);
const token = client === undefined ? undefined : (await hostClientCredentials(client)).token;
if (token === undefined) {
  stop(
    "トークン",
    `Windmill の変数 ${LEDGER_CLIENT_VAR} で flow の資格のトークンを取れない → ` +
      "cd ../capture-ledger && pnpm run dev:up --from idp (.env の WINDMILL_TOKEN も要る)",
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

/**
 * Windmill の run を取り消す。**締める前に。** 走っている flow を残して capture-ledger の行だけ締めると、後から
 * 届いた段の報告が、締めたクロールを succeeded に書き戻していた (2026-09-19 に実測)。いまの
 * capture-ledger は、締めるのを走行中の行だけにして書き戻さない (CAPTURE-61)。それでも、残した run は
 * capture-ledger に報告を足し続けるので、先に取り消す。取り消した run では締める段が走らないので、締めるのはこちら。
 * 終わった run の取り消しは、何もせずに 200 を返す。
 */
const cancelRun = async (jobId: string, reason: string): Promise<void> => {
  await windmillFetch(`/api/w/${windmillWorkspace()}/jobs_u/queue/cancel/${jobId}`, {
    token: process.env["WINDMILL_TOKEN"] ?? "",
    method: "POST",
    body: { reason },
  }).catch(() => undefined);
};

/** run を取り消してから、クロールを締める。締めたかどうかを 1 行で言う。 */
const close = async (crawlId: string, reason: string, jobId: string | undefined): Promise<void> => {
  if (jobId !== undefined) await cancelRun(jobId, reason);
  const { status, body } = await ledger(`/api/crawls/${crawlId}/failed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (status === 200) {
    const { closed } = (parse(body) ?? {}) as { closed?: unknown };
    say(
      "締めた",
      closed === false
        ? `${crawlId} は、締める前に終わっていた`
        : `${crawlId}${jobId === undefined ? "" : ` と run ${jobId}`} (${reason})`,
    );
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
    say("始める", `POST /api/crawls → 409 —— ${who}`);
    stop(
      "直す",
      busy.crawlId === undefined
        ? "capture-ledger のクイックスタートの「409 が続くとき」"
        : "終わるのを待つか、締めてから撮る: pnpm run smoke --close-running",
    );
  }
  say("始める", `409 —— ${who}。--close-running なので締める`);
  const running = parseCrawl(parse((await ledger(`/api/crawls/${busy.crawlId}`)).body));
  await close(busy.crawlId, "smoke --close-running で締めた", running?.lastJob?.id);
  started = await start();
}
if (started.status !== 202) {
  const refused = readRefused(started.status, started.body);
  say("始める", refused.evidence);
  stop("直す", refused.fix);
}
const crawlId = String((parse(started.body) as { crawlId?: unknown }).crawlId);
say("始める", `POST /api/crawls → 202  crawl ${crawlId}  ${url}`);

/** 待っている間に見た、最後の段の run。Ctrl-C のとき取り消す。 */
let lastJobId: string | undefined;

// Ctrl-C で抜けても、自分が始めたクロールは締める。
process.once("SIGINT", () => {
  void close(crawlId, "smoke を Ctrl-C で止めた", lastJobId).finally(() => process.exit(130));
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
    await close(crawlId, "smoke: クロールの状態が読めなかった", lastJobId);
    process.exit(1);
  }
  if (!("lastJob" in crawl) && !warnedOld) {
    warnedOld = true;
    say("注意", "capture-ledger が v0.43.0 より古い —— run と、取れなかったページが分からない");
  }
  showRun(crawl);
  lastJobId = crawl.lastJob?.id ?? lastJobId;
  if (crawl.state !== "running") break;
  // 締める段まで落ちると、クロールは running のまま残る。run が失敗で終わっていれば、待っても変わらない。
  if (crawl.lastJob) {
    const run = readRun(await windmillJob(crawl.lastJob.id));
    if (run.state === "failed") {
      say("終わり", `run が失敗で終わったが、クロールは running のまま (${seconds(crawl)})`);
      const message =
        run.stepJob === undefined ? undefined : stepMessage(await windmillJob(run.stepJob));
      const reading = readStuck(run, message);
      await close(crawlId, "smoke: run が失敗し、クロールが running のまま残った", undefined);
      report(reading, crawl);
    }
  }
  if (Date.now() >= deadline) {
    say("終わり", `${String(timeoutMs / 1000)} 秒で終わらなかった`);
    const run = crawl.lastJob ? readRun(await windmillJob(crawl.lastJob.id)) : undefined;
    await close(crawlId, `smoke: ${String(timeoutMs / 1000)} 秒で終わらなかった`, lastJobId);
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
 * capture-ledger に載ったこの回の archive。一覧は新しい順なので、最初に当たったもの。
 *
 * **一覧に出るまで待つ。** 一覧は見てよいかを OpenFGA に訊いて絞っていて、archive の関係は
 * capture-ledger の outbox が 5 秒ごとに書く (CAPTURE_LEDGER_DRAIN_INTERVAL_MS)。succeeded の
 * 直後に訊くと、まだ無い (2026-09-19 に実測。数秒後に出た)。
 */
const findArchive = async (
  startedAt: string,
): Promise<{ id: string; objectKey: string } | undefined> => {
  const until = Date.now() + 30_000;
  for (;;) {
    const listed = parse((await ledger("/api/archives")).body) as
      | { archives?: { id: string; sourceUrl: string; capturedAt: string; objectKey: string }[] }
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
      evidence: `succeeded だが、30 秒待っても capture-ledger の一覧に ${url} のこの回の archive が出ない`,
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

// ── 段の run の終わり ─────────────────────────────────────────────────

/**
 * 段の run が終わるまで待つ。**capture-ledger は段の報告の時点で succeeded にし、合本の段と索引の段はその後に走る** ——
 * succeeded を見ただけでは、合本が書けたか・索引が載ったかは分からない (CAPTURE-53 の調べ)。
 */
const finishedRun = async (
  jobId: string,
): Promise<{ run: ReturnType<typeof readRun>; job: unknown }> => {
  const until = Date.now() + 60_000;
  for (;;) {
    const job = await windmillJob(jobId);
    const run = readRun(job);
    if (run.state !== "running" || Date.now() >= until) return { run, job };
    await sleep(2000);
  }
};

const levelJob = crawl.lastJob?.id;
if (levelJob === undefined) {
  report(
    {
      evidence: "段の run が分からない (lastJob が無い) —— 合本と索引の段の答えを読めない",
      fix: "capture-ledger が v0.43.0 より古い → capture-ledger を新しくする",
    },
    crawl,
  );
}
const level = await finishedRun(levelJob);
if (level.run.state === "running") {
  report(
    {
      evidence:
        "段の run が、succeeded の後 60 秒たっても終わらない (合本か索引の段で止まっている)",
      fix: "run を開いて replay_bundle と index の段の log を見る。OpenSearch が遅いなら capture-ledger の pnpm run dev:status",
    },
    crawl,
  );
}
if (level.run.state === "unknown") {
  report(
    {
      evidence: `段の run が読めない (${level.run.detail})`,
      fix: "Windmill に届くか —— .env の WINDMILL_TOKEN と pnpm run doctor の workspace",
    },
    crawl,
  );
}
if (level.run.state === "failed") {
  const failed = level.run;
  const message =
    (failed.stepJob === undefined ? undefined : stepMessage(await windmillJob(failed.stepJob))) ??
    failed.closeProblem ??
    "";
  report(
    {
      evidence: `クロールは succeeded だが、run の ${failed.step ?? "?"} の段が落ちた: ${message || "(文が読めない)"}`,
      fix:
        readReplayBundleFailure(message) ??
        readIndexFailure(message) ??
        readStepFailure(failed.step, message),
    },
    crawl,
  );
}

// ── 合本 ──────────────────────────────────────────────────────────────

const replayBundleJob = replayBundleJobOf(level.job);
const replayBundleOutcome =
  replayBundleJob === undefined
    ? undefined
    : readReplayBundleOutcome(await windmillJob(replayBundleJob));
const replayBundleProblem = readReplayBundleStep(replayBundleOutcome, crawlId);
if (
  replayBundleProblem !== undefined ||
  replayBundleOutcome === undefined ||
  replayBundleOutcome.rev === null
) {
  report(
    replayBundleProblem ?? { evidence: "合本の段の答えが読めない", fix: "pnpm run windmill:push" },
    crawl,
  );
}
// capture-ledger が指す合本の鍵を、段の run の後に読み直す (待っている間に読んだクロールは、合本の段より前の物)
const pointed = readLedgerReplayBundle(
  parse((await ledger(`/api/crawls/${crawlId}`)).body),
  replayBundleOutcome.rev,
);
if ("problem" in pointed) report(pointed.problem, crawl);
// replayweb-server は匿名で読む (保管庫も匿名で読める) ので、名乗らずに引く。
const replayJsonUrl = replayJsonKeyUrl(REPLAYWEB_SERVER, pointed.replayBundle.key);
const replayJson = await (async (): Promise<{ status: number | undefined; body: string }> => {
  try {
    const res = await fetch(replayJsonUrl, { signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: undefined, body: "" };
  }
})();
const replayJsonProblem = readReplayJson(
  replayJsonUrl,
  replayJson.status,
  replayJson.body,
  archive.objectKey,
);
if (replayJsonProblem !== undefined) report(replayJsonProblem, crawl);
say(
  "合本",
  `r${String(replayBundleOutcome.rev)} を書いた —— 頁 ${String(replayBundleOutcome.pages)}・` +
    `WACZ ${String(replayBundleOutcome.members)} 本。` +
    `replayweb-server の /wacz/${pointed.replayBundle.key} にこの回の archive が在る`,
);

// ── 索引 ──────────────────────────────────────────────────────────────

const indexJob = indexJobOf(level.job);
const outcome = indexJob === undefined ? undefined : readIndexOutcome(await windmillJob(indexJob));
const indexProblem = readIndexStep(outcome);
if (indexProblem !== undefined || outcome === undefined) {
  report(
    indexProblem ?? { evidence: "索引の段の答えが読めない", fix: "pnpm run windmill:push" },
    crawl,
  );
}
say(
  "索引",
  `載せたアーカイブ ${String(outcome.indexed)} 本・載らなかった 0 本・索引の件数 ${String(outcome.pages)}`,
);

// ── 検索 ──────────────────────────────────────────────────────────────

if (target === undefined) {
  say("検索", "URL を渡したので照らさない (照らすのは既定の印付きの頁のとき)");
} else {
  // 当たるはずの時点は、その WACZ のページ一覧から決める (写しの行があれば写しの時点だけ)。
  const pagesJsonl =
    signed.url === undefined
      ? undefined
      : await fetch(signed.url)
          .then(async (res) => {
            const members = unzipSync(new Uint8Array(await res.arrayBuffer()), {
              filter: (file) => file.name === "pages/pages.jsonl",
            });
            const bytes = members["pages/pages.jsonl"];
            return bytes === undefined ? undefined : strFromU8(bytes);
          })
          .catch(() => undefined);
  if (pagesJsonl === undefined) {
    report(
      {
        evidence: `archive ${archive.id} の pages/pages.jsonl が読めない`,
        fix: "署名付き URL の先 (capture-ledger の CAPTURE_LEDGER_S3_ENDPOINT) に host から届くか",
      },
      crawl,
    );
  }
  const expected = expectedStages(pagesJsonl);

  // **当たるまで少し待つ。** 見てよいかの権限は capture-ledger が 5 秒ごとに OpenFGA へ書くので、撮った
  // 直後は当たらないことがある。当たったのに時点が違えば、待っても変わらないので待たない。
  const until = Date.now() + 15_000;
  let problem: Reading | undefined;
  for (;;) {
    const got = await ledger(`/api/search?q=${encodeURIComponent(target.query)}`);
    const hits = readSearchHits(parse(got.body));
    if (hits === undefined) {
      problem = {
        evidence: `GET /api/search → ${String(got.status)} ${got.body.slice(0, 200)}`,
        fix:
          got.status === 503
            ? "capture-ledger の OpenSearch が答えない → cd ../capture-ledger && pnpm run dev:up --from search"
            : got.status === 404
              ? "capture-ledger に検索のエンドポイントが無い (pnpm run doctor の search route)"
              : "答えの形が違う (total が数でない) —— capture-ledger が古い",
      };
      break;
    }
    problem = compareSearchHits(hits, archive.id, expected);
    if (problem === undefined || stagesOf(hits, archive.id).length > 0 || Date.now() >= until)
      break;
    await sleep(2000);
  }
  if (problem !== undefined) report(problem, crawl);
  say(
    "検索",
    `「${target.query}」で archive ${archive.id} の ${expected.join("・")} が当たる (ページ一覧から予想した時点と同じ)`,
  );
}
say("撮れた", url);
