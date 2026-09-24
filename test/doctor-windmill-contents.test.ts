/**
 * Windmill の中身の読み分け。どれも「在る」と「repo と同じ」を分けて見る。
 *
 * 答えの形は 2026-09-19 に Windmill 1.806 で採った: 無い resource は
 * `404 Not found: Resource … not found`、super admin の token で無い workspace の
 * `users/whoami` を訊くと 200 で `non_member: true`。
 */
import { describe, expect, it } from "vitest";

import {
  readPush,
  readVariables,
  readWorkspace,
  VARIABLES,
  type Deployed,
} from "../scripts/doctor/windmill-contents.js";

const need = (verdict: { ok: boolean; need?: string }): string => verdict.need ?? "";

const whoami = (body: Record<string, unknown>) => ({ status: 200, body: JSON.stringify(body) });

describe("readWorkspace", () => {
  it("member なら ✓", () => {
    expect(readWorkspace({ workspace: "crawler", whoami: whoami({ non_member: false }) })).toEqual({
      ok: true,
    });
  });

  it("401 なら token が通らないと言い、貼り直す先を 2 つとも挙げる", () => {
    const verdict = readWorkspace({
      workspace: "crawler",
      whoami: { status: 401, body: "Not authorized: Unauthorized" },
    });
    expect(need(verdict)).toMatch(/WINDMILL_TOKEN を受けない/);
    expect(need(verdict)).toMatch(/capture-ledger の \.env/);
  });

  it("200 でも non_member で workspace が無ければ、bootstrap を言う", () => {
    const verdict = readWorkspace({
      workspace: "crawler",
      whoami: whoami({ non_member: true, email: "admin@windmill.dev" }),
      exists: false,
    });
    expect(need(verdict)).toBe("workspace crawler が無い → pnpm run windmill:bootstrap");
  });

  it("workspace が在って non_member なら、token の持ち主が member でないと言う", () => {
    const verdict = readWorkspace({
      workspace: "crawler",
      whoami: whoami({ non_member: true, email: "someone@example.com" }),
      exists: true,
    });
    expect(need(verdict)).toMatch(/^someone@example\.com は workspace crawler の member でない/);
  });

  it("読めない答えは、そのまま出す", () => {
    expect(
      need(readWorkspace({ workspace: "crawler", whoami: { status: 500, body: "boom" } })),
    ).toBe("users/whoami → 500 boom");
  });
});

describe("readPush", () => {
  const script = (path: string, repo: string, windmill: string | undefined): Deployed => ({
    path,
    kind: "script",
    exists: windmill !== undefined,
    content: { repo, windmill },
  });

  it("script の中身が同じで、flow と schedule が在れば ✓", () => {
    expect(
      readPush([
        script("f/waggle/crawl_host", "a", "a"),
        { path: "f/waggle/crawl_level", kind: "flow", exists: true },
        { path: "f/waggle/daily", kind: "schedule", exists: true },
      ]),
    ).toEqual({ ok: true });
  });

  it("中身が違う script を名指しする (在るだけでは ✓ にしない)", () => {
    const verdict = readPush([
      script("f/waggle/crawl_host", "new", "old"),
      script("f/waggle/plan_level", "a", "a"),
    ]);
    expect(need(verdict)).toBe(
      "repo と中身が違う: f/waggle/crawl_host → pnpm run windmill:push (違いを見るだけなら windmill:diff)",
    );
  });

  it("無いものは種類を添えて並べ、違うものと分けて言う", () => {
    const verdict = readPush([
      script("f/waggle/crawl_host", "a", undefined),
      script("f/waggle/plan_level", "new", "old"),
      { path: "f/waggle/crawl_level", kind: "flow", exists: false },
      { path: "f/waggle/daily", kind: "schedule", exists: true },
    ]);
    expect(need(verdict)).toMatch(
      /^Windmill に無い: f\/waggle\/crawl_host \(script\)・f\/waggle\/crawl_level \(flow\)。repo と中身が違う: f\/waggle\/plan_level → /,
    );
  });
});

describe("readVariables", () => {
  it("4 つとも在れば ✓", () => {
    expect(readVariables(new Map(VARIABLES.map((path) => [path, true])))).toEqual({ ok: true });
  });

  it("無いものを並べ、capture-ledger-token を名指しする", () => {
    const exists = new Map<string, boolean>(VARIABLES.map((path) => [path, true]));
    exists.set("u/admin/waggle_api_url", false);
    exists.delete("u/admin/browserhive_tls_ca");
    expect(need(readVariables(exists))).toBe(
      "変数が無い: u/admin/waggle_api_url・u/admin/browserhive_tls_ca → pnpm run windmill:capture-ledger-token",
    );
  });
});
