import { describe, it, expect, vi, afterEach } from "vitest";
import { clip, describe as describeError, REASON_MAX } from "../windmill/f/waggle/fail_crawl.js";

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

describe("台帳の reason の上限に収める", () => {
  it("2,000 字を超える文は切り、省いた字数を末尾に言う", () => {
    // **超えたまま送ると、台帳が 400 で断り、行が running のまま次を全部 409 で塞ぐ。**
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
