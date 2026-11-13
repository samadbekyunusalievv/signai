/* Synthetic hand generator for testing the recognizer without a camera.
   Builds 21 MediaPipe-style landmarks from a simple kinematic hand model:
   finger joint angles + thumb pose + whole-hand rotation + position in frame. */
"use strict";

const BONES = {
  // [mcp position x, y], [proximal, middle, distal] lengths (metres)
  index:  { base: [0.026, 0.084], len: [0.040, 0.025, 0.020], spreadDir: 0.12 },
  middle: { base: [0.004, 0.088], len: [0.045, 0.028, 0.022], spreadDir: 0.02 },
  ring:   { base: [-0.016, 0.083], len: [0.042, 0.026, 0.021], spreadDir: -0.08 },
  pinky:  { base: [-0.033, 0.073], len: [0.032, 0.020, 0.018], spreadDir: -0.2 },
};
const ORDER = ["index", "middle", "ring", "pinky"];

const v = (x, y, z) => ({ x, y, z });
const add = (a, b) => v(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a, k) => v(a.x * k, a.y * k, a.z * k);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const nrm = a => { const l = Math.hypot(a.x, a.y, a.z) || 1; return mul(a, 1 / l); };
// rotate direction d toward direction t by angle b
function bendToward(d, t, b) {
  const perp = nrm(add(t, mul(d, -dot(t, d))));
  return nrm(add(mul(d, Math.cos(b)), mul(perp, Math.sin(b))));
}

// finger spec: number (curl 0..1) or { mcp, pip, dip } in radians
function fingerAngles(spec) {
  if (typeof spec === "number") return { mcp: spec * 1.35, pip: spec * 1.75, dip: spec * 1.15 };
  return spec;
}

/**
 * shape: {
 *   fingers: [i, m, r, p]  (curl numbers or {mcp,pip,dip})
 *   spread: 0..1
 *   thumb: { yaw, lift, bend }  yaw: radians from +Y toward +X (out), lift: toward camera, bend: flex total
 *   thumbTip: optional explicit target point (hand space) the thumb tip is pulled to
 * }
 * Hand space: wrist at origin, fingers +Y, thumb on +X, palm faces +Z (the camera).
 */
function buildHand(shape) {
  const pts = new Array(21);
  pts[0] = v(0, 0, 0);
  const spread = shape.spread ?? 0.3;
  ORDER.forEach((name, fi) => {
    const b = BONES[name];
    const a = fingerAngles(shape.fingers[fi]);
    const base = v(b.base[0], b.base[1], 0);
    const sp = b.spreadDir * (spread * 2.2 - 0.35);
    let d = nrm(v(Math.sin(sp), Math.cos(sp), 0));
    const palmward = v(0, 0, 1);
    const idx = 5 + fi * 4;
    pts[idx] = base;
    let p = base;
    const angles = [a.mcp, a.pip, a.dip];
    for (let k = 0; k < 3; k++) {
      d = bendToward(d, palmward, angles[k]);
      p = add(p, mul(d, b.len[k]));
      pts[idx + k + 1] = p;
    }
  });
  // thumb
  const t = shape.thumb || { yaw: 0.9, lift: 0.2, bend: 0.1 };
  const cmc = v(0.022, 0.022, 0.006);
  pts[1] = cmc;
  let d = nrm(v(Math.sin(t.yaw), Math.cos(t.yaw), t.lift));
  const lens = [0.040, 0.031, 0.026];
  let p = cmc;
  const inward = nrm(v(-1, 0.1, 0.6));
  for (let k = 0; k < 3; k++) {
    if (k > 0) d = bendToward(d, inward, t.bend / 2);
    p = add(p, mul(d, lens[k]));
    pts[2 + k] = p;
  }
  if (shape.thumbTip) {
    // pull the thumb chain so the tip lands on a target (e.g. touching a fingertip)
    const target = typeof shape.thumbTip === "function" ? shape.thumbTip(pts) : shape.thumbTip;
    const off = add(target, mul(pts[4], -1));
    pts[2] = add(pts[2], mul(off, 0.3));
    pts[3] = add(pts[3], mul(off, 0.65));
    pts[4] = target;
  }
  return pts;
}

// rotation helpers (radians) applied in hand space
function rotX(p, a) { return v(p.x, p.y * Math.cos(a) - p.z * Math.sin(a), p.y * Math.sin(a) + p.z * Math.cos(a)); }
function rotY(p, a) { return v(p.x * Math.cos(a) + p.z * Math.sin(a), p.y, -p.x * Math.sin(a) + p.z * Math.cos(a)); }
function rotZ(p, a) { return v(p.x * Math.cos(a) - p.y * Math.sin(a), p.x * Math.sin(a) + p.y * Math.cos(a), p.z); }

/**
 * Convert hand-space points to a MediaPipe-like result entry.
 * pose: { x, y (image 0..1 of the wrist), scale (image units per metre), rx, ry, rz }
 */
function toLandmarks(pts, pose = {}) {
  const { x = 0.5, y = 0.65, scale = 2.2, rx = 0, ry = 0, rz = 0 } = pose;
  const rotated = pts.map(p => rotZ(rotY(rotX(p, rx), ry), rz));
  const image = rotated.map(p => ({ x: x + p.x * scale, y: y - p.y * scale, z: -p.z * scale }));
  const c = rotated.reduce((a, p) => add(a, mul(p, 1 / 21)), v(0, 0, 0));
  const world = rotated.map(p => ({ x: p.x - c.x, y: -(p.y - c.y), z: -(p.z - c.z) }));
  return { image, world };
}

