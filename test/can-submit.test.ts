/**
 * `GET /api/me` の答えの読み分け。
 *
 * どの行も「直すものが違う」答えを並べてある。特に 404 は 2 通り —— route が無い
 * (capture-ledger が古い) のと、capture-ledger 自身の 404 —— を分けて見る。
 */
import { describe, expect, it } from "vitest";

import { readCanSubmit } from "../scripts/doctor/can-submit.js";

const me = (body: Record<string, unknown>): string => JSON.stringify(body);

describe("readCanSubmit", () => {
  it("許可があれば ✓", () => {
    expect(
      readCanSubmit(200, me({ subject: "windmill", organizations: ["acme"], canSubmit: true })),
    ).toEqual({ ok: true });
  });

  it("許可が無ければ、capture-ledger が見た名前でコマンドを出す", () => {
    expect(
      readCanSubmit(200, me({ subject: "crawler", organizations: ["beta"], canSubmit: false })),
    ).toEqual({
      ok: false,
      need:
        "crawler に beta のクロールの許可が無い → " +
        "cd ../capture-ledger && pnpm run fga:grant submitter crawler beta",
    });
  });

  it("組織が載っていなければ、許可ではなく組織を名指しする", () => {
    const verdict = readCanSubmit(
      200,
      me({ subject: "windmill", organizations: [], canSubmit: false }),
    );
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok || verdict.need).toMatch(/CAPTURE_LEDGER_ORGANIZATIONS/);
    expect(verdict.ok || verdict.need).not.toMatch(/fga:grant/);
  });

  it("401 は、トークンのやり直しを名指しする", () => {
    const verdict = readCanSubmit(401, '{"error":"unauthenticated"}');
    expect(verdict.ok || verdict.need).toMatch(/windmill:capture-ledger-token/);
  });

  it("route が無い 404 は、capture-ledger が古いと言う", () => {
    const verdict = readCanSubmit(
      404,
      '{"message":"Route GET:/api/me not found","error":"Not Found","statusCode":404}',
    );
    expect(verdict.ok || verdict.need).toMatch(/v0\.42\.0/);
  });

  it("route が無いのではない 404 を、古いとは言わない", () => {
    const verdict = readCanSubmit(404, '{"error":"not found"}');
    expect(verdict).toMatchObject({ ok: false });
    expect(verdict.ok || verdict.need).not.toMatch(/v0\.42\.0/);
    expect(verdict.ok || verdict.need).toMatch(/not found/);
  });

  it("届かなければ、API の行を先に見させる", () => {
    const verdict = readCanSubmit(undefined, "");
    expect(verdict.ok || verdict.need).toMatch(/capture-ledger api/);
  });

  it("形の違う 200 を ✓ にしない", () => {
    expect(readCanSubmit(200, me({ canSubmit: true }))).toMatchObject({ ok: false });
    expect(readCanSubmit(200, "<html>")).toMatchObject({ ok: false });
  });
});
