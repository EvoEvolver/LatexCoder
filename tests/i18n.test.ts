import assert from "node:assert/strict";
import test from "node:test";
import { i18n, resolveLanguage, t } from "../src/client/i18n.ts";
import zh from "../src/client/locales/zh-CN.json";
import ja from "../src/client/locales/ja.json";

test("language resolution respects explicit preferences and supported browser locales", () => {
  assert.equal(resolveLanguage("en", ["zh-CN"]), "en");
  assert.equal(resolveLanguage("zh-CN", ["en-US"]), "zh-CN");
  assert.equal(resolveLanguage("ja", ["en-US"]), "ja");
  assert.equal(resolveLanguage("system", ["ja-JP", "en-US"]), "ja");
  assert.equal(resolveLanguage("system", ["fr", "JA", "zh-CN"]), "ja");
  assert.equal(resolveLanguage("system", ["en-GB", "ja-JP"]), "en");
  assert.equal(resolveLanguage("system", ["fr", "zh-Hans-SG", "en"]), "zh-CN");
  assert.equal(resolveLanguage("system", ["en-GB", "zh-CN"]), "en");
  assert.equal(resolveLanguage("system", ["zh-Hant-TW"]), "en");
  assert.equal(resolveLanguage("system", []), "en");
});

test("catalog translations cover the same messages and preserve interpolation parameters", () => {
  const parameters = (value: string) => [...value.matchAll(/{{([^}]+)}}/g)].map(match => match[1]).sort();
  assert.deepEqual(Object.keys(ja).sort(), Object.keys(zh).sort());
  for (const catalog of [zh, ja]) {
    for (const [key, value] of Object.entries(catalog)) {
      assert.ok(value.trim(), key);
      const expected = /_(one|other)$/.test(key) ? parameters(zh[key]) : parameters(key);
      assert.deepEqual(parameters(value), expected, key);
    }
  }
});

test("translated messages preserve user values and leave unknown messages readable", async () => {
  await i18n.init({ lng: "zh-CN", keySeparator: false, nsSeparator: false, interpolation: { escapeValue: false }, resources: { "zh-CN": { translation: zh }, ja: { translation: ja } } });
  assert.equal(t("Open {{v0}}", { v0: "Project <draft>.tex" }), "打开 Project <draft>.tex");
  assert.equal(t("pages", { count: 2 }), "2 页");
  assert.equal(t("Future message"), "Future message");
  await i18n.changeLanguage("ja");
  assert.equal(t("Open {{v0}}", { v0: "Project <draft>.tex" }), "Project <draft>.tex を開く");
  for (const count of [0, 1, 2]) assert.equal(t("pages", { count }), `${count} ページ`);
  assert.equal(t("comments", { name: "Project", count: 2 }), "Project がコメントしました · 2 件の投稿");
  assert.equal(t("Future message"), "Future message");
});
