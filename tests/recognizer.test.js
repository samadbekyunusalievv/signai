/* Recognizer tests on synthetic hands: node tests/recognizer.test.js
   Each case animates a handshape for ~1.6 s at 30 fps and checks which sign
   the recognizer emits first. Also includes rotated / smaller / jittered
   variants to check robustness. */
"use strict";
const { Recognizer } = require("../js/recognizer.js");
const { buildHand, toLandmarks, HANDSHAPES: H } = require("./synthetic-hand.js");

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const still = (x = 0.5, y = 0.65, extra = {}) => ({ x, y, ...extra });
const wave = (y = 0.6) => t => ({ x: 0.5 + 0.06 * Math.sin(t * 2 * Math.PI * 2.2), y });
const bob = t => ({ x: 0.5, y: 0.62 + 0.05 * Math.sin(t * 2 * Math.PI * 2.2) });
const circle = t => ({ x: 0.5 + 0.06 * Math.cos(t * 2 * Math.PI * 1.6), y: 0.68 + 0.06 * Math.sin(t * 2 * Math.PI * 1.6) });
const downStroke = t => ({ x: 0.5, y: 0.35 + Math.min(t, 0.7) * 0.32 });

// flapping hand for BYE alternates open/closed shapes
const flapShape = t => (Math.floor(t * 5) % 2 === 0 ? H.open5 : H.fist);

const CASES = [
  // [expected, mode, hands]
  ["hello", "words", [{ shape: H.open5, pose: still(0.5, 0.42) }]],
  ["hello", "words", [{ shape: H.open5, pose: wave(0.6) }]],
  ["stop", "words", [{ shape: H.open5, pose: still(0.5, 0.75) }]],
  ["thank-you", "words", [{ shape: H.flatB, pose: downStroke }]],
  ["please", "words", [{ shape: H.flatB, pose: circle }]],
  ["sorry", "words", [{ shape: H.fist, pose: circle }]],
  ["yes", "words", [{ shape: H.fist, pose: bob }]],
  ["i-love-you", "words", [{ shape: H.ily, pose: still() }]],
  ["rock", "words", [{ shape: H.rock, pose: still() }]],
  ["call", "words", [{ shape: H.yhand, pose: still() }]],
  ["good", "words", [{ shape: H.thumbUp, pose: still() }]],
  ["bad", "words", [{ shape: H.thumbUp, pose: still(0.5, 0.5, { rz: Math.PI }) }]],
  ["ok", "words", [{ shape: H.okF, pose: still() }]],
  ["no", "words", [{ shape: H.pinchNo, pose: still() }]],
  ["eat", "words", [{ shape: H.flatO, pose: still() }]],
  ["water", "words", [{ shape: H.www, pose: still() }]],
  ["four", "words", [{ shape: H.four, pose: still() }]],
  ["three", "words", [{ shape: H.three, pose: still() }]],
  ["two", "words", [{ shape: H.vee, pose: still() }]],
  ["drink", "words", [{ shape: H.cee, pose: still() }]],
  ["hungry", "words", [{ shape: H.cee, pose: downStroke }]],
  ["you", "words", [{ shape: H.point, pose: still(0.5, 0.65, { rx: -1.45 }) }]],
  ["me", "words", [{ shape: H.point, pose: still(0.5, 0.65, { rz: 1.5 }) }]],
  ["where", "words", [{ shape: H.point, pose: wave(0.65) }]],
  ["think", "words", [{ shape: H.point, pose: still(0.5, 0.42) }]],
  ["one", "words", [{ shape: H.point, pose: still(0.5, 0.75) }]],
  ["help", "words", [{ shape: H.fist, pose: still(0.5, 0.62) }, { shape: H.flatB, pose: still(0.5, 0.82, { rx: -1.2 }) }]],
  ["what", "words", [{ shape: H.open5, pose: still(0.25, 0.7) }, { shape: H.open5, pose: still(0.75, 0.7) }]],
  ["nice", "words", [{ shape: H.flatB, pose: still(0.45, 0.7) }, { shape: H.flatB, pose: still(0.58, 0.72) }]],
  ["more", "words", [{ shape: H.flatO, pose: still(0.45, 0.7) }, { shape: H.flatO, pose: still(0.58, 0.7) }]],
  ["name", "words", [{ shape: H.uu, pose: still(0.45, 0.7) }, { shape: H.uu, pose: still(0.58, 0.72) }]],
  // bye uses a time-varying shape
  ["bye", "words", [{ shapeAt: flapShape, pose: still(0.5, 0.6) }]],

  // letters
  ["letter:a", "letters", [{ shape: H.fistA, pose: still() }]],
  ["letter:s", "letters", [{ shape: H.fist, pose: still() }]],
  ["letter:e", "letters", [{ shape: H.eee, pose: still() }]],
  ["letter:b", "letters", [{ shape: H.flatB, pose: still() }]],
  ["letter:c", "letters", [{ shape: H.cee, pose: still() }]],
  ["letter:d", "letters", [{ shape: H.dee, pose: still() }]],
  ["letter:f", "letters", [{ shape: H.okF, pose: still() }]],
  ["letter:h", "letters", [{ shape: H.uu, pose: still(0.5, 0.65, { rz: 1.5 }) }]],
  ["letter:i", "letters", [{ shape: H.pinky, pose: still() }]],
  ["letter:l", "letters", [{ shape: H.ell, pose: still() }]],
  ["letter:o", "letters", [{ shape: H.flatO, pose: still() }]],
  ["letter:u", "letters", [{ shape: H.uu, pose: still() }]],
  ["letter:v", "letters", [{ shape: H.vee, pose: still() }]],
  ["letter:w", "letters", [{ shape: H.www, pose: still() }]],
  ["letter:y", "letters", [{ shape: H.yhand, pose: still() }]],
];

