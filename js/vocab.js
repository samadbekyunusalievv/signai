/* ===========================================================
   SignAI — shared vocabulary
   Every sign the camera can read and the avatar can perform.
   Works in the browser (window.SignAI.vocab) and in Node (require).
   =========================================================== */
(function (root) {
  "use strict";

  // id: internal token used everywhere (gloss tokens, avatar clips, recognizer labels)
  // text: what the sign means in English
  // hint: how to sign it for the camera (shown in the UI)
  // cat: grouping in the UI
  const WORDS = [
    // --- Social ---
    { id: "hello",      text: "Hello",        cat: "social",  hint: "Open hand (fingers spread) raised near your forehead, or wave it side to side." },
    { id: "bye",        text: "Goodbye",      cat: "social",  hint: "Open hand, then fold the fingers down and up a few times (flapping wave)." },
    { id: "thank-you",  text: "Thank you",    cat: "social",  hint: "Flat hand (fingers together) starting high near the chin, moving down / forward." },
    { id: "please",     text: "Please",       cat: "social",  hint: "Flat hand rubbing a circle on your chest." },
    { id: "sorry",      text: "Sorry",        cat: "social",  hint: "Closed fist rubbing a circle on your chest." },
    { id: "i-love-you", text: "I love you",   cat: "social",  hint: "Thumb, index and pinky up; middle and ring folded." },
    { id: "nice",       text: "Nice to meet you", cat: "social", hint: "Two flat hands, one sliding across the other (both hands flat and close)." },

    // --- Answers ---
    { id: "yes",        text: "Yes",          cat: "answer",  hint: "Closed fist nodding up and down." },
    { id: "no",         text: "No",           cat: "answer",  hint: "Index + middle fingers pinch down onto the thumb." },
    { id: "ok",         text: "OK",           cat: "answer",  hint: "Thumb and index touch in a circle; other three fingers up." },
    { id: "good",       text: "Good",         cat: "answer",  hint: "Thumbs up." },
    { id: "bad",        text: "Bad",          cat: "answer",  hint: "Thumbs down." },

    // --- People ---
    { id: "you",        text: "You",          cat: "people",  hint: "Point your index finger straight at the camera." },
    { id: "me",         text: "Me / I",       cat: "people",  hint: "Point your index finger sideways / at your chest." },

    // --- Questions ---
    { id: "what",       text: "What",         cat: "question", hint: "Both open hands, palms up, held apart." },
    { id: "where",      text: "Where",        cat: "question", hint: "Index finger up, wagging side to side." },
    { id: "name",       text: "Name",         cat: "question", hint: "Both hands with index + middle together (H hands), close to each other." },
    { id: "think",      text: "Think",        cat: "question", hint: "Index finger up, held high by your forehead." },

    // --- Needs ---
    { id: "help",       text: "Help",         cat: "need",    hint: "One fist resting on the other open, flat hand (two hands)." },
    { id: "water",      text: "Water",        cat: "need",    hint: "W hand: index, middle and ring up; thumb holds the pinky." },
    { id: "eat",        text: "Eat / Food",   cat: "need",    hint: "All fingertips touching the thumb (flat O), as if bringing food to the mouth." },
    { id: "drink",      text: "Drink",        cat: "need",    hint: "C hand, as if holding a cup — keep it still." },
    { id: "hungry",     text: "Hungry",       cat: "need",    hint: "C hand moving down your chest." },
    { id: "more",       text: "More",         cat: "need",    hint: "Both hands in flat O shape, fingertips tapping together." },
    { id: "stop",       text: "Stop / Wait",  cat: "need",    hint: "Open hand held still at chest height, palm to the camera." },
    { id: "call",       text: "Call / Phone", cat: "need",    hint: "Y hand: thumb and pinky out, like a phone." },

    // --- Numbers & fun ---
    { id: "one",        text: "One",          cat: "number",  hint: "Index finger up, at chest height." },
    { id: "two",        text: "Two",          cat: "number",  hint: "Index + middle up and spread (V)." },
    { id: "three",      text: "Three",        cat: "number",  hint: "Thumb, index and middle up." },
    { id: "four",       text: "Four",         cat: "number",  hint: "Four fingers up, thumb folded in." },
    { id: "rock",       text: "Rock on",      cat: "number",  hint: "Index + pinky up, thumb tucked." },
  ];

  // Fingerspelling letters the camera can read (static handshapes only).
  const LETTERS = [
    { id: "a", hint: "Fist, thumb resting straight along the side." },
    { id: "b", hint: "Four fingers up together, thumb folded across the palm." },
    { id: "c", hint: "Curve the hand into a C." },
    { id: "d", hint: "Index up, other fingertips touching the thumb." },
    { id: "e", hint: "All fingers bent down over the thumb, tips touching." },
    { id: "f", hint: "Thumb + index circle, other three fingers up." },
    { id: "h", hint: "Index + middle together, pointing sideways." },
    { id: "i", hint: "Pinky up only." },
    { id: "l", hint: "Thumb + index make an L." },
    { id: "o", hint: "All fingertips touch the thumb in a round O." },
    { id: "s", hint: "Fist, thumb wrapped across the front of the fingers." },
    { id: "u", hint: "Index + middle up, together." },
    { id: "v", hint: "Index + middle up, spread." },
    { id: "w", hint: "Index, middle and ring up, spread." },
    { id: "y", hint: "Thumb + pinky out." },
  ];

  const byId = {};
  WORDS.forEach(w => { byId[w.id] = w; });

  function isLetterToken(tok) { return typeof tok === "string" && tok.startsWith("letter:"); }
  function letterOf(tok) { return tok.slice(7); }

  // Plain English word for each sign when it stands alone in a sentence.
  const PLAIN = { "me": "I", "i-love-you": "I love you", "thank-you": "thank you", "call": "call", "eat": "eat",
                  "stop": "wait", "rock": "rock on", "nice": "nice to meet you", "bye": "goodbye", "ok": "OK" };

  // Light ASL-gloss → English rewrites, applied on the gloss string ("ME NAME SAM").
  const REWRITES = [
    [/\bME NAME (\w+)/g, "my name is $1"],
    [/\b(?:YOU NAME WHAT|WHAT YOU NAME|NAME YOU WHAT|WHAT NAME YOU)\b/g, "what is your name?"],
    [/\bME (HUNGRY|GOOD|BAD|OK|THINK)\b/g, (m, w) => ({ HUNGRY: "I'm hungry", GOOD: "I'm good", BAD: "I feel bad", OK: "I'm OK", THINK: "I think" })[w]],
    [/\bME (WATER|EAT|DRINK|MORE|HELP)\b/g, (m, w) => "I want " + ({ WATER: "water", EAT: "to eat", DRINK: "a drink", MORE: "more", HELP: "help" })[w]],
    [/\b(?:HELP ME|ME HELP)\b/g, "help me"],
    [/\bTHANK-YOU YOU\b/g, "thank you"],
    [/\b(\w+) WHERE\b/g, "where is $1?"],
    [/\bYOU GOOD\b/g, "are you good?"],
    [/\bWHAT YOU WANT\b/g, "what do you want?"],
  ];

  // Turn a list of tokens (words + letters) into readable English.
  // Consecutive letters are merged into one fingerspelled word.
  function tokensToText(tokens) {
    const parts = [];
    let spelled = "";
    const flush = () => { if (spelled) { parts.push({ name: spelled }); spelled = ""; } };
    tokens.forEach(t => {
      if (isLetterToken(t)) { spelled += letterOf(t); return; }
      flush();
      parts.push({ id: t });
    });
    flush();
    if (!parts.length) return "";
    // gloss string with names as single words, then rewrite known patterns
    let g = parts.map(p => (p.name ? "_" + p.name.toUpperCase() : p.id.toUpperCase())).join(" ");
    REWRITES.forEach(([re, rep]) => { g = g.replace(re, rep); });
    const words = g.split(" ").map(raw => {
      const [, w, punct] = raw.match(/^(.*?)([?]?)$/);
      if (w.startsWith("_")) { const n = w.slice(1).toLowerCase(); return n.charAt(0).toUpperCase() + n.slice(1) + punct; }
      if (/^[A-Z][A-Z-]*$/.test(w)) {
        const id = w.toLowerCase();
        if (PLAIN[id]) return PLAIN[id] + punct;
        return (byId[id] ? byId[id].text.split(" / ")[0].toLowerCase() : id) + punct;
      }
      return raw;
    });
    let s = words.join(" ").replace(/\s+\?/g, "?").replace(/\bi\b/g, "I");
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return s;
  }

  // ASL-style gloss for display: HELLO ME NAME S-A-M
  function tokensToGloss(tokens) {
    const out = [];
    let spelled = [];
    const flush = () => { if (spelled.length) { out.push(spelled.join("-").toUpperCase()); spelled = []; } };
    tokens.forEach(t => {
      if (isLetterToken(t)) { spelled.push(letterOf(t)); return; }
      flush();
      out.push(t.toUpperCase());
    });
    flush();
    return out.join(" ");
  }

  const api = { WORDS, LETTERS, byId, isLetterToken, letterOf, tokensToText, tokensToGloss };
  root.SignAI = root.SignAI || {};
  root.SignAI.vocab = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
