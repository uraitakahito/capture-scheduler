/**
 * smoke の読み分けを、本物のスタックで採った答えに当てる。
 *
 * fixture (`test/fixtures/crawl/`) は 2026-09-19 に 7 通りの失敗を実際に起こして採った
 * capture-ledger と Windmill の答え (要る欄だけに削ってある)。**文を想像で書かない** ——
 * 計画の段階の予想 (BrowserHive が止まれば UNAVAILABLE) は実物と違った。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parseCrawl,
  readBusy,
  readFinished,
  readRefused,
  readRun,
  readStepFailure,
  readStuck,
  splitStep,
  stepMessage,
  type Crawl,
  type Run,
} from "../scripts/smoke/read-crawl.js";

interface Fixture {
  start: { status: number; body: unknown };
  crawl?: unknown;
  run?: unknown;
  failedStep?: unknown;
}

const fixture = (name: string): Fixture =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/crawl/${name}.json`, import.meta.url), "utf8"),
  ) as Fixture;

const crawlOf = (name: string): Crawl => {
  const crawl = parseCrawl(fixture(name).crawl);
  if (crawl === undefined) throw new Error(`${name} の crawl が読めない`);
  return crawl;
};

const failedRun = (name: string): Extract<Run, { state: "failed" }> => {
  const run = readRun(fixture(name).run);
  if (run.state !== "failed") throw new Error(`${name} の run が failed でない: ${run.state}`);
  return run;
};

const DIG = /windmill-ui\/#失敗を掘る--実例-2-つ/;

describe("撮れたとき・撮っている最中", () => {
  it("succeeded で 1 ページ以上なら、読み分けは何も言わない (中身は smoke が取り出して見る)", () => {
    expect(readFinished(crawlOf("ok"))).toBeUndefined();
    expect(readRun(fixture("ok").run)).toEqual({ state: "succeeded" });
  });

  it("走っている run (QueuedJob) は running と読む —— 失敗と取り違えて締めない", () => {
    expect(readRun(fixture("running").run)).toEqual({ state: "running" });
    expect(crawlOf("running").state).toBe("running");
  });
});

describe("台帳の error で終わったとき (締める段が締めた)", () => {
  it("F1 proto が無い → push-proto", () => {
    const reading = readFinished(crawlOf("f1-proto-missing"));
    expect(reading?.evidence).toMatch(
      /^台帳の error: \[cap\] Resource not found at u\/admin\/browserhive_proto/,
    );
    expect(reading?.fix).toBe(
      "Windmill に BrowserHive の proto が無い → pnpm run windmill:push-proto",
    );
  });

  it("F2 BrowserHive が 2 台とも止まっている → 口を挙げて stack:up", () => {
    const reading = readFinished(crawlOf("f2-browserhive-down"));
    expect(reading?.fix).toMatch(
      /^BrowserHive に届かない \(browserhive-1\.capture-ledger:50051, browserhive-2\.capture-ledger:50051\)/,
    );
    expect(reading?.fix).toMatch(/pnpm run stack:up/);
  });

  it("for ループの段 (hosts) の job に文は無い —— だから台帳の error を読む", () => {
    for (const name of ["f1-proto-missing", "f2-browserhive-down"]) {
      expect(failedRun(name).step).toBe("hosts");
      expect(stepMessage(fixture(name).failedStep)).toBeUndefined();
    }
  });
});

describe("succeeded・0 ページで終わったとき", () => {
  it("F3 名前の引けない URL → 取れなかったページとその理由を出す", () => {
    const reading = readFinished(crawlOf("f3-unresolvable"));
    expect(reading?.evidence).toBe(
      "http://nonexistent.invalid/ —— CAPTURE_STATUS_FAILED: net::ERR_NAME_NOT_RESOLVED at http://nonexistent.invalid/",
    );
    expect(reading?.fix).toMatch(/^ページの名前が引けない/);
  });
});

describe("run が失敗し、クロールが running のまま残ったとき (締める段も落ちた)", () => {
  it("F4 トークンが古い → 落ちた段の文で 401 と読み、capture-ledger-token", () => {
    const run = failedRun("f4-stale-token");
    expect(run).toMatchObject({ step: "report" });
    expect(run.closeProblem).toMatch(/\/failed → 401/);
    const reading = readStuck(run, stepMessage(fixture("f4-stale-token").failedStep));
    expect(reading.evidence).toMatch(/^run の report の段: POST \/api\/crawls\/\S+\/pages → 401/);
    expect(reading.fix).toMatch(/flow のトークンが古い .* pnpm run windmill:capture-ledger-token$/);
  });

  it("F5 API が 127.0.0.1 で待っている → 届かない、container→api", () => {
    const reading = readStuck(
      failedRun("f5-api-loopback"),
      stepMessage(fixture("f5-api-loopback").failedStep),
    );
    expect(reading.evidence).toBe(
      "run の report の段: Unable to connect. Is the computer able to access the url?",
    );
    expect(reading.fix).toMatch(/API に届かない .* container→api/);
  });

  it("F6 許可が無い → 404 と読み、fga:grant", () => {
    const reading = readStuck(
      failedRun("f6-no-permission"),
      stepMessage(fixture("f6-no-permission").failedStep),
    );
    expect(reading.fix).toMatch(
      /許可が無い → cd \.\.\/capture-ledger && pnpm run fga:grant submitter windmill acme/,
    );
  });

  it("取り消された run は、取り消されたと言う (締める段は走らないので、文は run に在る)", () => {
    const run = failedRun("canceled");
    expect(run.canceled).toBe("Job canceled: S5: 取り消しの確かめ by admin");
    expect(readStuck(run).evidence).toBe(
      "run が取り消された: Job canceled: S5: 取り消しの確かめ by admin",
    );
    expect(crawlOf("canceled").state).toBe("running");
  });

  it("段の文が取れなくても、締められなかった理由で読む (同じトークン・同じ宛先)", () => {
    const reading = readStuck(failedRun("f5-api-loopback"));
    expect(reading.evidence).toMatch(/^run の report の段: Unable to connect/);
    expect(reading.fix).toMatch(/container→api/);
  });
});

describe("起こせなかったとき", () => {
  it("F7 409 は、走っている 1 本の id と開始時刻を読む", () => {
    const { start } = fixture("f7-busy");
    expect(start.status).toBe(409);
    expect(readBusy(start.body)).toEqual({
      crawlId: "0309613d-86c2-4bf3-980c-cc8293f86aa5",
      startedAt: "2026-09-19T14:23:33.922Z",
    });
  });

  it("404 は、route が無いのと許可が無いのを分ける", () => {
    expect(
      readRefused(
        404,
        '{"message":"Route POST:/api/crawls not found","error":"Not Found","statusCode":404}',
      ).fix,
    ).toMatch(/webhook の 2 行/);
    expect(readRefused(404, '{"error":"not found"}').fix).toMatch(
      /fga:grant submitter windmill acme/,
    );
  });

  it("401 はトークン、届かなければ API を名指しする", () => {
    expect(readRefused(401, '{"error":"unauthenticated"}').fix).toMatch(
      /windmill:capture-ledger-token/,
    );
    expect(readRefused(undefined, "").fix).toMatch(/pnpm run api$/);
  });
});

describe("知らない失敗", () => {
  it("文をそのまま出し、run と「失敗を掘る」を見させる", () => {
    const reading = readFinished({
      ...crawlOf("f1-proto-missing"),
      error: "[cap] 見たことのない失敗",
    });
    expect(reading?.evidence).toBe("台帳の error: [cap] 見たことのない失敗");
    expect(reading?.fix).toMatch(DIG);
  });

  it("段の報告以外の段で Unable to connect が出ても、API のせいにはしない", () => {
    expect(
      readStepFailure("hosts", "Unable to connect. Is the computer able to access the url?"),
    ).toMatch(DIG);
  });

  it("[段] 文 を段と文に分ける。括弧が無ければ文だけ", () => {
    expect(splitStep("[cap] BrowserHive に届きません: a")).toEqual({
      step: "cap",
      message: "BrowserHive に届きません: a",
    });
    expect(splitStep("S2: F4 の片付け")).toEqual({ message: "S2: F4 の片付け" });
  });
});