// ---- library of handshapes ----
const THUMB_OUT = { yaw: 1.0, lift: 0.15, bend: 0.1 };
const THUMB_IN = { yaw: -0.4, lift: 0.9, bend: 1.4 };      // folded across the palm (tip pulled to ring knuckle)
const IN_TIP = pts => v(pts[13].x + 0.004, pts[13].y + 0.008, pts[13].z + 0.022);
const THUMB_SIDE = { yaw: 0.15, lift: 0.35, bend: 0.1 };    // straight along the side of a fist
const tipOf = i => pts => {
  const p = pts[i];
  return v(p.x + 0.004, p.y - 0.004, p.z + 0.008);
};

const HANDSHAPES = {
  open5:   { fingers: [0, 0, 0, 0], spread: 1, thumb: THUMB_OUT },
  flatB:   { fingers: [0, 0, 0, 0], spread: 0, thumb: THUMB_IN, thumbTip: IN_TIP },
  fist:    { fingers: [1, 1, 1, 1], spread: 0.2, thumb: { yaw: -0.5, lift: 1.0, bend: 1.0 },
             thumbTip: pts => v(pts[10].x, pts[10].y - 0.006, pts[10].z + 0.012) },
  fistA:   { fingers: [1, 1, 1, 1], spread: 0.2, thumb: THUMB_SIDE },
  thumbUp: { fingers: [1, 1, 1, 1], spread: 0.2, thumb: { yaw: 0.35, lift: 0.0, bend: 0.0 } },
  point:   { fingers: [0, 1, 1, 1], spread: 0.2, thumb: THUMB_IN, thumbTip: IN_TIP },
  vee:     { fingers: [0, 0, 1, 1], spread: 1, thumb: THUMB_IN, thumbTip: IN_TIP },
  uu:      { fingers: [0, 0, 1, 1], spread: 0, thumb: THUMB_IN, thumbTip: IN_TIP },
  www:     { fingers: [0, 0, 0, 1], spread: 0.8, thumb: THUMB_IN, thumbTip: IN_TIP },
  three:   { fingers: [0, 0, 1, 1], spread: 0.8, thumb: THUMB_OUT },
  four:    { fingers: [0, 0, 0, 0], spread: 1, thumb: THUMB_IN, thumbTip: IN_TIP },
  ily:     { fingers: [0, 1, 1, 0], spread: 0.6, thumb: THUMB_OUT },
  rock:    { fingers: [0, 1, 1, 0], spread: 0.6, thumb: THUMB_IN, thumbTip: IN_TIP },
  yhand:   { fingers: [1, 1, 1, 0], spread: 0.6, thumb: THUMB_OUT },
  pinky:   { fingers: [1, 1, 1, 0], spread: 0.6, thumb: THUMB_IN, thumbTip: IN_TIP },
  ell:     { fingers: [0, 1, 1, 1], spread: 0.2, thumb: { yaw: 1.5, lift: 0.0, bend: 0.0 } },
  okF:     { fingers: [{ mcp: 0.7, pip: 1.0, dip: 0.6 }, 0, 0, 0], spread: 0.7, thumb: THUMB_OUT, thumbTip: tipOf(8) },
  flatO:   { fingers: [{ mcp: 0.9, pip: 0.8, dip: 0.4 }, { mcp: 0.9, pip: 0.8, dip: 0.4 },
                       { mcp: 0.9, pip: 0.8, dip: 0.4 }, { mcp: 0.9, pip: 0.8, dip: 0.4 }],
             spread: 0, thumb: THUMB_OUT, thumbTip: pts => v((pts[8].x + pts[12].x) / 2, (pts[8].y + pts[12].y) / 2 - 0.005, pts[8].z + 0.006) },
  cee:     { fingers: [{ mcp: 0.5, pip: 0.75, dip: 0.4 }, { mcp: 0.5, pip: 0.75, dip: 0.4 },
                       { mcp: 0.5, pip: 0.75, dip: 0.4 }, { mcp: 0.5, pip: 0.75, dip: 0.4 }],
             spread: 0, thumb: { yaw: 0.6, lift: 0.9, bend: 0.3 } },
  pinchNo: { fingers: [{ mcp: 0.8, pip: 0.6, dip: 0.3 }, { mcp: 0.8, pip: 0.6, dip: 0.3 }, 1, 1], spread: 0,
             thumb: THUMB_OUT, thumbTip: pts => v((pts[8].x + pts[12].x) / 2, pts[8].y - 0.004, pts[8].z + 0.006) },
  dee:     { fingers: [0, { mcp: 0.8, pip: 1.0, dip: 0.6 }, { mcp: 0.8, pip: 1.0, dip: 0.6 }, { mcp: 0.8, pip: 1.0, dip: 0.6 }],
             spread: 0, thumb: THUMB_OUT, thumbTip: tipOf(12) },
  eee:     { fingers: [{ mcp: 0.4, pip: 1.6, dip: 1.0 }, { mcp: 0.4, pip: 1.6, dip: 1.0 },
                       { mcp: 0.4, pip: 1.6, dip: 1.0 }, { mcp: 0.4, pip: 1.6, dip: 1.0 }],
             spread: 0, thumb: { yaw: -0.6, lift: 0.8, bend: 1.2 },
             thumbTip: pts => v((pts[8].x + pts[12].x) / 2, pts[8].y - 0.012, pts[8].z + 0.004) },
};

module.exports = { buildHand, toLandmarks, HANDSHAPES };
