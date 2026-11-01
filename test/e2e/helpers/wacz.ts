/**
 * 台帳から取り出した WACZ を開いて、中の全 member を文字として読む。
 *
 * 「値が記録に残っていない」を言うには、datapackage.json だけでは足りない —— 値が漏れうるのは WARC の本文
 * (スクリプトが網に送れば残る)・索引・pages.jsonl・runtime.js のどれでもある。だから member を全部開く。
 * WARC と索引は gzip なので解いてから見る (WARC の gzip は record ごとの member が連なった物。node の zlib は
 * 連なった gzip を続けて解く)。
 *
 * 文字にするのは latin1 —— バイト列を 1 対 1 で文字に写すので、ASCII の印 (この試験の値は 16 進の文字列) は
 * 必ず見つかり、UTF-8 として壊れたバイトで探し損ねることも無い。
 */
import { gunzipSync } from "node:zlib";
import { strFromU8, unzipSync } from "fflate";

export type WaczMembers = Map<string, Uint8Array>;

/** 署名付き URL から WACZ を取り、member の名前 → バイト列にする。 */
export const readWacz = async (url: string): Promise<WaczMembers> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WACZ を取れない: ${String(res.status)} ${url.slice(0, 120)}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return new Map(Object.entries(unzipSync(bytes)));
};

/** `datapackage.json` (WACZ の自己記述。`settings` はここ)。 */
export const datapackageOf = (members: WaczMembers): Record<string, unknown> => {
  const raw = members.get("datapackage.json");
  if (raw === undefined) throw new Error("WACZ に datapackage.json が無い");
  return JSON.parse(strFromU8(raw)) as Record<string, unknown>;
};

/**
 * BrowserHive が書く `settings` (profile の #settings)。datapackage.json の最上位ではなく、producer の名前空間
 * `browserhive:capture` の下に在る (v22.0.0 の実物で確かめた。`conformsTo` もそこ)。
 */
export const settingsOf = (members: WaczMembers): Record<string, unknown> => {
  const capture = datapackageOf(members)["browserhive:capture"] as
    | { settings?: Record<string, unknown> }
    | undefined;
  if (capture?.settings === undefined) {
    throw new Error("datapackage.json に browserhive:capture.settings が無い");
  }
  return capture.settings;
};

/** member を文字に。gzip (`.gz`) は解いてから。 */
export const textOf = (name: string, bytes: Uint8Array): string => {
  const plain = name.endsWith(".gz") ? gunzipSync(Buffer.from(bytes)) : Buffer.from(bytes);
  return plain.toString("latin1");
};

/** `needle` を含む member の名前。空なら、どこにも無い。 */
export const membersContaining = (members: WaczMembers, needle: string): string[] =>
  [...members.entries()]
    .filter(([name, bytes]) => textOf(name, bytes).includes(needle))
    .map(([name]) => name)
    .sort();
