/* ===========================================================
   SignAI — 3D signing avatar (Three.js r128)
   - Two-bone IK places each hand at a body location (chin, chest, forehead…)
   - Hand orientation is set in world space (finger direction + palm normal)
   - Data-driven handshapes with two-joint fingers and an opposable thumb
   - Every vocabulary word has a clip; letters are fingerspelled
   =========================================================== */
(function (root) {
  "use strict";
  const THREE = root.THREE;

  // ---------- handshapes ----------
  // f: [index, middle, ring, pinky] curl — number 0..1 or [proximal, distal]
  // s: spread 0..1      t: [thumb curl 0..1, thumb abduction in radians]
  const HS = {
    relaxed: { f: [[0.25, 0.25], [0.28, 0.28], [0.3, 0.3], [0.32, 0.32]], s: 0.2, t: [0.3, 0.4] },
    open5:   { f: [0, 0, 0, 0], s: 1, t: [0, 1.0] },
    flat:    { f: [0, 0, 0, 0], s: 0.05, t: [0.15, 0.25] },
    B:       { f: [0, 0, 0, 0], s: 0, t: [0.95, 0.15] },
    bentB:   { f: [[0.8, 0.15], [0.8, 0.15], [0.8, 0.15], [0.8, 0.15]], s: 0.1, t: [0.3, 0.4] },
    fist:    { f: [1, 1, 1, 1], s: 0, t: [0.85, 0.35] },
    A:       { f: [1, 1, 1, 1], s: 0, t: [0.05, 0.15] },
    thumbUp: { f: [1, 1, 1, 1], s: 0, t: [0, 1.5] },
    point:   { f: [0, 1, 1, 1], s: 0, t: [0.85, 0.35] },
    V:       { f: [0, 0, 1, 1], s: 1, t: [0.85, 0.35] },
    U:       { f: [0, 0, 1, 1], s: 0, t: [0.85, 0.35] },
    W:       { f: [0, 0, 0, 1], s: 0.8, t: [0.85, 0.35] },
    three:   { f: [0, 0, 1, 1], s: 0.8, t: [0, 1.0] },
    four:    { f: [0, 0, 0, 0], s: 0.8, t: [0.95, 0.15] },
    ILY:     { f: [0, 1, 1, 0], s: 0.6, t: [0, 1.0] },
    rock:    { f: [0, 1, 1, 0], s: 0.6, t: [0.85, 0.35] },
    Y:       { f: [1, 1, 1, 0], s: 0.6, t: [0, 1.0] },
    I:       { f: [1, 1, 1, 0], s: 0.3, t: [0.85, 0.35] },
    L:       { f: [0, 1, 1, 1], s: 0, t: [0, 1.45] },
    F:       { f: [[0.6, 0.55], 0, 0, 0], s: 0.7, t: [0.55, 0.55] },
    O:       { f: [[0.5, 0.55], [0.5, 0.55], [0.5, 0.55], [0.5, 0.55]], s: 0, t: [0.55, 0.55] },
    flatO:   { f: [[0.6, 0.2], [0.6, 0.2], [0.6, 0.2], [0.6, 0.2]], s: 0, t: [0.6, 0.45] },
    C:       { f: [[0.3, 0.4], [0.3, 0.4], [0.3, 0.4], [0.3, 0.4]], s: 0, t: [0.2, 0.75] },
    E:       { f: [[0.25, 1.0], [0.25, 1.0], [0.25, 1.0], [0.25, 1.0]], s: 0, t: [0.95, 0.15] },
    D:       { f: [0, [0.55, 0.55], [0.55, 0.55], [0.55, 0.55]], s: 0, t: [0.55, 0.55] },
    S:       { f: [1, 1, 1, 1], s: 0, t: [0.95, 0.5] },
    noOpen:  { f: [0, 0, 1, 1], s: 0, t: [0.2, 0.7] },
    noShut:  { f: [[0.55, 0.4], [0.55, 0.4], 1, 1], s: 0, t: [0.55, 0.55] },
  };

  // ---------- orientations: [finger direction, palm normal] for the RIGHT hand ----------
  // (the left hand mirrors x automatically)
  const O = {
    UP_FWD:   [[0, 1, 0], [0, 0, 1]],     // fingers up, palm to the viewer
    UP_IN:    [[0, 1, 0], [-1, 0, 0]],    // fingers up, palm toward the body midline
    UP_BACK:  [[0, 1, 0], [0, 0, -1]],    // fingers up, palm toward the signer
    FWD_DOWN: [[0, 0, 1], [0, -1, 0]],
    FWD_UP:   [[0, 0, 1], [0, 1, 0]],
    FWD_IN:   [[0, 0, 1], [-1, 0, 0]],
    FWD_OUT:  [[0, 0, 1], [1, 0, 0]],
    IN_DOWN:  [[-1, 0, 0], [0, -1, 0]],
    IN_BACK:  [[-1, 0.2, 0], [0, 0, -1]],
    BACK_DOWN:[[-0.25, 0, -1], [0, -1, 0]],
    DOWN_IN:  [[0, -1, 0], [-1, 0, 0]],
  };

  // ---------- body locations (palm centre, right hand) ----------
  const LOC = {
    forehead: [0.07, 1.86, 0.37], temple: [0.17, 1.8, 0.33], mouth: [0.05, 1.71, 0.4], chin: [0.05, 1.62, 0.4],
    ear: [0.25, 1.76, 0.3], chest: [0.08, 1.27, 0.42], neutral: [0.24, 1.36, 0.5], low: [0.2, 1.1, 0.48],
  };

  const rest = side => ({ p: [side * 0.41, 0.66, 0.06], o: [[0, -1, 0], [-side, 0, 0]], h: "relaxed", world: true });
  const k = (t, R, L) => ({ t, R, L });
  const at = (p, o, h, extra = {}) => ({ p, o, h, ...extra });
  const off = (p, dx = 0, dy = 0, dz = 0) => [p[0] + dx, p[1] + dy, p[2] + dz];
  const circle = (c, r, hs, o, n = 6, L = null) => Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return k(i / n, at(off(c, Math.cos(a) * r, Math.sin(a) * r, 0), o, hs), L);
  });
  const bounce = (p, o, h, n = 2, amp = 0.03, axis = 1) => Array.from({ length: n * 2 + 1 }, (_, i) => {
    const d = i % 2 ? amp : 0;
    const q = p.slice(); q[axis] += d;
    return k(i / (n * 2), at(q, o, h));
  });

  // Left-hand helpers (positions in world space, orientation mirrored from right-hand presets)
  const Lh = (p, o, h) => ({ p, o, h });

  // ---------- sign clips ----------
  const CLIPS = {
    "hello": { dur: 1.2, keys: [k(0, at(off(LOC.forehead, 0.05), O.UP_FWD, "B")), k(0.45, at(off(LOC.forehead, 0.05), O.UP_FWD, "B")),
                                   k(1, at([0.5, 1.84, 0.42], [[0.3, 1, 0.1], [0.2, 0, 1]], "B"))] },
    "bye": { dur: 1.3, keys: [0, 0.2, 0.4, 0.6, 0.8, 1].map((t, i) => k(t, at([0.36, 1.62, 0.45], O.UP_FWD, i % 2 ? "bentB" : "open5"))) },
    "thank-you": { dur: 1.2, keys: [k(0, at(LOC.chin, O.UP_BACK, "flat")), k(0.3, at(LOC.chin, O.UP_BACK, "flat")),
                                      k(1, at([0.16, 1.38, 0.66], [[0, 0.35, 1], [0, 1, -0.35]], "flat"))] },
    "please": { dur: 1.4, keys: circle(LOC.chest, 0.07, "flat", O.IN_BACK) },
    "sorry": { dur: 1.4, keys: circle(LOC.chest, 0.07, "A", O.IN_BACK) },
    "i-love-you": { dur: 1.1, keys: [k(0, at(LOC.neutral, O.UP_FWD, "ILY")), k(0.5, at(off(LOC.neutral, 0.03, 0.03), [[0.15, 1, 0], [0, 0, 1]], "ILY")),
                                       k(1, at(LOC.neutral, O.UP_FWD, "ILY"))] },
    "nice": { dur: 1.2, keys: [
      k(0, at([0.02, 1.27, 0.32], O.FWD_DOWN, "flat"), Lh([-0.04, 1.2, 0.42], O.FWD_UP, "flat")),
      k(1, at([0.06, 1.27, 0.66], O.FWD_DOWN, "flat"), Lh([-0.04, 1.2, 0.42], O.FWD_UP, "flat"))] },

    "yes": { dur: 1.1, keys: [0, 0.25, 0.5, 0.75, 1].map((t, i) => k(t, at(LOC.neutral, i % 2 ? [[0, 0.55, 0.85], [0, -0.85, 0.55]] : O.UP_FWD, "S"))) },
    "no": { dur: 1.1, keys: [0, 0.25, 0.5, 0.75, 1].map((t, i) => k(t, at(LOC.neutral, O.UP_FWD, i % 2 ? "noShut" : "noOpen"))) },
    "ok": { dur: 1.0, keys: [k(0, at(LOC.neutral, O.UP_FWD, "F")), k(1, at(off(LOC.neutral, 0, 0.03), O.UP_FWD, "F"))] },
    "good": { dur: 1.0, keys: [k(0, at([0.24, 1.3, 0.46], O.FWD_IN, "thumbUp")), k(1, at([0.24, 1.36, 0.58], O.FWD_IN, "thumbUp"))] },
    "bad": { dur: 1.0, keys: [k(0, at([0.24, 1.36, 0.5], O.FWD_OUT, "thumbUp")), k(1, at([0.24, 1.22, 0.56], O.FWD_OUT, "thumbUp"))] },

    "you": { dur: 1.0, keys: [k(0, at([0.18, 1.3, 0.48], O.FWD_DOWN, "point")), k(1, at([0.16, 1.32, 0.64], O.FWD_DOWN, "point"))] },
    "me": { dur: 1.0, keys: [k(0, at([0.14, 1.3, 0.56], O.BACK_DOWN, "point")), k(1, at([0.1, 1.28, 0.47], O.BACK_DOWN, "point"))] },

    "what": { dur: 1.2, keys: [
      k(0, at([0.3, 1.15, 0.42], O.FWD_UP, "open5"), Lh([-0.3, 1.15, 0.42], O.FWD_UP, "open5")),
      k(0.5, at([0.36, 1.17, 0.44], [[0.3, 0, 1], [0, 1, 0]], "open5"), Lh([-0.36, 1.17, 0.44], [[0.3, 0, 1], [0, 1, 0]], "open5")),
      k(1, at([0.3, 1.15, 0.42], O.FWD_UP, "open5"), Lh([-0.3, 1.15, 0.42], O.FWD_UP, "open5"))] },
    "where": { dur: 1.2, keys: [0, 0.25, 0.5, 0.75, 1].map((t, i) =>
      k(t, at([0.28 + (i % 2 ? 0.07 : -0.02), 1.45, 0.48], i % 2 ? [[0.3, 1, 0], [0, 0, 1]] : [[-0.25, 1, 0], [0, 0, 1]], "point"))) },
    "name": { dur: 1.1, keys: [0, 0.25, 0.5, 0.75, 1].map((t, i) =>
      k(t, at([0.07, i % 2 ? 1.3 : 1.36, 0.46], O.IN_DOWN, "U"), Lh([-0.02, 1.28, 0.44], O.IN_DOWN, "U"))) },
    "think": { dur: 1.0, keys: [k(0, at(off(LOC.temple, 0.08, -0.08, 0.08), O.UP_IN, "point")), k(0.6, at(LOC.temple, O.UP_IN, "point")),
                                  k(1, at(LOC.temple, O.UP_IN, "point"))] },

    "help": { dur: 1.2, keys: [
      k(0, at([0.03, 1.24, 0.46], O.FWD_IN, "thumbUp"), Lh([-0.01, 1.14, 0.46], O.FWD_UP, "flat")),
      k(0.25, at([0.03, 1.24, 0.46], O.FWD_IN, "thumbUp"), Lh([-0.01, 1.14, 0.46], O.FWD_UP, "flat")),
      k(1, at([0.03, 1.38, 0.5], O.FWD_IN, "thumbUp"), Lh([-0.01, 1.28, 0.5], O.FWD_UP, "flat"))] },
    "water": { dur: 1.1, keys: bounce(LOC.chin, O.UP_IN, "W", 2, 0.04, 2) },
    "eat": { dur: 1.1, keys: bounce(LOC.mouth, [[-0.3, 0.5, -0.8], [0, -0.85, 0.5]], "flatO", 2, 0.05, 2) },
    "drink": { dur: 1.2, keys: [k(0, at([0.1, 1.5, 0.44], O.UP_IN, "C")), k(1, at([0.06, 1.62, 0.42], [[-0.35, 0.8, -0.5], [-0.9, -0.3, 0]], "C"))] },
    "hungry": { dur: 1.2, keys: [k(0, at([0.06, 1.45, 0.42], [[-1, 0, 0], [0, 0, -1]], "C")), k(1, at([0.06, 1.15, 0.42], [[-1, 0, 0], [0, 0, -1]], "C"))] },
    "more": { dur: 1.2, keys: [0, 0.25, 0.5, 0.75, 1].map((t, i) => {
      const g = i % 2 ? 0.05 : 0.14;
      return k(t, at([g, 1.3, 0.48], [[-1, 0, 0], [0, -1, 0]], "flatO"), Lh([-g, 1.3, 0.48], [[-1, 0, 0], [0, -1, 0]], "flatO"));
    }) },
    "stop": { dur: 1.0, keys: [
      k(0, at([0.02, 1.48, 0.48], O.FWD_IN, "B"), Lh([0, 1.16, 0.46], O.FWD_UP, "flat")),
      k(0.4, at([0.02, 1.48, 0.48], O.FWD_IN, "B"), Lh([0, 1.16, 0.46], O.FWD_UP, "flat")),
      k(0.75, at([0.02, 1.24, 0.48], O.FWD_IN, "B"), Lh([0, 1.16, 0.46], O.FWD_UP, "flat")),
      k(1, at([0.02, 1.24, 0.48], O.FWD_IN, "B"), Lh([0, 1.16, 0.46], O.FWD_UP, "flat"))] },
    "call": { dur: 1.2, keys: [k(0, at([0.3, 1.5, 0.4], O.UP_IN, "Y")), k(0.5, at(LOC.ear, O.UP_IN, "Y")), k(1, at(LOC.ear, O.UP_IN, "Y"))] },

    "one": { dur: 0.9, keys: bounce(LOC.neutral, O.UP_FWD, "point", 1, 0.03) },
    "two": { dur: 0.9, keys: bounce(LOC.neutral, O.UP_FWD, "V", 1, 0.03) },
    "three": { dur: 0.9, keys: bounce(LOC.neutral, O.UP_FWD, "three", 1, 0.03) },
    "four": { dur: 0.9, keys: bounce(LOC.neutral, O.UP_FWD, "four", 1, 0.03) },
    "rock": { dur: 1.1, keys: bounce([0.3, 1.58, 0.46], O.UP_FWD, "rock", 2, 0.04) },
  };

  // letters: handshape + optional orientation, signed at the shoulder
  const LETTER_HS = { a: "A", b: "B", c: "C", d: "D", e: "E", f: "F", g: "point", h: "U", i: "I", j: "I", k: "V", l: "L",
                      m: "S", n: "S", o: "O", p: "V", q: "point", r: "U", s: "S", t: "A", u: "U", v: "V", w: "W", x: "point",
                      y: "Y", z: "point" };
  const LETTER_O = { c: O.UP_IN, o: O.UP_IN, h: [[-1, 0.1, 0], [0, 0, 1]], g: [[-1, 0.1, 0], [0, 0, 1]],
                     p: [[0, -0.3, 1], [0, -1, -0.3]], q: [[0, -1, 0.3], [0, 0.3, 1]] };
  const SPELL_AT = [0.28, 1.46, 0.48];
  function letterClip(ch) {
    const hs = LETTER_HS[ch] || "fist";
    const o = LETTER_O[ch] || O.UP_FWD;
    return { dur: 0.6, keys: [k(0, at(SPELL_AT, o, hs)), k(1, at(off(SPELL_AT, 0.012), o, hs))], transition: 0.3 };
  }

  // ---------- avatar ----------
  class Avatar {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.onSign = opts.onSign || (() => {});
      this.onIdle = opts.onIdle || (() => {});
      this.speed = 1;
      this.queue = [];
      this.current = null;
      this.last = [];
      this._build();
      this.state = { R: this._resolveKey(rest(1), 1), L: this._resolveKey(rest(-1), -1) };
      this._applyArm(this.armR, this.state.R);
      this._applyArm(this.armL, this.state.L);
      this._resize();
      window.addEventListener("resize", () => this._resize());
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    _build() {
      const scene = this.scene = new THREE.Scene();
      const camera = this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
      camera.position.set(0, 1.5, 4.0);
      camera.lookAt(0, 1.42, 0);
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

      scene.add(new THREE.HemisphereLight(0xE0E7FF, 0x1B2347, 0.9));
      const key = new THREE.DirectionalLight(0xffffff, 0.75); key.position.set(2, 4, 3); scene.add(key);
      const rim = new THREE.PointLight(0x06B6D4, 0.6, 8); rim.position.set(-2, 2.2, 1.5); scene.add(rim);

      const floor = new THREE.Mesh(new THREE.CircleGeometry(1.6, 48),
        new THREE.MeshBasicMaterial({ color: 0x1B2347, transparent: true, opacity: 0.55 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = 0.0; scene.add(floor);

      const body = this.body = new THREE.Group();
      scene.add(body);
      const skin = this.skinMat = new THREE.MeshStandardMaterial({ color: 0xE9B98F, roughness: 0.6, metalness: 0.02 });
      const shirt = new THREE.MeshStandardMaterial({ color: 0x7C5CFF, roughness: 0.55, metalness: 0.05, emissive: 0x251A66, emissiveIntensity: 0.18 });
      const pants = new THREE.MeshStandardMaterial({ color: 0x1E2A55, roughness: 0.75 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x1A1430, roughness: 0.5 });
      const hairMat = new THREE.MeshStandardMaterial({ color: 0x2B1E16, roughness: 0.8 });

      const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 32, 32), skin);
      head.scale.set(1, 1.1, 1); head.position.set(0, 1.79, 0); body.add(head);
      const hair = new THREE.Mesh(new THREE.SphereGeometry(0.262, 32, 32, 0, Math.PI * 2, 0, Math.PI * 0.5), hairMat);
      hair.scale.set(1, 1.1, 1); hair.position.set(0, 1.81, -0.015); hair.rotation.x = -0.25; body.add(hair);
      const eyeGeo = new THREE.SphereGeometry(0.03, 16, 16);
      [-1, 1].forEach(s => {
        const eye = new THREE.Mesh(eyeGeo, dark); eye.position.set(s * 0.085, 1.82, 0.225); body.add(eye);
        const brow = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.014, 0.01), hairMat);
        brow.position.set(s * 0.085, 1.885, 0.235); brow.rotation.z = s * -0.12; body.add(brow);
        this["brow" + (s < 0 ? "L" : "R")] = brow;
      });
      const mouth = this.mouth = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.011, 8, 24, Math.PI), dark);
      mouth.position.set(0, 1.71, 0.235); mouth.rotation.z = Math.PI; body.add(mouth);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.14, 16), skin);
      neck.position.set(0, 1.56, 0); body.add(neck);

      const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.27, 0.78, 28), shirt);
      torso.position.set(0, 1.13, 0); body.add(torso);
      const shoulders = new THREE.Mesh(new THREE.SphereGeometry(0.33, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2), shirt);
      shoulders.scale.set(1.08, 0.32, 0.9); shoulders.position.set(0, 1.5, 0); body.add(shoulders);
      const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.25, 0.42, 22), pants);
      hips.position.set(0, 0.55, 0); body.add(hips);
      [-1, 1].forEach(s => {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.08, 0.6, 16), pants);
        leg.position.set(s * 0.13, 0.05, 0); body.add(leg);
      });

      this.armR = this._makeArm(1, shirt, skin);
      this.armL = this._makeArm(-1, shirt, skin);
      body.add(this.armR.root, this.armL.root);
    }

    _makeArm(side, shirt, skin) {
      const root = new THREE.Group();
      root.position.set(side * 0.36, 1.48, 0);
      const shoulderBall = new THREE.Mesh(new THREE.SphereGeometry(0.078, 16, 16), shirt); root.add(shoulderBall);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.42, 16), shirt); upper.position.y = -0.21; root.add(upper);
      const elbow = new THREE.Group(); elbow.position.y = -0.42; root.add(elbow);
      const elbowBall = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 14), skin); elbow.add(elbowBall);
      const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.4, 16), skin); forearm.position.y = -0.2; elbow.add(forearm);
      const hand = new THREE.Group(); hand.position.y = -0.4; elbow.add(hand);
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.12, 0.04), skin); palm.position.y = -0.065; hand.add(palm);

      const fingers = [];
      const xs = [-0.04, -0.013, 0.013, 0.04];
      const lens = [[0.05, 0.04], [0.055, 0.045], [0.05, 0.04], [0.04, 0.032]];
      xs.forEach((x, i) => {
        const prox = new THREE.Group(); prox.position.set(side * x, -0.125, 0); hand.add(prox);
        const m1 = new THREE.Mesh(new THREE.BoxGeometry(0.022, lens[i][0], 0.024), skin); m1.position.y = -lens[i][0] / 2; prox.add(m1);
        const dist = new THREE.Group(); dist.position.y = -lens[i][0]; prox.add(dist);
        const m2 = new THREE.Mesh(new THREE.BoxGeometry(0.02, lens[i][1], 0.022), skin); m2.position.y = -lens[i][1] / 2; dist.add(m2);
        fingers.push({ prox, dist });
      });
      const thumb = new THREE.Group(); thumb.position.set(side * -0.05, -0.045, 0.012); hand.add(thumb);
      const t1 = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.048, 0.026), skin); t1.position.y = -0.024; thumb.add(t1);
      const thumbDist = new THREE.Group(); thumbDist.position.y = -0.048; thumb.add(thumbDist);
      const t2 = new THREE.Mesh(new THREE.BoxGeometry(0.023, 0.038, 0.023), skin); t2.position.y = -0.019; thumbDist.add(t2);
      return { side, root, elbow, hand, fingers, thumb, thumbDist };
    }

    // ---------- pose resolution ----------
    _orientQuat(o, side, world) {
      let [F, N] = o;
      if (side < 0 && !world) { F = [-F[0], F[1], F[2]]; N = [-N[0], N[1], N[2]]; }
      const f = new THREE.Vector3(...F).normalize();
      let n = new THREE.Vector3(...N);
      n.addScaledVector(f, -n.dot(f)).normalize();     // make palm normal ⟂ finger direction
      const ey = f.clone().negate();                     // local -y = fingers
      const ez = n.clone().negate();                     // local -z = palm side
      const ex = new THREE.Vector3().crossVectors(ey, ez);
      const m = new THREE.Matrix4().makeBasis(ex, ey, ez);
      return new THREE.Quaternion().setFromRotationMatrix(m);
    }

    _resolveHS(h) {
      const def = typeof h === "string" ? (HS[h] || HS.relaxed) : h;
      return {
        f: def.f.map(c => (Array.isArray(c) ? c.slice() : [c, c])),
        s: def.s ?? 0.2,
        t: def.t ? def.t.slice() : [0.3, 0.4],
      };
    }

    _resolveKey(key, side) {
      if (!key) return this._resolveKey(rest(side), side);
      let p = key.p.slice();
      if (side < 0 && !key.world && key.mirror) p[0] = -p[0];
      return { p: new THREE.Vector3(...p), q: this._orientQuat(key.o, side, key.world), h: this._resolveHS(key.h) };
    }

    _lerpState(a, b, k) {
      const e = k * k * (3 - 2 * k);   // smoothstep easing
      return {
        p: a.p.clone().lerp(b.p, e),
        q: a.q.clone().slerp(b.q, e),
        h: {
          f: a.h.f.map((c, i) => [c[0] + (b.h.f[i][0] - c[0]) * e, c[1] + (b.h.f[i][1] - c[1]) * e]),
          s: a.h.s + (b.h.s - a.h.s) * e,
          t: [a.h.t[0] + (b.h.t[0] - a.h.t[0]) * e, a.h.t[1] + (b.h.t[1] - a.h.t[1]) * e],
        },
      };
    }

    // two-bone IK: put the palm centre at st.p with orientation st.q
    _applyArm(arm, st) {
      const side = arm.side;
      const S = arm.root.position.clone();
      const L1 = 0.42, L2 = 0.4, PALM = 0.065;
      const fingerDir = new THREE.Vector3(0, -1, 0).applyQuaternion(st.q);
      const W = st.p.clone().addScaledVector(fingerDir, -PALM);   // wrist target
      const d = W.clone().sub(S);
      const dist = Math.min(Math.max(d.length(), 0.08), L1 + L2 - 0.002);
      const dir = d.normalize();
      const cosA = (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist);
      const A = Math.acos(Math.max(-1, Math.min(1, cosA)));
      // elbow hangs down, out and slightly back
      const pole = new THREE.Vector3(side * 0.55, -0.75, -0.35);
      const bendDir = pole.addScaledVector(dir, -pole.dot(dir)).normalize();
      const E = S.clone().addScaledVector(dir, Math.cos(A) * L1).addScaledVector(bendDir, Math.sin(A) * L1);
      const down = new THREE.Vector3(0, -1, 0);
      const upperDir = E.clone().sub(S).normalize();
      const qUpper = new THREE.Quaternion().setFromUnitVectors(down, upperDir);
      arm.root.quaternion.copy(qUpper);
      const foreWorld = W.clone().sub(E).normalize();
      const foreLocal = foreWorld.applyQuaternion(qUpper.clone().invert());
      const qFore = new THREE.Quaternion().setFromUnitVectors(down, foreLocal);
      arm.elbow.quaternion.copy(qFore);
      const parent = qUpper.clone().multiply(qFore);
      arm.hand.quaternion.copy(parent.invert().multiply(st.q));

      // fingers and thumb
      const spreadBase = [-0.22, -0.07, 0.07, 0.22];
      arm.fingers.forEach((fg, i) => {
        const [c1, c2] = st.h.f[i];
        fg.prox.rotation.set(c1 * 1.55, 0, side * spreadBase[i] * st.h.s);
        fg.dist.rotation.set(c2 * 1.6, 0, 0);
      });
      // thumb: abducted outward when open, swings across the palm as it curls
      const [tc, ta] = st.h.t;
      arm.thumb.rotation.set(0.3 + tc * 0.35, 0, side * (-ta * (1 - tc) + 1.35 * tc));
      arm.thumbDist.rotation.set(tc * 0.5, 0, 0);
      arm.thumb.position.z = -0.004 - 0.03 * tc;   // a folded thumb rests in front of the palm
    }

    // ---------- playback ----------
    play(tokens) {
      this.queue = [];
      tokens.forEach(tok => {
        let clip, label;
        if (tok.startsWith("letter:")) { const ch = tok.slice(7); clip = letterClip(ch); label = ch.toUpperCase(); }
        else if (CLIPS[tok]) { clip = CLIPS[tok]; label = tok; }
        if (clip) this.queue.push({ token: tok, label, clip });
      });
      this.last = tokens.slice();
      this.current = null;
      this.paused = false;
    }
    replay() { if (this.last.length) this.play(this.last); }
    // freeze on one sign at progress u (0..1) — handy for debugging poses
    preview(token, u = 0.5) {
      const clip = token.startsWith("letter:") ? letterClip(token.slice(7)) : CLIPS[token];
      if (!clip) return false;
      const keys = clip.keys.map(key => ({ t: key.t, R: this._resolveKey(key.R, 1), L: this._resolveKey(key.L, -1) }));
      const fake = { start: 0, dur: clip.dur, transition: 0, from: this.state, keys };
      this.queue = []; this.current = null; this.paused = true;
      const saved = this.speed; this.speed = 1;
      this.state = this._evalClip(fake, u * clip.dur * 1000).out;
      this.speed = saved;
      return true;
    }
    stop() { this.queue = []; this.current = null; }
    has(token) { return token.startsWith("letter:") || !!CLIPS[token]; }

    _startNext(now) {
      const item = this.queue.shift();
      if (!item) {
        // glide back to rest
        this.current = { label: null, start: now, dur: 0.6, transition: 1,
                         from: { R: this.state.R, L: this.state.L }, keys: [k(0, null, null)], restClip: true };
        return;
      }
      const clip = item.clip;
      this.current = {
        label: item.label, token: item.token, start: now, dur: clip.dur, transition: clip.transition ?? 0.28,
        from: { R: this.state.R, L: this.state.L },
        keys: clip.keys.map(key => ({ t: key.t, R: this._resolveKey(key.R, 1), L: this._resolveKey(key.L, -1) })),
      };
      this.onSign(item.label, item.token);
    }

    _evalClip(c, now) {
      const elapsed = (now - c.start) / 1000 * this.speed;
      const transDur = c.restClip ? c.dur : Math.min(0.35, c.dur * c.transition);
      const total = c.restClip ? c.dur : transDur + c.dur;
      const out = {};
      ["R", "L"].forEach(side => {
        const s = side === "R" ? 1 : -1;
        const keys = c.restClip ? [{ t: 0, [side]: this._resolveKey(rest(s), s) }] : c.keys;
        if (elapsed < transDur) {
          out[side] = this._lerpState(c.from[side], keys[0][side], elapsed / transDur);
          return;
        }
        const u = Math.min(1, (elapsed - transDur) / (total - transDur || 1));
        let i = 0;
        while (i < keys.length - 1 && keys[i + 1].t < u) i++;
        const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
        const span = (b.t - a.t) || 1;
        out[side] = a === b ? a[side] : this._lerpState(a[side], b[side], Math.min(1, Math.max(0, (u - a.t) / span)));
      });
      return { out, done: elapsed >= total };
    }

    _loop() {
      const now = performance.now();
      if (this.paused) {
        // frozen by preview(): keep rendering the held pose
      } else if (!this.current || this.current.done) {
        if (this.queue.length || (this.current && !this.current.restClip)) this._startNext(now);
        else if (this.current && this.current.restClip) { this.current = null; this.onIdle(); }
      }
      if (this.current) {
        const { out, done } = this._evalClip(this.current, now);
        this.state = out;
        if (done) this.current.done = true;
      }
      this._applyArm(this.armR, this.state.R);
      this._applyArm(this.armL, this.state.L);

      // idle life: breathing + gentle sway + blink-ish brows
      const t = now / 1000;
      const busy = this.current && !this.current.restClip;
      this.body.position.y = Math.sin(t * 2) * 0.006;
      this.body.rotation.y = busy ? 0 : Math.sin(t * 0.6) * 0.06;
      const raise = busy ? 0.012 : 0;
      this.browL.position.y = 1.885 + raise; this.browR.position.y = 1.885 + raise;
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(this._loop);
    }

    _resize() {
      const wrap = this.canvas.parentElement;
      const w = wrap.clientWidth || 300, h = wrap.clientHeight || 300;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      // keep the upper body in frame on narrow / short panels
      this.camera.fov = w / h < 0.8 ? 40 : 32;
      this.camera.updateProjectionMatrix();
    }
  }

  root.SignAI = root.SignAI || {};
  root.SignAI.Avatar = Avatar;
  root.SignAI.avatarClips = Object.keys(CLIPS);
})(window);
