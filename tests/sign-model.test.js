/* Checks that js/sign-model.js preprocesses clips exactly like training/prep.py,
   and that the clip segmenter cuts where expected. Run: node tests/sign-model.test.js */
"use strict";
const assert = require("assert");
const path = require("path");
const SM = require("../js/sign-model.js");

let n = 0;
function check(name, fn) { try { fn(); n++; } catch (e) { console.log("  ✗ " + name + "\n    " + e.message); process.exitCode = 1; } }

const cases = require(path.join(__dirname, "fixtures", "prep-cases.json"));
cases.forEach((c, ci) => check(`preprocess matches Python (case ${ci})`, () => {
  const frames = c.input.map(fr => Float32Array.from(fr.flat().map(v => (v === null ? NaN : v))));
  const { x, mask, T } = SM.preprocess(frames);
  assert.strictEqual(T, c.T, "frame count");
  assert.strictEqual(mask.reduce((a, b) => a + b, 0), c.T, "mask");
  let maxErr = 0;
  c.expected.forEach((fr, t) => fr.forEach((pt, p) => pt.forEach((v, d) => {
    maxErr = Math.max(maxErr, Math.abs(x[(t * SM.N_POINTS + p) * 2 + d] - v));
  })));
  assert.ok(maxErr < 1e-3, "max error " + maxErr);
}));

check("segmenter cuts when hands are lowered", () => {
  const seg = new SM.Segmenter();
  const frame = (hand, wx = 0.5) => {
    const f = new Float32Array(SM.N_RAW * 3).fill(NaN);
    if (hand) for (let i = 0; i < 21; i++) { f[(21 + i) * 3] = wx + i * 0.001; f[(21 + i) * 3 + 1] = 0.5; }
    return f;
  };
  let clip = null, t = 0;
  for (let i = 0; i < 20; i++) { clip = seg.push(frame(true, 0.4 + 0.01 * i), (t += 33)) || clip; }
  assert.strictEqual(clip, null, "no cut while signing");
  for (let i = 0; i < 15 && !clip; i++) clip = seg.push(frame(false), (t += 33));
  assert.ok(clip && clip.frames.length === 20 && clip.reason === "lowered");
});

console.log(`Sign model: ${n} checks passed${process.exitCode ? " (with failures above)" : ""}`);
