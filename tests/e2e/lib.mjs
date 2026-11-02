import { createRequire } from "module";
export const { chromium } = createRequire(import.meta.url)("playwright");
export function reporter() {
  const results = [];
  const ok = (n, c, extra = "") => { results.push([n, !!c]); console.log((c ? "PASS " : "FAIL ") + n + (extra ? "  " + extra : "")); };
  const done = () => { const f = results.filter(r => !r[1]); console.log(`\n${results.length - f.length}/${results.length} controlli superati`); return f.length ? 1 : 0; };
  return { ok, done };
}
