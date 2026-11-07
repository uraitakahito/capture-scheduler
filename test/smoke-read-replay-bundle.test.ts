/**
 * smoke が、撮った 1 本が合本に入り、replayweb-server から読めるところまでを読む読み分け (CAPTURE-57)。
 *
 * 合本の段は台帳が 200 で返す失敗では投げない (クロールを止めないため) ので、run が緑でも合本が書けたとは
 * 限らない —— 段の答えの error・failed・rev の null を、smoke が止める理由として読むかを見る。
 */
import { describe, expect, it } from "vitest";

import {
  readLedgerReplayBundle,
  readReplayBundleFailure,
  readReplayBundleOutcome,
  readReplayBundleStep,
  readReplayJson,
  replayBundleJobOf,
  replayJsonKeyUrl,
} from "../scripts/smoke/read-replay-bundle.js";

const CRAWL = "545e912c-0000-4000-8000-000000000001";
const KEY = `org/acme/crawls/${CRAWL}/r1/replay.json`;
const WROTE = { rev: 1, pages: 3, members: 1, skipped: 0, failed: 0, error: null };

describe("合本の段の答え", () => {
  const flowJob = {
    type: "CompletedJob",
    success: true,
    flow_status: {
      modules: [
        { id: "report", job: "j-report", type: "Success" },
        { id: "replay_bundle", job: "j-bundle", type: "Success" },
        { id: "index", job: "j-index", type: "Success" },
      ],
    },
  };

  it("flow の run から、合本の段（id: replay_bundle）の job を探す", () => {
    expect(replayBundleJobOf(flowJob)).toBe("j-bundle");
    expect(
      replayBundleJobOf({ flow_status: { modules: [{ id: "index", job: "j" }] } }),
    ).toBeUndefined();
    expect(replayBundleJobOf("nope")).toBeUndefined();
  });

  it("合本の段の job の result から、台帳の答えを読む", () => {
    expect(readReplayBundleOutcome({ result: WROTE })).toEqual(WROTE);
    expect(readReplayBundleOutcome({ result: { ...WROTE, rev: null } })?.rev).toBeNull();
  });

  it("形の違う答え（failed が無い・版が 0）は読めない", () => {
    const { failed: _failed, ...noFailed } = WROTE;
    expect(readReplayBundleOutcome({ result: noFailed })).toBeUndefined();
    expect(readReplayBundleOutcome({ result: { ...WROTE, rev: 0 } })).toBeUndefined();
  });

  it("書けて、検められなかった WACZ が 0 本なら止めない", () => {
    expect(readReplayBundleStep(WROTE, CRAWL)).toBeUndefined();
  });

  it("保管庫に書けなかった（error）なら止め、理由と作り直しの道具を言う", () => {
    // 段は投げないので run は緑。止めるのは smoke の役
    const reading = readReplayBundleStep(
      { ...WROTE, error: "could not write r1 to the store: connect ECONNREFUSED" },
      CRAWL,
    );
    expect(reading?.evidence).toContain("r1 を保管庫に書けなかった");
    expect(reading?.evidence).toContain("ECONNREFUSED");
    expect(reading?.fix).toContain(`pnpm run replay-bundle:rebuild --crawl ${CRAWL}`);
  });

  it("検められなかった WACZ があれば止める（書けていても）", () => {
    const reading = readReplayBundleStep({ ...WROTE, failed: 1 }, CRAWL);
    expect(reading?.evidence).toContain("検められなかった WACZ が 1 本");
    expect(reading?.fix).toContain("could not inspect this archive");
  });

  it("入れる WACZ が無く書かなかった（rev が null）なら止める", () => {
    const reading = readReplayBundleStep(
      { rev: null, pages: 0, members: 0, skipped: 1, failed: 0, error: null },
      CRAWL,
    );
    expect(reading?.evidence).toContain("書かなかった");
    expect(reading?.evidence).toContain("外した 1 本");
  });

  it("答えが読めなければ止め、flow を push し直すよう言う", () => {
    expect(readReplayBundleStep(undefined, CRAWL)?.fix).toContain("windmill:push");
  });

  it("合本の段が落ちた文を、直し方に当てる（口が無い・400）", () => {
    expect(
      readReplayBundleFailure(
        "POST /api/crawls/c/replay-bundle → 404 {} —— capture-ledger に合本の口が無い (capture-ledger が古い)",
      ),
    ).toContain("replay-bundle route");
    expect(
      readReplayBundleFailure(
        "POST /api/crawls/c/replay-bundle → 400 {} —— 台帳が本文の形を断った",
      ),
    ).toContain("版の組");
    // 401・許可の 404 は段の失敗の読み分け (readStepFailure) に任せる
    expect(readReplayBundleFailure("POST /api/crawls/c/replay-bundle → 401 {}")).toBeUndefined();
    expect(readReplayBundleFailure("知らない文")).toBeUndefined();
  });
});

