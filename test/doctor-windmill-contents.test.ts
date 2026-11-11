/**
 * Windmill の中身の読み分け。どれも「在る」と「repo と同じ」を分けて見る。
 *
 * 答えの形は 2026-09-19 に Windmill 1.806 で採った: 無い resource は
 * `404 Not found: Resource … not found`、super admin の token で無い workspace の
 * `users/whoami` を訊くと 200 で `non_member: true`。
 */
import { describe, expect, it } from "vitest";

import {
  readCatalog,
  readPush,
  readSecretsFolder,
  readVariables,
  readWorkspace,
  SECRETS_FOLDER_NAME,
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
      whoami: whoami({ non_member: true, email: "someone@site.test" }),
      exists: true,
    });
    expect(need(verdict)).toMatch(/^someone@site\.test は workspace crawler の member でない/);
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

  it("script の中身が同じで、flow が在れば ✓", () => {
    expect(
      readPush([
        script("f/waggle/crawl_host", "a", "a"),
        { path: "f/waggle/crawl_level", kind: "flow", exists: true },
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
    ]);
    expect(need(verdict)).toMatch(
      /^Windmill に無い: f\/waggle\/crawl_host \(script\)・f\/waggle\/crawl_level \(flow\)。repo と中身が違う: f\/waggle\/plan_level → /,
    );
  });
});

describe("readCatalog", () => {
  const listed = (scripts: unknown[]) => ({ status: 200, body: JSON.stringify({ scripts }) });

  it("既定に入るスクリプトが 1 つでも在れば ✓ —— 既定に入らない物が並んでいても", () => {
    expect(
      readCatalog(
        listed([
          { id: "autofetch", enabled: false },
          { id: "autoscroll", enabled: true },
        ]),
      ),
    ).toEqual({ ok: true });
  });

  it("enabled の無い行 (capture-ledger v0.64.0 より前) は、既定に数える", () => {
    expect(readCatalog(listed([{ id: "autoscroll" }]))).toEqual({ ok: true });
  });

  it("全部が既定に入らなければ ✗ —— 何も名指さないクロールは 400 で断られる", () => {
    expect(need(readCatalog(listed([{ id: "autofetch", enabled: false }])))).toMatch(
      /^登録済みのスクリプトが全部、既定に入らない .*、pnpm run scripts enable <id>$/,
    );
  });

  it("空なら、取り込みを言う", () => {
    expect(need(readCatalog(listed([])))).toMatch(/^登録済みのスクリプトが無い .* scripts import /);
  });

  it("404 は許可を疑う", () => {
    expect(need(readCatalog({ status: 404, body: "" }))).toMatch(/can_submit/);
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

describe("readSecretsFolder", () => {
  // folders/exists の答えは variables/exists と同じく、素の真偽値の本文で 200 (2026-11-01 実測)。
  it("在れば ✓", () => {
    expect(readSecretsFolder({ status: 200, body: "true" })).toEqual({ ok: true });
  });

  it("無ければ push を言う —— 変数と違って、フォルダは git の物", () => {
    // API や UI で作っても次の push で消える (wmill sync push は手元に無いフォルダを消す) ので、
    // 直し方は capture-ledger-token ではなく push。
    const verdict = readSecretsFolder({ status: 200, body: "false" });
    expect(need(verdict)).toMatch(/^フォルダ f\/waggle_secrets が無い → pnpm run windmill:push /);
    expect(need(verdict)).toContain(`windmill/f/${SECRETS_FOLDER_NAME}/folder.meta.yaml`);
    expect(need(verdict)).not.toMatch(/capture-ledger-token/);
  });

  it("読めない答えは、そのまま出す", () => {
    expect(need(readSecretsFolder({ status: 500, body: "boom" }))).toBe(
      "folders/exists/waggle_secrets → 500 boom",
    );
  });
});
