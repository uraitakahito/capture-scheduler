/**
 * smoke が、撮った 1 本が索引に載り、検索に当たるところまでを読む読み分け (CAPTURE-53)。
 *
 * 当たるはずの時点は WACZ のページ一覧から決める。写しの行がある WACZ で文書の行 (`page`) が当たったら、
 * 台帳の索引の決まり (CAPTURE-48: 写しの行があれば文書の行を入れない) が外れている —— それを見逃さない。
 */
import { describe, expect, it } from "vitest";

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
} from "../scripts/smoke/read-search.js";

const HEADER = '{"format":"json-pages-1.0","id":"pages","title":"All Pages"}';
const DOC =
  '{"id":"t","url":"http://fixtures.test/marked/page/smoke?tag=a","ts":"2026-11-05T00:00:00Z","title":"title-smoke-a","text":"text-smoke-a"}';
const AFTER_LOAD =
  '{"id":"t-after-load","url":"urn:browserhive:snapshot:after-load:http://fixtures.test/marked/page/smoke?tag=a","ts":"2026-11-05T00:00:01Z","stage":"after-load","title":"title-smoke-a"}';
const AFTER_BEHAVIORS =
  '{"id":"t-after-behaviors","url":"urn:browserhive:snapshot:after-behaviors:http://fixtures.test/marked/page/smoke?tag=a","ts":"2026-11-05T00:00:02Z","stage":"after-behaviors","title":"title-smoke-a"}';

describe("smoke が撮る頁と、検索の語", () => {
  it("印付きの頁を、撮るたびに変わる印で撮り、印そのものを検索の語にする", () => {
    const { url, query } = smokeTarget("http://fixtures.test", 1_793_800_000_000, "x7k2");
    expect(url).toBe(`http://fixtures.test/marked/page/smoke?tag=${query}`);
    expect(query).toMatch(/^smoke[a-z0-9]+$/);
    expect(query).toContain("x7k2");
  });

  it("印は capture-fixtures の決まり（英小文字・数字・32 字まで）に収まり、- を含まない", () => {
    const { query } = smokeTarget(
      "http://fixtures.test",
      Number.MAX_SAFE_INTEGER,
      "AB_cd-ef0123456789xyz",
    );
    expect(query).toMatch(/^[a-z0-9]{1,32}$/);
  });

  it("時刻が違えば印も違う（前の回の取り込みに当たらない）", () => {
    const a = smokeTarget("http://fixtures.test", 1_000, "r");
    const b = smokeTarget("http://fixtures.test", 2_000, "r");
    expect(a.query).not.toBe(b.query);
  });
});

describe("索引の段の答え", () => {
  const flowJob = {
    type: "CompletedJob",
    success: true,
    flow_status: {
      modules: [
        { id: "plan", job: "j-plan", type: "Success" },
        { id: "report", job: "j-report", type: "Success" },
        { id: "index", job: "j-index", type: "Success" },
      ],
    },
  };

  it("flow の run から、索引の段（id: index）の job を探す", () => {
    expect(indexJobOf(flowJob)).toBe("j-index");
    expect(indexJobOf({ flow_status: { modules: [{ id: "report", job: "j" }] } })).toBeUndefined();
    expect(indexJobOf("nope")).toBeUndefined();
  });

  it("索引の段の job の result から 4 つの数を読む", () => {
    expect(readIndexOutcome({ result: { pending: 1, indexed: 1, failed: 0, pages: 2 } })).toEqual({
      pending: 1,
      indexed: 1,
      failed: 0,
      pages: 2,
    });
  });

  it("古い flow の答え（skipped を返し failed が無い）は読めない", () => {
    expect(readIndexOutcome({ result: { indexed: 0, pages: 0, skipped: true } })).toBeUndefined();
  });

  it("載せた 1 本以上・載らなかった 0 本なら止めない", () => {
    expect(readIndexStep({ pending: 1, indexed: 1, failed: 0, pages: 2 })).toBeUndefined();
  });

  it("載らなかったアーカイブがあれば止め、search:reindex を指す", () => {
    const reading = readIndexStep({ pending: 2, indexed: 1, failed: 1, pages: 2 });
    expect(reading?.evidence).toContain("1 本が載らなかった");
    expect(reading?.fix).toContain("search:reindex");
  });

  it("1 本も載せていなければ止める（台帳に載る前に索引の段が走った）", () => {
    expect(readIndexStep({ pending: 0, indexed: 0, failed: 0, pages: 0 })?.evidence).toContain(
      "0 本",
    );
  });

  it("答えが読めなければ止め、flow を push し直すよう言う", () => {
    expect(readIndexStep(undefined)?.fix).toContain("windmill:push");
  });

  it("索引の段が落ちた文を、直し方に当てる（503・載らなかった・404）", () => {
    expect(
      readIndexFailure(
        "POST /api/crawls/c/index → 503 {} —— capture-ledger の OpenSearch が答えない",
      ),
    ).toContain("dev:up --from search");
    expect(
      readIndexFailure("索引に入らなかったアーカイブが 1 本 (待っていた 1 本のうち)"),
    ).toContain("search:reindex");
    expect(readIndexFailure("POST /api/crawls/c/index → 404 {} —— クロールが無いか")).toContain(
      "can_submit",
    );
    expect(readIndexFailure("知らない文")).toBeUndefined();
  });
});