describe("台帳が指す合本", () => {
  it("段が書いた版を指していれば、鍵と版を読む", () => {
    const read = readLedgerReplayBundle(
      {
        replayBundle: { key: KEY, rev: 1, pages: 3, builtAt: "2026-11-05T00:00:00Z", error: null },
      },
      1,
    );
    expect(read).toEqual({ replayBundle: { key: KEY, rev: 1 } });
  });

  it("段より新しい版を指していてもよい（指す版は前へだけ進む）", () => {
    const read = readLedgerReplayBundle({ replayBundle: { key: KEY, rev: 2 } }, 1);
    expect("replayBundle" in read && read.replayBundle.rev).toBe(2);
  });

  it("段が書いた版より古い版を指していれば止める", () => {
    const read = readLedgerReplayBundle({ replayBundle: { key: KEY, rev: 1 } }, 2);
    expect("problem" in read && read.problem.evidence).toContain(
      "r1 で、合本の段が書いた r2 より古い",
    );
  });

  it("合本を指していない（null）なら止める", () => {
    const read = readLedgerReplayBundle({ replayBundle: null }, 1);
    expect("problem" in read && read.problem.evidence).toContain("replayBundle が null");
  });

  it("欄が無い（古い capture-ledger）なら止め、そう言う", () => {
    const read = readLedgerReplayBundle({ crawlId: CRAWL, state: "succeeded" }, 1);
    expect("problem" in read && read.problem.fix).toContain("capture-ledger が古い");
  });

  it("書けたことの無い合本（key が null で error だけ）は形が違うとして止める", () => {
    const read = readLedgerReplayBundle(
      { replayBundle: { key: null, rev: null, pages: null, builtAt: null, error: "x" } },
      1,
    );
    expect("problem" in read && read.problem.evidence).toContain("形が違う");
  });
});

describe("replayweb-server から読む replay.json", () => {
  const URL_ = replayJsonKeyUrl("http://replayweb-server.test:8899", KEY);
  const ARCHIVE = "org/acme/2026-11/task 1_crawl.wacz";
  const replayJson = (paths: string[]): string =>
    JSON.stringify({
      title: "クロールの合本 r1",
      resources: paths.map((path) => ({ name: path.split("/").at(-1), path })),
      pagesQueryUrl: `/q/org/acme/crawls/${CRAWL}/r1/pages`,
    });

  it("/wacz/ の後ろの鍵は区切りごとに符号にする", () => {
    expect(replayJsonKeyUrl("http://replayweb-server.test:8899", "org/a b/r1/replay.json")).toBe(
      "http://replayweb-server.test:8899/wacz/org/a%20b/r1/replay.json",
    );
  });

  it("resources にこの回の archive の鍵があれば止めない（path の符号を解いて比べる）", () => {
    expect(
      readReplayJson(
        URL_,
        200,
        replayJson(["/wacz/org/acme/2026-11/task%201_crawl.wacz"]),
        ARCHIVE,
      ),
    ).toBeUndefined();
  });

  it("resources にこの回の archive が無ければ止める", () => {
    const reading = readReplayJson(
      URL_,
      200,
      replayJson(["/wacz/org/acme/2026-11/other.wacz"]),
      ARCHIVE,
    );
    expect(reading?.evidence).toContain(`この回の archive ${ARCHIVE} が無い`);
  });

  it("JSON でない・resources が無いなら止める", () => {
    expect(readReplayJson(URL_, 200, "<html>", ARCHIVE)?.evidence).toContain(
      "合本の replay.json でない",
    );
    expect(readReplayJson(URL_, 200, "{}", ARCHIVE)?.evidence).toContain("resources が無い");
  });

  it("404 は保管庫に無い、502 は replayweb-server が保管庫に届かない、届かなければ replayweb-server を立ち上げる", () => {
    expect(readReplayJson(URL_, 404, "", ARCHIVE)?.fix).toContain("S3_BUCKET_URL");
    expect(readReplayJson(URL_, 502, "", ARCHIVE)?.fix).toContain("保管庫に届かない");
    expect(readReplayJson(URL_, undefined, "", ARCHIVE)?.fix).toContain("pnpm run stack:up");
  });
});
