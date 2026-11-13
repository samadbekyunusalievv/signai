/* ===========================================================
   SignAI — app wiring
   camera → recognizer → message tray → LLM (mock or API) → chat + avatar
   =========================================================== */
(function () {
  "use strict";
  const { vocab, recognizer: R, mockLLM } = window.SignAI;
  const $ = id => document.getElementById(id);

  // ---------------- state ----------------
  const rec = new R.Recognizer({ mode: "words" });
  const mock = new mockLLM.MockLLM();
  let tray = [];               // tokens waiting to be sent
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
    const name = vocab.isLetterToken(token) ? "Letter " + vocab.letterOf(token).toUpperCase() : (vocab.byId[token] || {}).text;
    $("hint").innerHTML = `<b>${escapeHtml(name || token)}</b> — ${escapeHtml(hint)}`;
  }
  function flashChip(token) {
    const el = chipEls[token];
    if (!el) return;
    el.classList.add("active");
    setTimeout(() => el.classList.remove("active"), 1200);
  }
  function labelOf(token) {
    if (!token) return "";
    if (vocab.isLetterToken(token)) return vocab.letterOf(token).toUpperCase();
    return (vocab.byId[token] ? vocab.byId[token].text : token).toUpperCase();
  }

  // ---------------- mode switch ----------------
  function setMode(mode) {
    rec.setMode(mode);
    $("mode-words").classList.toggle("active", mode === "words");
    $("mode-letters").classList.toggle("active", mode === "letters");
    $("mode-words").setAttribute("aria-selected", mode === "words");
    $("mode-letters").setAttribute("aria-selected", mode === "letters");
    renderLibrary();
    $("hint").textContent = mode === "letters"
      ? "Fingerspelling: hold each letter still for half a second. Lower your hand between words. Repeat a letter by moving off it briefly."
      : "Tip: hold a sign steady for about half a second. Moving signs (hello wave, yes nod, please circle) are read from the motion.";
  }
  $("mode-words").addEventListener("click", () => setMode("words"));
  $("mode-letters").addEventListener("click", () => setMode("letters"));

  // ---------------- message tray ----------------
  function addToken(token) {
    tray.push(token);
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
    tray.forEach(t => {
      const s = document.createElement("span");
      s.className = "tok" + (vocab.isLetterToken(t) ? " letter" : "");
      s.textContent = vocab.isLetterToken(t) ? vocab.letterOf(t).toUpperCase() : (vocab.byId[t] ? vocab.byId[t].text.toLowerCase() : t);
      el.appendChild(s);
    });
  }
  $("tray-undo").addEventListener("click", () => { tray.pop(); renderTray(); });
  $("tray-clear").addEventListener("click", () => { tray = []; renderTray(); });
  $("tray-send").addEventListener("click", sendTray);

  function sendTray() {
    if (!tray.length) return;
    const tokens = tray.slice();
    tray = []; renderTray();
    const text = vocab.tokensToText(tokens);
    appendMessage("user", text, vocab.tokensToGloss(tokens), "You (signed)");
    respond({ tokens, text: null, display: text });
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

  function initHands() {
    if (typeof window.Hands !== "function") return false;
    hands = new window.Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}` });
    hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.55 });
    hands.onResults(onResults);
    return true;
  }

  async function startCamera() {
    camMessage("Starting camera…");
    setStatus("Starting camera…", "warn");
    if (!hands && !initHands()) {
      camMessage("Hand tracking (MediaPipe) could not load — check your connection. You can still click signs below.", true);
      setStatus("Tracker unavailable", "danger");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
      videoEl.srcObject = stream;
      await new Promise(res => (videoEl.onloadedmetadata = res));
      await videoEl.play();
      camMessage(null);
      setStatus("Loading hand model…", "warn");
      running = true;
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
    if (!busy && videoEl.readyState >= 2) {
      busy = true;
      try { await hands.send({ image: videoEl }); }
      catch (e) { console.error(e); }
      busy = false;
    }
    requestAnimationFrame(pump);
  }

  function onResults(results) {
    if (!statusPill.classList.contains("live")) setStatus("Camera live", "live");
    const w = videoEl.videoWidth, h = videoEl.videoHeight;
    if (w && (canvasEl.width !== w || canvasEl.height !== h)) { canvasEl.width = w; canvasEl.height = h; }
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    const list = results.multiHandLandmarks || [];
    list.forEach(lm => {
      if (window.drawConnectors) {
        window.drawConnectors(ctx, lm, window.HAND_CONNECTIONS, { color: "rgba(124,92,255,0.85)", lineWidth: 3 });
        window.drawLandmarks(ctx, lm, { color: "#06B6D4", lineWidth: 1, radius: 3 });
      }
    });

    const now = performance.now();
    const report = rec.process(results, now);
    handsVisible = report.hands;
    $("hands-pill").textContent = `Hands: ${report.hands}`;
    updateBadge(report, now);
    updateCandidates(report);
    if (report.emitted) {
      addToken(report.emitted);
      firedUntil = now + 450;
    }

    const dt = now - lastFrame; lastFrame = now;
    fps = fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;
    $("fps").textContent = `${fps.toFixed(0)} fps`;
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
    tray = []; renderTray();
    if (avatar) avatar.stop();
    appendMessage("bot", "Conversation cleared. Sign or type to start again.");
  });

  // ---------------- AI backends ----------------
  const AI = { mode: "mock", base: "https://api.openai.com/v1", model: "gpt-4o-mini", key: "" };
  try {
    const saved = JSON.parse(localStorage.getItem("signai_api") || "null");
    if (saved) Object.assign(AI, saved);
  } catch (_) { /* storage unavailable */ }
  $("api-base").value = AI.base; $("api-model").value = AI.model; $("api-key").value = AI.key || "";
  $("remember-key").checked = !!AI.key;
  updateAIModeUI();

  $("ai-toggle").addEventListener("click", () => { $("ai-settings").hidden = !$("ai-settings").hidden; });
  $("mode-mock").addEventListener("click", () => { AI.mode = "mock"; saveAI(); updateAIModeUI(); });
  $("mode-api").addEventListener("click", () => { $("api-fields").hidden = false; $("api-base").focus(); });
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
      const keep = { mode: AI.mode, base: AI.base, model: AI.model, key: $("remember-key").checked ? AI.key : "" };
      localStorage.setItem("signai_api", JSON.stringify(keep));
    } catch (_) { /* ignore */ }
  }
  function updateAIModeUI() {
    $("ai-mode-label").textContent = AI.mode === "api" ? AI.model : "Mock LLM";
    $("mode-mock").classList.toggle("active", AI.mode === "mock");
    $("mode-api").classList.toggle("active", AI.mode === "api");
  }

  const SYSTEM_PROMPT = () => `You are SignAI, a warm, concise assistant for Deaf and hard-of-hearing signers.
The user's messages come either typed or recognised from sign language by a webcam (then they look like ASL gloss, e.g. "Me name S-A-M").
Your reply is signed by a 3D avatar, so keep it to 1–2 short sentences.

Respond with strict JSON only:
{"text": "<your English reply>", "gloss": ["token", ...]}

Gloss tokens must be chosen from this list (the avatar can only sign these):
${vocab.WORDS.map(w => w.id).join(", ")}
To fingerspell a word (names, words without a sign) use one token per letter: "letter:s", "letter:a", "letter:m".
Use 1–6 tokens in ASL order (topic first, question words at the end). If nothing fits, use ["ok"].`;

  async function callAPI(userContent) {
    const messages = [{ role: "system", content: SYSTEM_PROMPT() }, ...history.slice(-12), { role: "user", content: userContent }];
    const body = { model: AI.model, messages, temperature: 0.6, max_tokens: 250, response_format: { type: "json_object" } };
    const headers = { "Content-Type": "application/json" };
    if (AI.key) headers.Authorization = "Bearer " + AI.key;
    let res = await fetch(AI.base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 400) {   // some servers do not support response_format
      delete body.response_format;
      res = await fetch(AI.base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
    }
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    let parsed;
    try { parsed = JSON.parse((content.match(/\{[\s\S]*\}/) || [content])[0]); }
    catch { parsed = { text: content.trim(), gloss: mockLLM.autoGloss(content) }; }
    const gloss = (Array.isArray(parsed.gloss) ? parsed.gloss : [])
      .map(g => String(g).toLowerCase().trim().replace(/\s+/g, "-"))
      .flatMap(g => (vocab.byId[g] ? [g] : /^letter:[a-z]$/.test(g) ? [g] : []));
    return { text: String(parsed.text || "OK."), gloss: gloss.length ? gloss : mockLLM.autoGloss(parsed.text || "ok") };
  }

  let pendingReply = 0;
  async function respond({ text, tokens, display }) {
    const id = ++pendingReply;
    $("typing").classList.add("show");
    let resp, note = null;
    try {
      if (AI.mode === "api") {
        resp = await callAPI(tokens ? `${display} (signed, gloss: ${vocab.tokensToGloss(tokens)})` : text);
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
  window.SignAI.app = { addToken, sendTray, respond, setMode, get tray() { return tray.slice(); }, get avatar() { return avatar; } };

  renderLibrary();
  renderTray();
  updateCandidates({ hands: 0, top: [] });
  startCamera();
})();
