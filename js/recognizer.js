/* ===========================================================
   SignAI — sign recognizer
   MediaPipe Hands landmarks  →  features  →  scored signs  →  stable output

   Why this is more accurate than the original "finger up / down" rules:
   - Finger states come from 3D joint angles (world landmarks), so they hold
     up when the hand is rotated, tilted or far from the camera.
   - Every sign returns a soft score in 0..1 instead of a yes/no rule, so the
     best match wins and we get a real confidence + runner-up candidates.
   - Landmarks are smoothed between frames, and a short voting window means
     one noisy frame cannot trigger a sign.
   - Hand motion (wave, nod, circle, downward stroke, flapping) is tracked over
     the last second, so moving signs like HELLO, YES, PLEASE and THANK-YOU can
     be told apart from static handshapes.
   =========================================================== */
(function (root) {
  "use strict";

  // ---------- small math helpers ----------
  const clamp01 = v => Math.max(0, Math.min(1, v));
  // ramps 0 → 1 as v goes from a to b
  const hi = (v, a, b) => clamp01((v - a) / (b - a));
  // ramps 1 → 0 as v goes from a to b
  const lo = (v, a, b) => 1 - hi(v, a, b);
  // 1 inside [b, c], fading to 0 at a and d
  const band = (v, a, b, c, d) => Math.min(hi(v, a, b), lo(v, c, d));
  const min = (...xs) => Math.min(...xs);
  const max = (...xs) => Math.max(...xs);

  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
  const len = v => Math.hypot(v.x, v.y, v.z);
  const dist = (a, b) => len(sub(a, b));
  const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const norm = v => { const l = len(v) || 1e-6; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
  const norm2 = v => { const l = Math.hypot(v.x, v.y) || 1e-6; return { x: v.x / l, y: v.y / l }; };
  const angle = (u, v) => {
    const d = (u.x * v.x + u.y * v.y + u.z * v.z) / ((len(u) * len(v)) || 1e-6);
    return Math.acos(Math.max(-1, Math.min(1, d)));
  };
  // bend at joint j for the chain i → j → k (0 = perfectly straight)
  const bend = (P, i, j, k) => angle(sub(P[j], P[i]), sub(P[k], P[j]));

  const FINGERS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]; // index, middle, ring, pinky
  const IDX = 0, MID = 1, RING = 2, PINKY = 3;

  // ---------- per-frame features for one hand ----------
  function extractFeatures(lm, wl) {
    // world landmarks are metric 3D (much better for angles); image landmarks for position.
    const P = (wl && wl.length === 21) ? wl : lm.map(p => ({ x: p.x, y: p.y, z: (p.z || 0) }));
    const palm = dist(P[0], P[9]) || 1e-6;

    const curl = [], knuckle = [];
    FINGERS.forEach(([m, p, d, t]) => {
      const angleCurl = clamp01((bend(P, m, p, d) + bend(P, p, d, t)) / 2.6);
      // tip-to-wrist vs knuckle-to-wrist ratio: ~1.8 straight, ~1.0 fully curled
      const ratio = dist(P[t], P[0]) / (dist(P[m], P[0]) || 1e-6);
      const ratioCurl = clamp01((1.75 - ratio) / 0.75);
      curl.push(0.6 * angleCurl + 0.4 * ratioCurl);
      knuckle.push(bend(P, 0, m, p));
    });

    const thumbCurl = clamp01((bend(P, 1, 2, 3) + bend(P, 2, 3, 4)) / 1.6);
    const d = (a, b) => dist(P[a], P[b]) / palm;

    // image-space geometry (x right, y down, 0..1)
    const center = [0, 5, 9, 13, 17].reduce((acc, i) => ({ x: acc.x + lm[i].x / 5, y: acc.y + lm[i].y / 5 }), { x: 0, y: 0 });
    // robust on-screen hand size: palm length or 1.5 × palm width, whichever is less foreshortened
    const palmImg = Math.max(dist2(lm[0], lm[9]), 1.5 * dist2(lm[5], lm[17])) || 1e-6;
    const fingerDir = FINGERS.map(([m, , , t]) => norm2(sub(lm[t], lm[m])));
    const thumbDir = norm2(sub(lm[4], lm[2]));
    const idxWorldDir = norm(sub(P[8], P[5]));

    return {
      lm, P, palm, curl, knuckle, thumbCurl,
      thumbOut: d(4, 5),            // thumb tip → index knuckle
      thumbToMidPip: d(4, 10),      // small when the thumb wraps across the fingers (S)
      thumbToIdxPip: d(4, 6),
      tip: { idx: d(4, 8), mid: d(4, 12), ring: d(4, 16), pinky: d(4, 20) }, // thumb tip → fingertips
      spreadIM: d(8, 12), spreadMR: d(12, 16), spreadRP: d(16, 20),
      thumbIndexAngle: angle(sub(P[4], P[2]), sub(P[8], P[5])),
      center, palmImg, wristY: lm[0].y,
      fingerDir, thumbDir,
      idxToward: Math.abs(idxWorldDir.z),
      idxLen2: dist2(lm[5], lm[8]) / palmImg,
    };
  }

  // ---------- fuzzy handshape primitives ----------
  function shapes(f) {
    // extended = straight joints AND not folded at the knuckle
    const ext = f.curl.map((c, i) => min(lo(c, 0.22, 0.45), lo(f.knuckle[i], 0.45, 0.8)));
    const cur = f.curl.map(c => hi(c, 0.55, 0.80));
    const knuckleAvg = f.knuckle.reduce((a, b) => a + b, 0) / 4;
    const thumbOut = min(hi(f.thumbOut, 0.62, 0.85), lo(f.thumbCurl, 0.55, 0.85));
    const thumbIn = lo(f.thumbOut, 0.60, 0.80);
    const touch = v => lo(v, 0.22, 0.42);
    const together = lo((f.spreadIM + f.spreadMR) / 2, 0.26, 0.36);
    const spread = hi((f.spreadIM + f.spreadMR + f.spreadRP) / 3, 0.30, 0.40);
    const fourExt = min(ext[0], ext[1], ext[2], ext[3]);
    const fist = min(cur[0], cur[1], cur[2], cur[3]);
    const open5 = min(fourExt, thumbOut, spread);
    const flat = min(fourExt, together);
    const openAny = max(open5, flat);
    const meanCurl = f.curl.reduce((a, b) => a + b, 0) / 4;
    const cShape = min(
      ...f.curl.map(c => band(c, 0.15, 0.28, 0.62, 0.78)),
      band(f.tip.idx, 0.30, 0.45, 1.05, 1.35),
      lo(f.thumbCurl, 0.6, 0.9)
    );
    const flatO = min(touch(f.tip.idx), touch(f.tip.mid), lo(f.tip.ring, 0.45, 0.65), lo(f.tip.pinky, 0.55, 0.85),
                      lo(f.curl[0], 0.78, 0.92), hi(knuckleAvg, 0.5, 0.7));
    const uShape = min(thumbIn, ext[0], ext[1], cur[2], cur[3], lo(f.spreadIM, 0.28, 0.38));
    const vShape = min(thumbIn, ext[0], ext[1], cur[2], cur[3], hi(f.spreadIM, 0.36, 0.48));
    const indexOnly = min(ext[0], cur[1], cur[2], cur[3], lo(f.thumbOut, 0.75, 1.0));
    const dirIdx = f.fingerDir[0];
    const up = hi(-dirIdx.y, 0.55, 0.85);
    const horiz = hi(Math.abs(dirIdx.x), 0.6, 0.85);
    const down = hi(dirIdx.y, 0.5, 0.8);
    const toward = max(hi(f.idxToward, 0.62, 0.82), lo(f.idxLen2, 0.40, 0.62));
    // thumb sticking out of a fist (thumbs up / down): straight and clear of the curled fingers
    const thumbStraight = min(lo(f.thumbCurl, 0.4, 0.7), hi(f.thumbToIdxPip, 0.38, 0.55), hi(f.thumbToMidPip, 0.4, 0.6));
    return { knuckleAvg, ext, cur, thumbOut, thumbIn, touch, together, spread, fourExt, fist, open5, flat, openAny,
             meanCurl, cShape, flatO, uShape, vShape, indexOnly, up, horiz, down, toward, thumbStraight };
  }

  // ---------- motion over the last second ----------
  // number of direction changes bigger than thr (hysteresis, so jitter does not count)
  function countReversals(vals, thr) {
    if (vals.length < 3) return 0;
    let dir = 0, hiV = vals[0], loV = vals[0], extreme = vals[0], count = 0;
    for (let i = 1; i < vals.length; i++) {
      const v = vals[i];
      if (dir === 0) {
        hiV = Math.max(hiV, v); loV = Math.min(loV, v);
        if (hiV - v > thr) {                       // now heading down
          if (hiV - vals[0] > thr) count++;        // ...after a real rise: that is a turn
          dir = -1; extreme = v;
        } else if (v - loV > thr) {                // now heading up
          if (vals[0] - loV > thr) count++;        // ...after a real drop
          dir = 1; extreme = v;
        }
        continue;
      }
      if (dir === 1) {
        if (v > extreme) extreme = v;
        else if (extreme - v > thr) { count++; dir = -1; extreme = v; }
      } else {
        if (v < extreme) extreme = v;
        else if (v - extreme > thr) { count++; dir = 1; extreme = v; }
      }
    }
    return count;
  }

  function motionFeatures(track) {
    const empty = { revX: 0, revY: 0, netDx: 0, netDy: 0, path: 0, rangeX: 0, rangeY: 0, flaps: 0,
                    growth: 0, circle: 0, waveX: 0, bobY: 0, still: 1, downStroke: 0 };
    if (track.length < 4) return empty;
    const s = track.map(p => p.s).sort((a, b) => a - b)[Math.floor(track.length / 2)] || 1e-3;
    const xs = track.map(p => p.x / s), ys = track.map(p => p.y / s);
    // path length on ~80 ms steps so camera jitter does not add up to fake motion
    let path = 0, last = 0;
    for (let i = 1; i < track.length; i++) {
      if (track[i].t - track[last].t < 80 && i < track.length - 1) continue;
      path += Math.hypot(xs[i] - xs[last], ys[i] - ys[last]);
      last = i;
    }
    const rangeX = Math.max(...xs) - Math.min(...xs);
    const rangeY = Math.max(...ys) - Math.min(...ys);
    const revX = countReversals(xs, 0.35), revY = countReversals(ys, 0.35);
    const netDx = xs[xs.length - 1] - xs[0], netDy = ys[ys.length - 1] - ys[0];
    // open/close flapping (hysteresis)
    let flaps = 0, state = null;
    track.forEach(p => {
      const st = p.open > 0.65 ? "open" : p.open < 0.35 ? "closed" : state;
      if (state && st !== state) flaps++;
      state = st;
    });
    const growth = track[track.length - 1].s / (track[0].s || 1e-3) - 1;
    const circle = min(hi(rangeX, 0.35, 0.6), hi(rangeY, 0.35, 0.6), hi(path, 1.5, 2.5),
                       hi(Math.min(revX, revY), 0.5, 1.5),
                       lo(Math.hypot(netDx, netDy) / (path || 1), 0.35, 0.6));
    const waveX = min(hi(revX, 1.5, 2.5), lo(rangeY / (rangeX || 1e-3), 0.55, 0.9), hi(rangeX, 0.35, 0.6));
    const bobY = min(hi(revY, 1.5, 2.5), lo(rangeX / (rangeY || 1e-3), 0.55, 0.9), hi(rangeY, 0.3, 0.5));
    const span = track[track.length - 1].t - track[0].t;
    // "still" needs ~0.7 s of history so a moving sign is not read as its static cousin
    const still = min(lo(path, 0.6, 1.4), hi(span, 300, 550));
    const downStroke = min(hi(netDy, 0.7, 1.3), lo(revY, 0.5, 1.5));
    return { revX, revY, netDx, netDy, path, rangeX, rangeY, flaps, growth, circle, waveX, bobY, still, downStroke };
  }

  // ---------- sign scoring ----------
  function scoreWordsOneHand(f, m) {
    const S = shapes(f);
    const high = lo(f.wristY, 0.38, 0.52);     // wrist in the top part of the frame
    const forward = hi(m.growth, 0.15, 0.35);
    const noBigMotion = lo(max(m.circle, m.waveX, m.bobY, m.downStroke, hi(m.flaps, 1.5, 2.5)), 0.4, 0.7);
    const sc = {};
    sc["hello"] = min(max(S.open5, S.flat), max(min(high, noBigMotion, m.still), m.waveX));
    sc["bye"] = hi(m.flaps, 1.5, 2.5);
    sc["thank-you"] = min(max(S.flat, S.open5), max(m.downStroke, forward), lo(m.circle, 0.4, 0.7));
    sc["please"] = min(max(S.flat, S.open5), m.circle);
    sc["sorry"] = min(S.fist, m.circle);
    sc["yes"] = min(max(S.fist, 0.8 * S.cShape), m.bobY);
    sc["stop"] = min(S.open5, m.still, lo(high, 0.4, 0.8));
    sc["i-love-you"] = min(S.thumbOut, S.ext[IDX], S.cur[MID], S.cur[RING], S.ext[PINKY]);
    sc["rock"] = min(S.thumbIn, S.ext[IDX], S.cur[MID], S.cur[RING], S.ext[PINKY]);
    sc["call"] = min(S.thumbOut, S.cur[IDX], S.cur[MID], S.cur[RING], S.ext[PINKY]);
    sc["good"] = min(S.fist, S.thumbStraight, hi(-f.thumbDir.y, 0.55, 0.85));
    sc["bad"] = min(S.fist, S.thumbStraight, hi(f.thumbDir.y, 0.55, 0.85));
    sc["ok"] = min(S.touch(f.tip.idx), S.ext[MID], S.ext[RING], S.ext[PINKY]);
    sc["no"] = min(S.touch(f.tip.idx), S.touch(f.tip.mid), S.cur[RING], S.cur[PINKY], hi(f.tip.ring, 0.4, 0.6));
    sc["eat"] = min(S.flatO, m.still);
    sc["water"] = min(S.ext[IDX], S.ext[MID], S.ext[RING], S.cur[PINKY], S.thumbIn);
    sc["four"] = min(S.fourExt, S.thumbIn, S.spread);
    sc["three"] = min(S.thumbOut, S.ext[IDX], S.ext[MID], S.cur[RING], S.cur[PINKY]);
    sc["two"] = S.vShape;
    sc["drink"] = min(S.cShape, m.still);
    sc["hungry"] = min(S.cShape, m.downStroke);
    sc["you"] = min(S.indexOnly, S.toward);
    sc["me"] = min(S.indexOnly, lo(S.toward, 0.4, 0.7), max(S.horiz, S.down));
    sc["where"] = min(S.indexOnly, S.up, m.waveX);
    sc["think"] = min(S.indexOnly, S.up, high, m.still, lo(S.toward, 0.4, 0.7));
    sc["one"] = min(S.indexOnly, S.up, lo(high, 0.4, 0.8), m.still, lo(S.toward, 0.4, 0.7));
    return sc;
  }

  function scoreWordsTwoHands(fa, fb) {
    const A = shapes(fa), B = shapes(fb);
    const palm = (fa.palmImg + fb.palmImg) / 2;
    const gap = dist2(fa.center, fb.center) / palm;           // distance between hands in palm units
    const close = lo(gap, 1.5, 2.2);
    const apart = hi(gap, 1.9, 2.6);
    const sameHeight = lo(Math.abs(fa.center.y - fb.center.y) / palm, 0.8, 1.5);
    const sc = {};
    sc["help"] = min(max(min(max(A.fist, A.thumbStraight * A.fist), B.openAny), min(max(B.fist, B.thumbStraight * B.fist), A.openAny)), close);
    sc["what"] = min(A.openAny, B.openAny, apart, sameHeight);
    sc["nice"] = min(A.flat, B.flat, close);
    sc["more"] = min(A.flatO, B.flatO, close);
    sc["name"] = min(A.uShape, B.uShape, close);
    return sc;
  }

  function scoreLetters(f) {
    const S = shapes(f);
    const sc = {};
    const fistAcross = lo(f.thumbToMidPip, 0.28, 0.40);
    sc["letter:a"] = min(S.fist, lo(f.thumbCurl, 0.45, 0.75), lo(f.thumbOut, 0.8, 1.0), hi(f.thumbToMidPip, 0.3, 0.42),
                         hi(f.tip.idx, 0.38, 0.52), lo(S.thumbStraight, 0.5, 0.9));
    sc["letter:s"] = min(S.fist, fistAcross, hi(f.curl[IDX], 0.75, 0.9));
    sc["letter:e"] = min(hi(S.meanCurl, 0.5, 0.62), lo(S.knuckleAvg, 0.6, 0.85), lo(f.tip.idx, 0.35, 0.5), lo(f.tip.mid, 0.38, 0.55));
    sc["letter:b"] = min(S.fourExt, S.together, lo(f.thumbOut, 0.55, 0.75));
    sc["letter:c"] = S.cShape;
    sc["letter:d"] = min(S.ext[IDX], S.touch(f.tip.mid), lo(f.tip.ring, 0.4, 0.6), max(S.cur[PINKY], lo(f.tip.pinky, 0.55, 0.9)));
    sc["letter:f"] = min(S.touch(f.tip.idx), S.ext[MID], S.ext[RING], S.ext[PINKY]);
    sc["letter:h"] = min(S.uShape, S.horiz);
    sc["letter:i"] = min(S.cur[IDX], S.cur[MID], S.cur[RING], S.ext[PINKY], S.thumbIn);
    sc["letter:l"] = min(S.thumbOut, S.ext[IDX], S.cur[MID], S.cur[RING], S.cur[PINKY], hi(f.thumbIndexAngle, 0.8, 1.2));
    sc["letter:o"] = min(S.touch(f.tip.idx), S.touch(f.tip.mid), lo(f.tip.ring, 0.45, 0.65), hi(S.knuckleAvg, 0.55, 0.75),
                         ...f.curl.map(c => band(c, 0.15, 0.28, 0.72, 0.85)));
    sc["letter:u"] = min(S.uShape, lo(S.horiz, 0.4, 0.7));
    sc["letter:v"] = S.vShape;
    sc["letter:w"] = min(S.ext[IDX], S.ext[MID], S.ext[RING], S.cur[PINKY], S.thumbIn);
    sc["letter:y"] = min(S.thumbOut, S.cur[IDX], S.cur[MID], S.cur[RING], S.ext[PINKY]);
    return sc;
  }

  function rank(scores) {
    return Object.entries(scores).map(([label, score]) => ({ label, score }))
      .sort((a, b) => b.score - a.score);
  }

  // ---------- landmark smoothing ----------
  function smoothInto(prev, next, alpha) {
    if (!prev || prev.length !== next.length) return next.map(p => ({ x: p.x, y: p.y, z: p.z || 0 }));
    return next.map((p, i) => ({
      x: prev[i].x + (p.x - prev[i].x) * alpha,
      y: prev[i].y + (p.y - prev[i].y) * alpha,
      z: prev[i].z + ((p.z || 0) - prev[i].z) * alpha,
    }));
  }

  const MOTION_SIGNS = new Set(["bye", "thank-you", "please", "sorry", "yes", "where", "hungry"]);

  // ---------- the stateful recognizer ----------
  class Recognizer {
    constructor(opts = {}) {
      this.mode = opts.mode || "words";           // "words" | "letters"
      this.minConf = opts.minConf ?? 0.5;
      this.holdMs = opts.holdMs ?? 400;
      this.repeatMs = opts.repeatMs ?? 2200;
      this.windowSize = opts.windowSize ?? 8;
      this.motionMs = opts.motionMs ?? 1000;
      this.smoothAlpha = opts.smoothAlpha ?? 0.55;
      this.reset();
    }
    setMode(mode) { this.mode = mode; this.reset(); }
    reset() {
      this.smooth = [];      // per hand: { lm, wl }
      this.primaryK = null;
      this.track = [];       // primary hand motion samples
      this.votes = [];       // recent frame results
      this.stableLabel = null; this.stableSince = 0;
      this.locked = null; this.lockedAt = 0; this.releasedSince = null;
    }
    resetMotion() { this.track = []; }

    // results: MediaPipe Hands onResults payload. Returns a report for the UI.
    process(results, now = performance.now()) {
      const lms = results.multiHandLandmarks || [];
      const wls = results.multiHandWorldLandmarks || [];
      if (!lms.length) {
        this.smooth = []; this.track = []; this.primaryK = null;
        this._vote(null, now);
        return this._report(0, null, [], now);
      }
      // Keep each hand's identity between frames: match to the nearest hand seen last frame.
      if (this.smooth.length !== lms.length) this.smooth = [];
      let order = lms.map((lm, i) => i).sort((a, b) => lms[a][0].x - lms[b][0].x);
      if (this.smooth.length === 2 && lms.length === 2) {
        const d = (k, i) => dist2(this.smooth[k].lm[0], lms[i][0]);
        if (d(0, 1) + d(1, 0) < d(0, 0) + d(1, 1)) order = [1, 0]; else order = [0, 1];
      }
      const feats = order.map((i, k) => {
        const prev = this.smooth[k] || {};
        const lm = smoothInto(prev.lm, lms[i], this.smoothAlpha);
        const wl = wls[i] ? smoothInto(prev.wl, wls[i], this.smoothAlpha) : null;
        this.smooth[k] = { lm, wl };
        return extractFeatures(lm, wl);
      });

      // primary hand = biggest on screen (closest to the camera), with hysteresis so it
      // does not flip between two similar hands (that would look like fast motion)
      let pk = this.primaryK != null && this.primaryK < feats.length ? this.primaryK : 0;
      feats.forEach((f, k) => { if (f.palmImg > feats[pk].palmImg * 1.2) pk = k; });
      if (pk !== this.primaryK) { this.track = []; this.primaryK = pk; }
      const primary = feats[pk];
      const openness = 1 - primary.curl.reduce((a, b) => a + b, 0) / 4;
      this.track.push({ t: now, x: primary.center.x, y: primary.center.y, s: primary.palmImg, open: openness });
      while (this.track.length && now - this.track[0].t > this.motionMs) this.track.shift();
      const motion = motionFeatures(this.track);

      let scores;
      if (this.mode === "letters") {
        scores = scoreLetters(primary);
      } else {
        scores = scoreWordsOneHand(primary, motion);
        if (feats.length >= 2) {
          // when two hands are clearly in view, two-handed signs get priority
          Object.keys(scores).forEach(k => { scores[k] *= 0.75; });
          Object.assign(scores, scoreWordsTwoHands(feats[0], feats[1]));
        }
      }
      const ranked = rank(scores);
      const best = ranked[0];
      const frame = best && best.score > 0.2 ? best : null;
      this._vote(frame, now);
      return this._report(lms.length, frame, ranked.slice(0, 3), now, motion);
    }

    _vote(frame, now) {
      this.votes.push(frame);
      while (this.votes.length > this.windowSize) this.votes.shift();
    }

    _report(handCount, frame, top, now, motion) {
      // tally the voting window
      const tally = {};
      this.votes.forEach(v => { if (v) tally[v.label] = (tally[v.label] || 0) + v.score; });
      let label = null, conf = 0;
      Object.entries(tally).forEach(([l, s]) => { const c = s / this.windowSize; if (c > conf) { conf = c; label = l; } });
      if (conf < this.minConf) label = null;

      if (label !== this.stableLabel) { this.stableLabel = label; this.stableSince = now; }

      // release logic so the same sign can be repeated on purpose
      if (this.locked && label !== this.locked) {
        if (this.releasedSince == null) this.releasedSince = now;
        if (now - this.releasedSince > 250) { this.locked = null; this.releasedSince = null; }
      } else {
        this.releasedSince = null;
      }

      let emitted = null;
      const held = label ? now - this.stableSince : 0;
      // moving signs are only visible while the movement is in the window, so they need less hold
      const holdMs = MOTION_SIGNS.has(label) ? this.holdMs * 0.55 : this.holdMs;
      const progress = label ? Math.min(1, held / holdMs) : 0;
      if (label && held >= holdMs) {
        const canEmit = this.locked !== label || now - this.lockedAt > this.repeatMs;
        if (canEmit) {
          emitted = label;
          this.locked = label; this.lockedAt = now;
          this.track = [];  // motion signs should not fire twice off the same movement
          this.votes = [];
          this.stableSince = now;
        }
      }
      const locked = label && this.locked === label && !emitted;
      return { hands: handCount, frame, top, stable: label ? { label, conf, progress: locked ? 1 : progress, locked } : null,
               emitted, motion };
    }
  }

  const api = { Recognizer, extractFeatures, shapes, motionFeatures, scoreWordsOneHand, scoreWordsTwoHands,
                scoreLetters, countReversals };
  root.SignAI = root.SignAI || {};
  root.SignAI.recognizer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
