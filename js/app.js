/* ===========================================================
   SignAI — app wiring
   camera → recognizer → message tray → LLM (mock or API) → chat + avatar
   =========================================================== */
(function () {
  "use strict";
  const { vocab, recognizer: R, mockLLM, signModel: SM } = window.SignAI;
  const $ = id => document.getElementById(id);

  // ---------------- state ----------------
  const rec = new R.Recognizer({ mode: "words" });
  let mode = "words";          // "ai" (trained 250-sign model) | "words" (30 rule-based signs) | "letters"
  const model = SM ? new SM.SignModel() : null;
  const segmenter = SM ? new SM.Segmenter() : null;
  let lastAiIndex = -1;        // tray position of the last sign added by the AI model (for corrections)
  const mock = new mockLLM.MockLLM();
  let tray = [];               // tokens waiting to be sent
  let trayAlts = [];           // per token: other likely signs the recognizer considered
  let lastTokenAt = 0;
  let handsVisible = 0;
  const history = [];          // chat history for API mode [{role, content}]

  // ---------------- sign library ----------------
  const CAT_LABEL = { social: "Social", answer: "Answers", people: "People", question: "Questions", need: "Needs", number: "Numbers & fun" };
  const chipEls = {};
  function renderLibrary() {
    const lib = $("library");
    lib.innerHTML = "";
    Object.keys(chipEls).forEach(k => delete chipEls[k]);
    if (mode === "ai") {
      $("lib-title").textContent = `${model.labels.length} signs the AI model knows — click to add`;
      const filter = document.createElement("input");
      filter.className = "lib-filter"; filter.placeholder = "Search signs…"; filter.type = "search";
      lib.appendChild(filter);
      const box = document.createElement("div"); box.className = "chips"; lib.appendChild(box);
      const items = model.labels.map(l => ({ token: SM.tokenFor(l), text: SM.textFor(l) })).sort((a, b) => a.text.localeCompare(b.text));
      const draw = () => {
        const q = filter.value.trim().toLowerCase();
        box.innerHTML = "";
        items.filter(i => !q || i.text.includes(q)).forEach(i =>
          box.appendChild(makeChip(i.token, i.text, "Sign it as in ASL (from Google's isolated-sign dataset), then lower your hands.", false)));
      };
      filter.addEventListener("input", draw);
      draw();
      return;
    }
    $("lib-title").textContent = "Signs I know — click to add, hover for how to sign";
    if (rec.mode === "letters") {
      vocab.LETTERS.forEach(l => lib.appendChild(makeChip("letter:" + l.id, l.id, l.hint, true)));
      const all = document.createElement("div");
      all.className = "chip-group";
      all.textContent = "Other letters: type them, or click to add";
      lib.appendChild(all);
      "gjkmnpqrtxz".split("").forEach(ch => lib.appendChild(makeChip("letter:" + ch, ch, "Not readable by the camera yet — click to add it.", true)));
    } else {
      let cat = null;
      vocab.WORDS.forEach(w => {
        if (w.cat !== cat) {
          cat = w.cat;
          const g = document.createElement("div"); g.className = "chip-group"; g.textContent = CAT_LABEL[cat] || cat;
          lib.appendChild(g);
        }
        lib.appendChild(makeChip(w.id, w.text.toLowerCase(), w.hint, false));
      });
    }
  }
  function makeChip(token, text, hint, letter) {
    const el = document.createElement("button");
    el.className = "chip" + (letter ? " letter" : "");
    el.textContent = text;
    el.title = hint;
    el.addEventListener("click", () => addToken(token));
    el.addEventListener("mouseenter", () => showHint(token, hint));
    el.addEventListener("focus", () => showHint(token, hint));
    chipEls[token] = el;
    return el;
  }
  function showHint(token, hint) {
    const name = vocab.isLetterToken(token) ? "Letter " + vocab.letterOf(token).toUpperCase() : (vocab.byId[token] || {}).text || prettyOf(token);
    $("hint").innerHTML = `<b>${escapeHtml(name || token)}</b> — ${escapeHtml(hint)}`;
  }
  function flashChip(token) {
    const el = chipEls[token];
    if (!el) return;
    el.classList.add("active");
    setTimeout(() => el.classList.remove("active"), 1200);
  }
  function prettyOf(token) { return SM ? SM.textFor(token) : token; }
  function labelOf(token) {
    if (!token) return "";
    if (vocab.isLetterToken(token)) return vocab.letterOf(token).toUpperCase();
    return (vocab.byId[token] ? vocab.byId[token].text : prettyOf(token)).toUpperCase();
  }

  // ---------------- mode switch ----------------
  const HINTS = {
    ai: "Sign one word, then lower your hands (or hold still) — the AI model reads the whole movement. Tap a guess below if it picked the wrong word.",
    words: "Tip: hold a sign steady for about half a second. Moving signs (hello wave, yes nod, please circle) are read from the motion.",
    letters: "Fingerspelling: hold each letter still for half a second. Lower your hand between words. Repeat a letter by moving off it briefly.",
  };
  function setMode(m) {
    if (m === "ai" && !(model && model.ready)) return;
    mode = m;
    if (m !== "ai") rec.setMode(m);
    if (segmenter) segmenter.reset();
    ["ai", "words", "letters"].forEach(k => {
      $("mode-" + k).classList.toggle("active", k === m);
      $("mode-" + k).setAttribute("aria-selected", k === m);
    });
    renderLibrary();
    $("hint").textContent = HINTS[m];
    lastCandKey = null;
    $("candidates").innerHTML = `<span class="cand">${m === "ai" ? "Sign a word, then lower your hands" : "Show your hand to the camera"}</span>`;
    if (running) ensureTracker();
  }
  $("mode-ai").addEventListener("click", () => setMode("ai"));
  $("mode-words").addEventListener("click", () => setMode("words"));
  $("mode-letters").addEventListener("click", () => setMode("letters"));

  // ---------------- message tray ----------------
  function addToken(token, alts = []) {
    tray.push(token);
    trayAlts.push(alts.filter(a => a !== token).slice(0, 2));
    lastTokenAt = performance.now();
    flashChip(token);
    renderTray();
  }
  function renderTray() {
    const el = $("tray-tokens");
    el.innerHTML = "";
    if (!tray.length) {
      el.innerHTML = '<span class="tray-placeholder">Signs you make appear here…</span>';
      return;
    }
    tray.forEach((t, i) => {
      const s = document.createElement("span");
      const alts = trayAlts[i] || [];
      s.className = "tok" + (vocab.isLetterToken(t) ? " letter" : "") + (alts.length ? " unsure" : "");
      if (alts.length) s.title = "Could also be: " + alts.map(labelOf).join(", ");
      s.textContent = vocab.isLetterToken(t) ? vocab.letterOf(t).toUpperCase() : (vocab.byId[t] ? vocab.byId[t].text.toLowerCase() : prettyOf(t));
      el.appendChild(s);
    });
  }
  $("tray-undo").addEventListener("click", () => { tray.pop(); trayAlts.pop(); lastAiIndex = -1; renderTray(); });
  $("tray-clear").addEventListener("click", () => { tray = []; trayAlts = []; renderTray(); });
  $("tray-send").addEventListener("click", sendTray);

  function sendTray() {
    if (!tray.length) return;
    const tokens = tray.slice(), alts = trayAlts.slice();
    tray = []; trayAlts = []; renderTray();
    const text = vocab.tokensToText(tokens);
    appendMessage("user", text, vocab.tokensToGloss(tokens), "You (signed)");
    respond({ tokens, alts, text: null, display: text });
  }

  // auto-send: after a pause with hands lowered (or a long pause)
  const AUTO_MS = 2200, AUTO_MAX_MS = 6000;
  function autoSendTick() {
    const fill = $("auto-fill");
    if ($("auto-send").checked && tray.length) {
      const idle = performance.now() - lastTokenAt;
      const target = handsVisible ? AUTO_MAX_MS : AUTO_MS;
      fill.style.width = Math.min(100, (idle / target) * 100) + "%";
      if (idle > target) { fill.style.width = "0"; sendTray(); }
    } else {
      fill.style.width = "0";
    }
    requestAnimationFrame(autoSendTick);
  }
  requestAnimationFrame(autoSendTick);

  // ---------------- camera + MediaPipe ----------------
  const videoEl = $("video"), canvasEl = $("canvas"), ctx = canvasEl.getContext("2d");
  const statusPill = $("status-pill");
  let hands = null, lastFrame = performance.now(), fps = 0, running = false;
  let firedUntil = 0;

  function setStatus(text, cls) {
    statusPill.textContent = text;
    statusPill.className = "pill " + (cls || "");
  }
  function camMessage(text, retry) {
    $("cam-empty").hidden = !text;
    $("cam-empty-text").textContent = text || "";
    $("cam-retry").hidden = !retry;
  }

  const HANDS_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/";
  const HOLISTIC_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1675471629/";
  let holistic = null;
  function initHands() {
    if (hands) return true;
    if (typeof window.Hands !== "function") return false;
    hands = new window.Hands({ locateFile: f => HANDS_CDN + f });
    hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.55 });
    hands.onResults(onResults);
    return true;
  }
  // the trained model needs hands + body + lips, exactly like its training data (MediaPipe Holistic)
  function initHolistic() {
    if (holistic) return true;
    if (typeof window.Holistic !== "function") return false;
    holistic = new window.Holistic({ locateFile: f => HOLISTIC_CDN + f });
    holistic.setOptions({ modelComplexity: 1, smoothLandmarks: true, refineFaceLandmarks: false,
                          minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    holistic.onResults(onHolisticResults);
    return true;
  }
  function ensureTracker() {
    const ok = mode === "ai" ? initHolistic() : initHands();
    if (!ok) {
      camMessage("Body/hand tracking (MediaPipe) could not load — check your connection. You can still click signs below.", true);
      setStatus("Tracker unavailable", "danger");
    } else if (!statusPill.classList.contains("live")) {
      setStatus(mode === "ai" ? "Loading body tracker…" : "Loading hand model…", "warn");
    }
    return ok;
  }
  const activeTracker = () => (mode === "ai" ? holistic : hands);

  async function startCamera() {
    camMessage("Starting camera…");
    setStatus("Starting camera…", "warn");
    if (!ensureTracker()) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
      videoEl.srcObject = stream;
      await new Promise(res => (videoEl.onloadedmetadata = res));
      await videoEl.play();
      camMessage(null);
      running = true;
      ensureTracker();
      pump();
    } catch (err) {
      console.error(err);
      camMessage("Camera blocked or not found. Allow camera access and try again — or click signs below to try it without one.", true);
      setStatus("No camera", "danger");
    }
  }
  $("cam-retry").addEventListener("click", startCamera);

  let busy = false;
  async function pump() {
    if (!running) return;
    const tracker = activeTracker();
    if (!busy && tracker && videoEl.readyState >= 2) {
      busy = true;
      try { await tracker.send({ image: videoEl }); }
      catch (e) { console.error(e); }
      busy = false;
    }
    requestAnimationFrame(pump);
  }

  function prepCanvas() {
    if (!statusPill.classList.contains("live")) setStatus("Camera live", "live");
    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    if (w && (canvasEl.width !== w || canvasEl.height !== h)) { canvasEl.width = w; canvasEl.height = h; }
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  }
  function drawHand(lm) {
    if (!lm || !window.drawConnectors) return;
    window.drawConnectors(ctx, lm, window.HAND_CONNECTIONS, { color: "rgba(124,92,255,0.85)", lineWidth: 3 });
    window.drawLandmarks(ctx, lm, { color: "#06B6D4", lineWidth: 1, radius: 3 });
  }
  function tickFps(now) {
    const dt = now - lastFrame; lastFrame = now;
    fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;
    $("fps").textContent = `${fps.toFixed(0)} fps`;
  }

  function onResults(results) {
    if (mode === "ai") return;
    prepCanvas();
    (results.multiHandLandmarks || []).forEach(drawHand);
    const now = performance.now();
    const report = rec.process(results, now);
    handsVisible = report.hands;
    $("hands-pill").textContent = `Hands: ${report.hands}`;
    updateBadge(report, now);
    updateCandidates(report);
    if (report.emitted) {
      // keep close runner-ups so the AI can repair a misread sign
      const alts = (report.top || []).filter(t => t.score > 0.35 && t.label !== report.emitted).map(t => t.label);
      addToken(report.emitted, alts);
      firedUntil = now + 450;
    }
    tickFps(now);
  }

  // ---- trained model path ----
  let classifying = false;
  function onHolisticResults(res) {
    if (mode !== "ai") return;
    prepCanvas();
    drawHand(res.leftHandLandmarks); drawHand(res.rightHandLandmarks);
    const now = performance.now();
    const frame = SM.frameFromHolistic(res);
    handsVisible = (res.leftHandLandmarks ? 1 : 0) + (res.rightHandLandmarks ? 1 : 0);
    $("hands-pill").textContent = `Hands: ${handsVisible}${res.poseLandmarks ? "" : " · step back so your shoulders show"}`;
    const clip = segmenter.push(frame, now);
    const badge = $("detect-badge");
    if (segmenter.recording) {
      badge.classList.add("show"); badge.classList.remove("fired");
      $("detect-label").textContent = "● Reading sign…";
      $("hold-fill").style.width = (segmenter.progress(now) * 100) + "%";
      lastTokenAt = now;                       // don't auto-send mid-sign
    } else if (now > firedUntil) {
      badge.classList.remove("show", "fired");
    }
    if (clip && !classifying) classifyClip(clip, now);
    tickFps(now);
  }

  async function classifyClip(clip) {
    classifying = true;
    try {
      const cands = await model.classify(clip.frames, 4);
      renderAiCandidates(cands);
      const best = cands[0];
      const badge = $("detect-badge");
      badge.classList.add("show");
      if (best.prob >= 0.15) {
        addToken(best.token, cands.slice(1, 3).filter(c => c.prob >= 0.05).map(c => c.token));
        lastAiIndex = tray.length - 1;
        badge.classList.add("fired");
        $("detect-label").textContent = `${best.text.toUpperCase()}  ${Math.round(best.prob * 100)}%`;
      } else {
        lastAiIndex = -1;
        badge.classList.remove("fired");
        $("detect-label").textContent = "Not sure — tap the right word below";
      }
      $("hold-fill").style.width = "100%";
      firedUntil = performance.now() + 1400;
    } catch (e) {
      console.error(e);
    }
    classifying = false;
  }

  function renderAiCandidates(cands) {
    const el = $("candidates");
    el.innerHTML = "";
    cands.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "cand pick";
      b.title = i === 0 ? "The model's best guess" : "Tap to use this word instead";
      b.innerHTML = `<div class="nm"><span>${escapeHtml(c.text.toUpperCase())}</span><span>${Math.round(c.prob * 100)}%</span></div>
        <div class="bar"><i style="width:${Math.round(c.prob * 100)}%"></i></div>`;
      b.addEventListener("click", () => {
        if (lastAiIndex >= 0 && lastAiIndex === tray.length - 1) {
          tray[lastAiIndex] = c.token;
          trayAlts[lastAiIndex] = [];
          renderTray();
          lastTokenAt = performance.now();
        } else {
          addToken(c.token);
          lastAiIndex = tray.length - 1;
        }
      });
      el.appendChild(b);
    });
  }

  function updateBadge(report, now) {
    const badge = $("detect-badge");
    const s = report.stable;
    if (s) {
      badge.classList.add("show");
      $("detect-label").textContent = `${labelOf(s.label)}  ${Math.round(s.conf * 100)}%`;
      $("hold-fill").style.width = (s.progress * 100) + "%";
      badge.classList.toggle("fired", now < firedUntil || s.locked);
    } else if (report.frame) {
      badge.classList.add("show");
      badge.classList.remove("fired");
      $("detect-label").textContent = `${labelOf(report.frame.label)}?`;
      $("hold-fill").style.width = "0";
    } else {
      badge.classList.remove("show", "fired");
    }
  }

  let lastCandKey = null;
  function updateCandidates(report) {
    const top = (report.top || []).filter(t => t.score > 0.05);
    const key = top.map(t => t.label + Math.round(t.score * 20)).join("|");
    if (key === lastCandKey) return;
    lastCandKey = key;
    const el = $("candidates");
    if (!top.length) {
      el.innerHTML = `<span class="cand">${report.hands ? "Hand found — try a sign from the list below" : "Show your hand to the camera"}</span>`;
      return;
    }
    el.innerHTML = top.map(t => `<div class="cand"><div class="nm"><span>${escapeHtml(labelOf(t.label))}</span><span>${Math.round(t.score * 100)}%</span></div>
      <div class="bar"><i style="width:${Math.round(t.score * 100)}%"></i></div></div>`).join("");
  }

  // ---------------- chat ----------------
  const chatEl = $("chat");
  function appendMessage(role, text, gloss, label) {
    const div = document.createElement("div");
    div.className = "msg " + role;
    if (role !== "note") {
      const l = document.createElement("div");
      l.className = "label"; l.textContent = label || (role === "user" ? "You" : "SignAI");
      div.appendChild(l);
    }
    const body = document.createElement("div");
    body.textContent = text;
    div.appendChild(body);
    if (gloss) {
      const g = document.createElement("div");
      g.className = "gloss"; g.textContent = "GLOSS: " + gloss;
      div.appendChild(g);
    }
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  $("send-btn").addEventListener("click", sendTyped);
  $("text-input").addEventListener("keydown", e => { if (e.key === "Enter") sendTyped(); });
  function sendTyped() {
    const v = $("text-input").value.trim();
    if (!v) return;
    $("text-input").value = "";
    appendMessage("user", v);
    respond({ text: v, tokens: null, display: v });
  }

  const SUGGESTIONS = ["hi, my name is Sam", "how do I sign thank you?", "I'm hungry", "what time is it?", "tell me a joke", "what is 7 times 6"];
  SUGGESTIONS.forEach(s => {
    const b = document.createElement("button");
    b.textContent = s;
    b.addEventListener("click", () => { appendMessage("user", s); respond({ text: s, tokens: null, display: s }); });
    $("suggestions").appendChild(b);
  });

  $("reset-btn").addEventListener("click", () => {
    chatEl.innerHTML = "";
    history.length = 0;
    mock.reset();
    tray = []; trayAlts = []; renderTray();
    if (avatar) avatar.stop();
    appendMessage("bot", "Conversation cleared. Sign or type to start again.");
  });

  // ---------------- AI backends ----------------
  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
  const AI = { mode: "mock", base: "https://api.openai.com/v1", model: "gpt-4o-mini", key: "",
               geminiModel: "gemini-2.5-flash", geminiKey: "" };
  try {
    const saved = JSON.parse(localStorage.getItem("signai_api") || "null");
    if (saved) Object.assign(AI, saved);
  } catch (_) { /* storage unavailable */ }
  $("api-base").value = AI.base; $("api-model").value = AI.model; $("api-key").value = AI.key || "";
  $("remember-key").checked = !!AI.key;
  let userPickedModel = !!AI.geminiPicked;
  $("gemini-model").addEventListener("change", () => { userPickedModel = true; });
  $("gemini-key").value = AI.geminiKey || ""; $("gemini-remember").checked = !!AI.geminiKey;
  setGeminiModels([AI.geminiModel]);
  updateAIModeUI();

  // the provider the chat actually calls
  function provider() {
    if (AI.mode === "gemini") return { base: GEMINI_BASE, model: AI.geminiModel, key: AI.geminiKey, name: "Gemini" };
    return { base: AI.base, model: AI.model, key: AI.key, name: AI.model };
  }

  $("ai-toggle").addEventListener("click", () => { $("ai-settings").hidden = !$("ai-settings").hidden; });
  $("mode-mock").addEventListener("click", () => { AI.mode = "mock"; saveAI(); updateAIModeUI(); showFields(null); });
  $("mode-gemini").addEventListener("click", () => { showFields("gemini"); $("gemini-key").focus(); });
  $("mode-api").addEventListener("click", () => { showFields("api"); $("api-base").focus(); });
  function showFields(which) {
    $("gemini-fields").hidden = which !== "gemini";
    $("api-fields").hidden = which !== "api";
  }

  // list the Gemini models this key can use, newest "flash" first (free tier friendly)
  let modelsLoadedFor = "";
  $("gemini-key").addEventListener("change", loadGeminiModels);
  async function loadGeminiModels() {
    const key = $("gemini-key").value.trim();
    if (!key || key === modelsLoadedFor) return;
    try {
      let res = await fetch(GEMINI_BASE + "/models", { headers: { Authorization: "Bearer " + key } });
      if (res.status === 401 || res.status === 403) res = await fetch(GEMINI_BASE + "/models", { headers: { "x-goog-api-key": key } });
      if (!res.ok) throw new Error(res.status);
      const ids = ((await res.json()).data || []).map(m => String(m.id).replace(/^models\//, ""))
        .filter(id => /^gemini-/.test(id) && !/(embedding|image|tts|audio|live|vision|exp|preview)/.test(id));
      if (!ids.length) return;
      const rank = id => (/flash/.test(id) ? 0 : 1) * 1000 - parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]) * 10 + (/lite/.test(id) ? 1 : 0);
      ids.sort((a, b) => rank(a) - rank(b));
      setGeminiModels(ids);
      modelsLoadedFor = key;
    } catch (e) {
      console.warn("Could not list Gemini models", e);
    }
  }
  function setGeminiModels(ids) {
    const sel = $("gemini-model");
    const current = userPickedModel ? AI.geminiModel : ids[0];
    sel.innerHTML = "";
    [...new Set(ids)].forEach(id => { const o = document.createElement("option"); o.value = o.textContent = id; sel.appendChild(o); });
    sel.value = ids.includes(current) ? current : ids[0];
  }

  $("gemini-save").addEventListener("click", async () => {
    const key = $("gemini-key").value.trim();
    if (!key) { $("gemini-key").focus(); return; }
    await loadGeminiModels();
    AI.geminiKey = key;
    AI.geminiModel = $("gemini-model").value || "gemini-2.5-flash";
    AI.geminiPicked = userPickedModel;
    AI.mode = "gemini";
    saveAI(); updateAIModeUI();
    $("ai-settings").hidden = true;
    appendMessage("note", `Using Google Gemini (${AI.geminiModel})`);
  });
  $("api-save").addEventListener("click", () => {
    AI.base = ($("api-base").value.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
    AI.model = $("api-model").value.trim() || "gpt-4o-mini";
    AI.key = $("api-key").value.trim();
    AI.mode = "api";
    saveAI();
    updateAIModeUI();
    $("ai-settings").hidden = true;
    appendMessage("note", `Using ${AI.model} at ${AI.base}`);
  });
  function saveAI() {
    try {
      const keep = { mode: AI.mode, base: AI.base, model: AI.model, geminiModel: AI.geminiModel, geminiPicked: !!AI.geminiPicked,
                     key: $("remember-key").checked ? AI.key : "",
                     geminiKey: $("gemini-remember").checked ? AI.geminiKey : "" };
      localStorage.setItem("signai_api", JSON.stringify(keep));
    } catch (_) { /* ignore */ }
  }
  function updateAIModeUI() {
    $("ai-mode-label").textContent = AI.mode === "gemini" ? "Gemini" : AI.mode === "api" ? AI.model : "Mock LLM";
    ["mock", "gemini", "api"].forEach(m => $("mode-" + m).classList.toggle("active", AI.mode === m));
  }

  const SYSTEM_PROMPT = () => `You are SignAI, a warm, patient assistant for Deaf and hard-of-hearing people who use American Sign Language.
Many users find written English hard, so:
- Answer in very simple, short sentences (1–3), plain words, no jargon, no lists, no markdown.
- You know a lot: answer real questions (health, directions, how-to, facts, news you know of) helpfully. Say so honestly when unsure.

The user's message is either typed, or recognised from signing by a webcam. Signed input arrives as ASL gloss, e.g. "ME NAME S-A-M" or "WATER WHERE".
- ASL word order differs from English and recognition can be wrong: some signs come with alternatives the camera also considered, like "THINK[or: ONE]". Work out the most likely meaning from context.
- If the meaning is really unclear, ask one short yes/no question to check.

Your reply is also signed by a 3D avatar. Respond with strict JSON only, no code fences:
{"understood": "<the user's message in plain English>", "text": "<your reply>", "gloss": ["token", ...]}

"gloss" summarises your reply for the avatar, 1–8 tokens in ASL order (topic first, question words last), chosen ONLY from:
${vocab.WORDS.map(w => w.id).join(", ")}
To fingerspell a name or key word with no sign, use one token per letter: "letter:s", "letter:a", "letter:m". If nothing fits, use ["ok"].`;

  // gloss with recognizer alternatives, e.g. "ME THINK[or: ONE] S-A-M"
  function glossWithAlts(tokens, alts) {
    const out = []; let spelled = [];
    const flush = () => { if (spelled.length) { out.push(spelled.join("-").toUpperCase()); spelled = []; } };
    tokens.forEach((t, i) => {
      if (vocab.isLetterToken(t)) { spelled.push(vocab.letterOf(t)); return; }
      flush();
      const a = (alts && alts[i]) || [];
      out.push(t.toUpperCase() + (a.length ? `[or: ${a.map(x => x.toUpperCase()).join(" / ")}]` : ""));
    });
    flush();
    return out.join(" ");
  }

  async function callAPI(userContent) {
    const p = provider();
    const messages = [{ role: "system", content: SYSTEM_PROMPT() }, ...history.slice(-12), { role: "user", content: userContent }];
    const body = { model: p.model, messages, temperature: 0.5, max_tokens: 400, response_format: { type: "json_object" } };
    const headers = { "Content-Type": "application/json" };
    if (p.key) headers.Authorization = "Bearer " + p.key;
    let res = await fetch(p.base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
    if ((res.status === 401 || res.status === 403) && AI.mode === "gemini" && p.key) {
      // some Google key types are only accepted in Google's own header
      delete headers.Authorization; headers["x-goog-api-key"] = p.key;
      res = await fetch(p.base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
    }
    if (res.status === 400) {   // some servers do not support response_format
      delete body.response_format;
      res = await fetch(p.base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
    }
    if (res.status === 429) throw new Error("rate limit reached (free tier) — wait a minute and try again");
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    let parsed;
    try { parsed = JSON.parse((content.match(/\{[\s\S]*\}/) || [content])[0]); }
    catch { parsed = { text: content.trim(), gloss: mockLLM.autoGloss(content) }; }
    const gloss = (Array.isArray(parsed.gloss) ? parsed.gloss : [])
      .map(g => String(g).toLowerCase().trim().replace(/\s+/g, "-"))
      .flatMap(g => (vocab.byId[g] ? [g] : /^letter:[a-z]$/.test(g) ? [g] : []))
      .slice(0, 16);
    return { text: String(parsed.text || "OK."), gloss: gloss.length ? gloss : mockLLM.autoGloss(parsed.text || "ok"),
             understood: parsed.understood ? String(parsed.understood) : null };
  }

  let pendingReply = 0;
  async function respond({ text, tokens, alts, display }) {
    const id = ++pendingReply;
    $("typing").classList.add("show");
    let resp, note = null;
    try {
      if (AI.mode === "api" || AI.mode === "gemini") {
        resp = await callAPI(tokens ? `Signed: ${glossWithAlts(tokens, alts)}` : text);
      } else {
        resp = mock.respond(tokens ? { tokens, source: "sign" } : { text, source: "text" });
        // feel like a model "thinking": a short delay that grows with reply length
        await new Promise(r => setTimeout(r, 350 + Math.min(900, resp.text.length * 8)));
      }
    } catch (err) {
      console.error(err);
      note = "API error — answered with the offline mock instead. " + (err.message || "");
      resp = mock.respond(tokens ? { tokens } : { text });
    }
    if (id !== pendingReply) return;   // a newer message superseded this one
    $("typing").classList.remove("show");
    history.push({ role: "user", content: display }, { role: "assistant", content: resp.text });
    if (note) appendMessage("note", note);
    if (tokens && resp.understood) appendMessage("note", `Understood as: “${resp.understood}”`);
    appendMessage("bot", resp.text, vocab.tokensToGloss(resp.gloss));
    signReply(resp.gloss);
  }

  // ---------------- avatar ----------------
  let avatar = null;
  let glossEls = [];
  function signReply(gloss) {
    renderGlossStrip(gloss);
    if (avatar) avatar.play(gloss);
  }
  function renderGlossStrip(gloss) {
    const strip = $("gloss-strip");
    strip.innerHTML = "";
    glossEls = gloss.map(g => {
      const s = document.createElement("span");
      s.className = "g";
      s.textContent = vocab.isLetterToken(g) ? vocab.letterOf(g).toUpperCase() : g.toUpperCase();
      strip.appendChild(s);
      return s;
    });
  }
  let glossIdx = -1;
  try {
    if (!window.THREE) throw new Error("Three.js not loaded");
    avatar = new window.SignAI.Avatar($("avatar-canvas"), {
      onSign: (label) => {
        $("now-signing").textContent = label;
        glossIdx++;
        glossEls.forEach((el, i) => { el.classList.toggle("on", i === glossIdx); el.classList.toggle("done", i < glossIdx); });
      },
      onIdle: () => {
        $("now-signing").textContent = "idle";
        glossEls.forEach(el => { el.classList.remove("on"); el.classList.add("done"); });
        glossIdx = -1;
      },
    });
    const origPlay = avatar.play.bind(avatar);
    avatar.play = tokens => { glossIdx = -1; origPlay(tokens); };
  } catch (e) {
    console.error(e);
    $("avatar-error").hidden = false;
  }
  $("replay-btn").addEventListener("click", () => {
    if (!avatar || !avatar.last.length) return;
    renderGlossStrip(avatar.last);
    avatar.replay();
  });
  document.querySelectorAll(".speed").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".speed").forEach(x => x.classList.toggle("active", x === b));
    if (avatar) avatar.speed = parseFloat(b.dataset.speed);
  }));

  // ---------------- utils + boot ----------------
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // test hooks (used by the automated browser checks; harmless in normal use)
  window.SignAI.app = { addToken, sendTray, respond, setMode, classifyClip, get mode() { return mode; }, get model() { return model; },
                        get tray() { return tray.slice(); }, get avatar() { return avatar; } };

  renderLibrary();
  renderTray();
  updateCandidates({ hands: 0, top: [] });
  // the trained model ships next to the page; the single-file build fetches it from GitHub Pages
  if (model && window.ort) {
    $("mode-ai").title = "Loading the AI sign model…";
    model.load(["models/", "https://samadbekyunusalievv.github.io/signai/models/"]).then(() => {
      $("mode-ai").disabled = false;
      $("mode-ai").title = `Trained on Google's ASL dataset: ${model.labels.length} signs`;
      if (mode === "words" && !tray.length) setMode("ai");
    }).catch(err => {
      console.warn("AI sign model unavailable:", err);
      $("mode-ai").title = "AI sign model could not be loaded";
    });
  } else {
    $("mode-ai").title = "AI sign model unavailable (onnxruntime-web did not load)";
  }
  startCamera();
})();
