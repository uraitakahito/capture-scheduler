import { describe, it, expect, vi, afterEach } from "vitest";
import {
  clip,
  CLOSE_ATTEMPTS,
  describe as describeError,
  REASON_MAX,
  sendClose,
} from "../windmill/f/waggle/fail_crawl.js";

/**
 * 落ちた段を capture-ledger に伝える経路。
 *
 * `main` は Windmill の変数を読むので単体では回せない。ここで押さえるのは
 * **誤りを 1 行に潰す部分**で、そこがこの script の判断らしい判断のすべて。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("誤りを 1 行に潰す", () => {
  it("どの段で落ちたかを頭に出す", () => {
    // **あとから読むときにいちばん効く手がかり。** 「届かなかった」だけだと、
    // 投入で落ちたのか報告で落ちたのかが分からない。
    expect(describeError({ message: "BrowserHive に届きません", step_id: "cap" })).toBe(
      "[cap] BrowserHive に届きません",
    );
  });

  it("step_id が無ければ本文だけ", () => {
    expect(describeError({ message: "何かが起きた" })).toBe("何かが起きた");
  });

  it("文字列はそのまま", () => {
    expect(describeError("素の文字列")).toBe("素の文字列");
  });

  it("形の分からないものも落とさずに残す", () => {
    // 潰して空文字にすると、capture-ledger 側の `error` 列が「理由なし」で埋まる。
    expect(describeError({ weird: 1 })).toContain("weird");
  });

  it("null も文字にする", () => {
    expect(describeError(null)).toBe("null");
  });
});

describe("capture-ledger の reason の上限に収める", () => {
  it("2,000 字を超える文は切り、省いた字数を末尾に言う", () => {
    // **超えたまま送ると、capture-ledger が 400 で断り、行が running のまま次を全部 409 で塞ぐ。**
    // 92,314 字は、async.js をそのまま貼ったときの元の reason の長さ
    const long = `[compile] ${"x".repeat(92_304)}`;
    const out = clip(long);
    expect(out.length).toBeLessThanOrEqual(REASON_MAX);
    // 頭は残す —— どの段で落ちたかは頭に在る
    expect(out.startsWith("[compile] xxx")).toBe(true);
    // 残した字数と省いた字数で、元の長さになる（切ったことを隠さない）
    const omitted = Number(/…（(\d+) 字を省いた）$/.exec(out)?.[1]);
    expect(out.indexOf("…") + omitted).toBe(long.length);
  });

  it("2,000 字ちょうどまでは触らない", () => {
    const edge = "y".repeat(REASON_MAX);
    expect(clip(edge)).toBe(edge);
  });
});

/**
 * 締める要求の送り方 (CAPTURE-180)。capture-ledger を起こし直している間 (5xx・繋がらない) に落ちた段でも、
 * 行を running のまま残さない。4xx は試し直しても同じ答えなので 1 回で止める。
 */
describe("締める要求を送る", () => {
  const noSleep = () => Promise.resolve();
  const answer = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("5xx と繋がらないときは、間を空けて 3 回まで試す", async () => {
    const answers = [
      () => Promise.reject(new TypeError("fetch failed")),
      () => Promise.resolve(answer(503, "starting")),
      () => Promise.resolve(answer(200, { closed: true })),
    ];
    let n = 0;
    const slept: number[] = [];
    const result = await sendClose(
      () => answers[n++]!(),
      (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    );
    expect(result).toEqual({ closed: true });
    expect(n).toBe(3);
    expect(slept).toHaveLength(2);
  });

  it("3 回とも届かなければ、投げずに closed: false と理由を返す", async () => {
    let n = 0;
    const result = await sendClose(() => {
      n += 1;
      return Promise.reject(new TypeError("fetch failed"));
    }, noSleep);
    expect(n).toBe(CLOSE_ATTEMPTS);
    expect(result).toEqual({ closed: false, problem: "fetch failed" });
  });

  it("4xx は 1 回で止める（トークン・許可・本文の形は試し直しても同じ）", async () => {
    let n = 0;
    const result = await sendClose(() => {
      n += 1;
      return Promise.resolve(answer(401, "unauthorized"));
    }, noSleep);
    expect(n).toBe(1);
    expect(result.closed).toBe(false);
  });

  it("古い段の失敗で capture-ledger が締めなかった答え（closed: false）も、そのまま返す", async () => {
    await expect(
      sendClose(() => Promise.resolve(answer(200, { closed: false })), noSleep),
    ).resolves.toEqual({ closed: false });
  });
});
