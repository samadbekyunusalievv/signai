/* ===========================================================
   SignAI — trained sign classifier (250 ASL signs)
   MediaPipe Holistic frames → clip segmenter → preprocessing → ONNX model

   The preprocessing below is a line-for-line port of training/prep.py.
   tests/sign-model.test.js checks both give identical numbers.
   =========================================================== */
(function (root) {
  "use strict";

  const MAX_LEN = 32;
  const N_RAW = 107;                       // left hand 0-20, right hand 21-41, pose 42-66, lips 67-106
  const LIPS_FACE = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 146, 91, 181, 84, 17, 314, 405, 321, 375,
                     78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
  const range = (a, n) => Array.from({ length: n }, (_, i) => a + i);
  const LH = range(0, 21), RH = range(21, 21);
  const POSE_ARMS = range(42 + 11, 12);
  const LIPS = range(67, 40);
  const SELECT = [...RH, ...LH, ...POSE_ARMS, ...LIPS];
  const N_POINTS = SELECT.length;          // 94
  const POSE_PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24]];

  // point p of a mirrored frame is taken from point SWAP[p] of the original (with x flipped)
  const SWAP = range(0, N_RAW);
  for (let i = 0; i < 21; i++) { SWAP[i] = 21 + i; SWAP[21 + i] = i; }
  POSE_PAIRS.forEach(([a, b]) => { SWAP[42 + a] = 42 + b; SWAP[42 + b] = 42 + a; });

  // ---------- frames ----------
  // A frame is a Float32Array(N_RAW * 3) of x, y, z with NaN for missing points.
  function frameFromHolistic(res) {
    const f = new Float32Array(N_RAW * 3).fill(NaN);
    const put = (pts, base, idxs) => {
      if (!pts) return;
      (idxs || pts.map((_, i) => i)).forEach((src, k) => {
        const p = pts[src];
        if (!p) return;
        const o = (base + k) * 3;
        f[o] = p.x; f[o + 1] = p.y; f[o + 2] = p.z || 0;
      });
    };
    put(res.leftHandLandmarks, 0);
    put(res.rightHandLandmarks, 21);
    put(res.poseLandmarks && res.poseLandmarks.slice(0, 25), 42);
    put(res.faceLandmarks, 67, LIPS_FACE);
    return f;
  }
  const hasPart = (f, idxs) => idxs.some(i => Number.isFinite(f[i * 3]));
  const hasHand = f => hasPart(f, LH) || hasPart(f, RH);

  // ---------- preprocessing (mirror of training/prep.py) ----------
  function preprocess(frames) {
    let seq = frames;
    // 1) dominant hand into the RH slot
    const lh = seq.filter(f => hasPart(f, LH)).length;
    const rh = seq.filter(f => hasPart(f, RH)).length;
    if (lh > rh) {
      seq = seq.map(f => {
        const o = new Float32Array(N_RAW * 3);
        for (let p = 0; p < N_RAW; p++) {
          const s = SWAP[p] * 3;
          o[p * 3] = 1 - f[s]; o[p * 3 + 1] = f[s + 1]; o[p * 3 + 2] = f[s + 2];
        }
        return o;
      });
    }
    // 2) frames with a hand
    if (seq.some(hasHand)) seq = seq.filter(hasHand);
    // 3) resample to MAX_LEN
    let T = seq.length;
    if (T > MAX_LEN) {
      const picked = [];
      for (let i = 0; i < MAX_LEN; i++) picked.push(seq[Math.floor(i * (T - 1) / (MAX_LEN - 1) + 0.5)]);
      seq = picked; T = MAX_LEN;
    }
    // 4) normalise (mean per axis, RMS of centred coordinates)
    let sx = 0, sy = 0, nx = 0, ny = 0;
    seq.forEach(f => SELECT.forEach(p => {
      const x = f[p * 3], y = f[p * 3 + 1];
      if (Number.isFinite(x)) { sx += x; nx++; }
      if (Number.isFinite(y)) { sy += y; ny++; }
    }));
    let mx = 0, my = 0, std = 1;
    if (nx + ny > 0) {
      mx = nx ? sx / nx : 0; my = ny ? sy / ny : 0;
      let ss = 0, n = 0;
      seq.forEach(f => SELECT.forEach(p => {
        const x = f[p * 3], y = f[p * 3 + 1];
        if (Number.isFinite(x)) { ss += (x - mx) ** 2; n++; }
        if (Number.isFinite(y)) { ss += (y - my) ** 2; n++; }
      }));
      std = Math.sqrt(ss / n);
    }
    const div = Math.max(std, 1e-6);
    const x = new Float32Array(MAX_LEN * N_POINTS * 2);
    const mask = new Float32Array(MAX_LEN);
    seq.forEach((f, t) => {
      mask[t] = 1;
      SELECT.forEach((p, k) => {
        const vx = f[p * 3], vy = f[p * 3 + 1];
        const o = (t * N_POINTS + k) * 2;
        x[o] = Number.isFinite(vx) ? (vx - mx) / div : 0;
        x[o + 1] = Number.isFinite(vy) ? (vy - my) / div : 0;
      });
    });
    return { x, mask, T };
  }

  // ---------- clip segmentation ----------
  // Collect frames while a hand is up. A clip ends when the hands drop out of view,
  // or when the hands hold still after moving (so signs can be chained without lowering).
  class Segmenter {
    constructor(opts = {}) {
      this.dropMs = opts.dropMs ?? 350;
      this.pauseMs = opts.pauseMs ?? 500;
      this.minFrames = opts.minFrames ?? 6;
      this.maxMs = opts.maxMs ?? 3500;
      this.reset();
    }
    reset() { this.frames = []; this.start = 0; this.lastHand = 0; this.lastMove = 0; this.prevWrist = null; this.moved = 0; }
    get recording() { return this.frames.length > 0; }
    progress(now) { return this.recording ? Math.min(1, (now - this.start) / this.maxMs) : 0; }

    push(frame, now) {
      const hand = hasHand(frame);
      if (hand) {
        if (!this.recording) { this.start = now; this.lastMove = now; this.moved = 0; }
        this.frames.push(frame);
        this.lastHand = now;
        // hand speed relative to shoulder width
        const w = wristOf(frame), sw = shoulderWidth(frame) || 0.25;
        if (w && this.prevWrist) {
          const d = Math.hypot(w[0] - this.prevWrist[0], w[1] - this.prevWrist[1]) / sw;
          if (d > 0.025) { this.lastMove = now; this.moved += d; }
        }
        this.prevWrist = w;
        const still = now - this.lastMove > this.pauseMs && this.moved > 0.6 && now - this.start > 700;
        if (still || now - this.start > this.maxMs) return this._cut(still ? "pause" : "max");
        return null;
      }
      if (this.recording && now - this.lastHand > this.dropMs) return this._cut("lowered");
      return null;
    }
    _cut(reason) {
      const frames = this.frames;
      this.reset();
      return frames.length >= this.minFrames ? { frames, reason } : null;
    }
  }
  function wristOf(f) {
    for (const base of [21, 0]) if (Number.isFinite(f[base * 3])) return [f[base * 3], f[base * 3 + 1]];
    return null;
  }
  function shoulderWidth(f) {
    const a = (42 + 11) * 3, b = (42 + 12) * 3;
    return Number.isFinite(f[a]) && Number.isFinite(f[b]) ? Math.hypot(f[a] - f[b], f[a + 1] - f[b + 1]) : 0;
  }

  // ---------- labels → app tokens ----------
  // Signs the avatar / mock LLM already know map onto existing tokens; the rest stay as words.
  const TO_TOKEN = { hello: "hello", bye: "bye", thankyou: "thank-you", please: "please", yes: "yes", no: "no",
                     drink: "drink", water: "water", hungry: "hungry", think: "think", where: "where", wait: "stop",
                     callonphone: "call", food: "eat", bad: "bad", fine: "ok", minemy: "me" };
  const PRETTY = { callonphone: "call", frenchfries: "french fries", glasswindow: "window", haveto: "have to",
                   hesheit: "he/she/it", minemy: "my", weus: "we", thankyou: "thank you", icecream: "ice cream",
                   shhh: "shh", owie: "hurt", tv: "TV", yourself: "yourself" };
  const tokenFor = label => TO_TOKEN[label] || label;
  const textFor = label => PRETTY[label] || label;

  // ---------- model ----------
  class SignModel {
    constructor() { this.session = null; this.labels = []; this.info = null; }
    async load(urls) {
      const ort = root.ort;
      if (!ort) throw new Error("onnxruntime-web not loaded");
      ort.env.wasm.numThreads = 1;      // works without cross-origin isolation
      let lastErr;
      for (const base of urls) {
        try {
          const info = await (await fetch(base + "sign-model.json")).json();
          const buf = await (await fetch(base + "sign-model.onnx")).arrayBuffer();
          this.session = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
          this.info = info;
          this.labels = info.labels;
          return this;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("model not found");
    }
    get ready() { return !!this.session; }
    async classify(frames, k = 5) {
      const { x, mask } = preprocess(frames);
      const ort = root.ort;
      const out = await this.session.run({
        x: new ort.Tensor("float32", x, [1, MAX_LEN, N_POINTS, 2]),
        mask: new ort.Tensor("float32", mask, [1, MAX_LEN]),
      });
      const logits = out.logits.data;
      let m = -Infinity; for (const v of logits) m = Math.max(m, v);
      const ex = Array.from(logits, v => Math.exp(v - m));
      const sum = ex.reduce((a, b) => a + b, 0);
      return ex.map((e, i) => ({ label: this.labels[i], prob: e / sum }))
        .sort((a, b) => b.prob - a.prob).slice(0, k)
        .map(c => ({ ...c, token: tokenFor(c.label), text: textFor(c.label) }));
    }
  }

  const api = { SignModel, Segmenter, preprocess, frameFromHolistic, hasHand, tokenFor, textFor, MAX_LEN, N_POINTS, N_RAW };
  root.SignAI = root.SignAI || {};
  root.SignAI.signModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