// Robustness variants for static signs: tilt, smaller hand, more jitter
const VARIANTS = [
  { name: "base", tweak: p => p, jitter: 0.002 },
  { name: "tilted", tweak: p => ({ ...p, rz: (p.rz || 0) + 0.35, ry: (p.ry || 0) + 0.35 }), jitter: 0.002 },
  // (two-hand cases also pull the hands together, as they would be when the person stands further away)
  { name: "far+noisy", tweak: (p, n) => (n > 1 ? { ...p, scale: 1.4, x: 0.5 + (p.x - 0.5) * 0.64, y: 0.65 + (p.y - 0.65) * 0.64 } : { ...p, scale: 1.4 }), jitter: 0.004 },
];

let pass = 0, fail = 0;
const failures = [];
CASES.forEach(([expected, mode, hands]) => {
  const isStatic = hands.every(h => typeof h.pose !== "function" && !h.shapeAt);
  const variants = isStatic ? VARIANTS : VARIANTS.slice(0, 1);
  variants.forEach(variant => {
    const hs = hands.map(h => {
      if (h.shapeAt) {
        // time-varying handshape (e.g. BYE flapping): re-evaluated every frame
        return { get shape() { return h.shapeAt(globalThis.__t || 0); }, pose: h.pose };
      }
      return { shape: h.shape, pose: typeof h.pose === "function" ? h.pose : variant.tweak(h.pose, hands.length) };
    });
    const res = runWithTime(mode, hs, variant.jitter);
    const ok = res.emitted[0] === expected;
    if (ok) pass++; else {
      fail++;
      failures.push(`${expected.padEnd(11)} [${variant.name}] → emitted ${JSON.stringify(res.emitted)}  top: ${res.top.map(t => t.label + ":" + t.score.toFixed(2)).join(", ")}`);
    }
  });
});

function runWithTime(mode, hands, jitter) {
  const rec = new Recognizer({ mode });
  const rand = rng(7);
  const emitted = []; let top = [];
  for (let f = 0; f < 1.6 * 30; f++) {
    const t = f / 30; globalThis.__t = t;
    const res = { multiHandLandmarks: [], multiHandWorldLandmarks: [], multiHandedness: [] };
    hands.forEach(h => {
      const pose = typeof h.pose === "function" ? h.pose(t) : h.pose;
      const { image, world } = toLandmarks(buildHand(h.shape), pose);
      res.multiHandLandmarks.push(image.map(p => ({ x: p.x + (rand() - 0.5) * jitter, y: p.y + (rand() - 0.5) * jitter, z: p.z })));
      res.multiHandWorldLandmarks.push(world);
    });
    const r = rec.process(res, t * 1000);
    top = r.top; if (r.emitted) emitted.push(r.emitted);
  }
  return { emitted, top };
}

console.log(`Recognizer: ${pass} passed, ${fail} failed`);
failures.forEach(f => console.log("  ✗ " + f));
process.exit(fail ? 1 : 0);
