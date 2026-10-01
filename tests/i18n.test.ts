import assert from "node:assert/strict";
import test from "node:test";
import { i18n, resolveLanguage, t } from "../src/client/i18n.ts";
import zh from "../src/client/locales/zh-CN.json";

test("language resolution respects explicit preferences and supported browser locales", () => {
  assert.equal(resolveLanguage("en", ["zh-CN"]), "en");
  assert.equal(resolveLanguage("zh-CN", ["en-US"]), "zh-CN");
  assert.equal(resolveLanguage("system", ["fr", "zh-Hans-SG", "en"]), "zh-CN");
  assert.equal(resolveLanguage("system", ["en-GB", "zh-CN"]), "en");
  assert.equal(resolveLanguage("system", ["zh-Hant-TW"]), "en");
  assert.equal(resolveLanguage("system", []), "en");
});

test("catalog translations preserve interpolation parameters", () => {
  const parameters = (value: string) => [...value.matchAll(/{{([^}]+)}}/g)].map(match => match[1]).sort();
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(value.trim(), key);
    if (!/_(one|other)$/.test(key)) assert.deepEqual(parameters(value), parameters(key), key);
  }
});

test("translated messages preserve user values and leave unknown messages readable", async () => {
  await i18n.init({ lng: "zh-CN", keySeparator: false, nsSeparator: false, interpolation: { escapeValue: false }, resources: { "zh-CN": { translation: zh } } });
  assert.equal(t("Open {{v0}}", { v0: "Project <draft>.tex" }), "打开 Project <draft>.tex");
  assert.equal(t("pages", { count: 2 }), "2 页");
  assert.equal(t("Future message"), "Future message");
});