describe("当たるはずの時点（ページ一覧から）", () => {
  it("写しの行があれば、写しの時点だけ（文書の行は入らない）", () => {
    expect(expectedStages([HEADER, DOC, AFTER_LOAD, AFTER_BEHAVIORS].join("\n"))).toEqual([
      "after-load",
      "after-behaviors",
    ]);
  });

  it("写しの行が無ければ、文書の行の 1 件（page）", () => {
    expect(expectedStages([HEADER, DOC].join("\n"))).toEqual(["page"]);
  });

  it("見出しの行と、壊れた行は数えない", () => {
    expect(expectedStages([HEADER, "{壊れている", AFTER_LOAD, ""].join("\n"))).toEqual([
      "after-load",
    ]);
  });
});

describe("検索の当たりの照らし", () => {
  const ARCHIVE = "11111111-1111-1111-1111-111111111111";
  const OTHER = "22222222-2222-2222-2222-222222222222";

  it("答えの本文から当たりを読む（時点の無い当たりは null）", () => {
    expect(
      readSearchHits({
        hits: [
          { archiveId: ARCHIVE, stage: "after-load", title: "x" },
          { archiveId: ARCHIVE, stage: null },
        ],
        total: 2,
      }),
    ).toEqual([
      { archiveId: ARCHIVE, stage: "after-load" },
      { archiveId: ARCHIVE, stage: null },
    ]);
  });

  it("total が数でない古い答え（OpenSearch の形）は読めない", () => {
    expect(readSearchHits({ hits: [], total: { value: 0, relation: "eq" } })).toBeUndefined();
  });

  it("この archive の当たりの時点が、予想と同じなら通す（ほかの archive の当たりは見ない）", () => {
    const hits = [
      { archiveId: ARCHIVE, stage: "after-behaviors" },
      { archiveId: OTHER, stage: null },
      { archiveId: ARCHIVE, stage: "after-load" },
    ];
    expect(stagesOf(hits, ARCHIVE)).toEqual(["after-behaviors", "after-load"]);
    expect(compareSearchHits(hits, ARCHIVE, ["after-load", "after-behaviors"])).toBeUndefined();
  });

  it("写しの行がある WACZ で文書の行（page）が当たったら止める（CAPTURE-48 の決まりが外れた）", () => {
    const hits = [
      { archiveId: ARCHIVE, stage: null },
      { archiveId: ARCHIVE, stage: "after-load" },
      { archiveId: ARCHIVE, stage: "after-behaviors" },
    ];
    const reading = compareSearchHits(hits, ARCHIVE, ["after-load", "after-behaviors"]);
    expect(reading?.evidence).toContain("文書の行 (page)");
    expect(reading?.fix).toContain("v0.70.0");
  });

  it("写しの無い WACZ なら、文書の行の 1 件（page）だけが当たれば通す", () => {
    expect(
      compareSearchHits([{ archiveId: ARCHIVE, stage: null }], ARCHIVE, ["page"]),
    ).toBeUndefined();
  });

  it("当たらなければ止める（待って引き直すかは呼ぶ側が決める）", () => {
    expect(compareSearchHits([], ARCHIVE, ["after-load"])?.evidence).toContain("当たらない");
  });

  it("時点が欠けていたら止める", () => {
    const reading = compareSearchHits([{ archiveId: ARCHIVE, stage: "after-load" }], ARCHIVE, [
      "after-load",
      "after-behaviors",
    ]);
    expect(reading?.evidence).toContain("と違う");
  });
});
