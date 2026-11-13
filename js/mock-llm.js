/* ===========================================================
   SignAI — offline mock LLM
   A small rule-based dialogue engine that behaves like a chat model
   without any network or API key:
   - understands both signed gloss (HELLO ME NAME S-A-M) and typed English
   - remembers your name, your mood and what it just asked you
   - handles several intents in one message ("hi, my name is Sam")
   - built-in tools: time, date, arithmetic, counting, jokes, sign lessons
   - answers with English text + a gloss sequence the avatar can sign,
     fingerspelling words it has no sign for (like your name)
   =========================================================== */
(function (root) {
  "use strict";

  const vocab = (root.SignAI && root.SignAI.vocab) || (typeof require !== "undefined" ? require("./vocab.js") : null);
  const SIGN_IDS = new Set(vocab.WORDS.map(w => w.id));
  const SPELLABLE = new Set(vocab.LETTERS.map(l => l.id));

  // ---------- text normalisation ----------
  const CONTRACTIONS = {
    "what's": "what is", "whats": "what is", "where's": "where is", "who's": "who is", "how's": "how is",
    "i'm": "i am", "im": "i am", "you're": "you are", "youre": "you are", "it's": "it is", "that's": "that is",
    "don't": "do not", "dont": "do not", "can't": "can not", "cant": "can not", "won't": "will not",
    "i'd": "i would", "i'll": "i will", "i've": "i have", "isn't": "is not", "didn't": "did not",
    "u": "you", "ur": "your", "r": "are", "pls": "please", "plz": "please", "thx": "thanks", "ty": "thank you",
    "luv": "love", "wanna": "want to", "gonna": "going to", "gotta": "got to",
  };

  function normalize(text) {
    let t = String(text || "").toLowerCase()
      .replace(/[’`]/g, "'")
      .replace(/([+\-*/×÷=?!.,])/g, " $1 ")
      .replace(/\s+/g, " ").trim();
    t = t.split(" ").map(w => CONTRACTIONS[w] || w).join(" ");
    return t;
  }
  const words = t => t.replace(/[^a-z0-9'+\-*/×÷ ]/g, " ").split(/\s+/).filter(Boolean);

  // Concepts: any of these words/phrases → the concept is present.
  const CONCEPTS = {
    greet: ["hello", "hi", "hey", "hiya", "yo", "howdy", "good morning", "good afternoon", "good evening", "greetings", "sup"],
    bye: ["bye", "goodbye", "good bye", "see you", "see ya", "later", "good night", "goodnight", "farewell", "cya"],
    thanks: ["thank you", "thanks", "thank", "appreciate", "cheers"],
    sorry: ["sorry", "apologize", "apologies", "my bad", "excuse me"],
    please: ["please"],
    love: ["i love you", "love you", "love", "ily"],
    yes: ["yes", "yeah", "yep", "yup", "sure", "of course", "correct", "right", "affirmative", "ok", "okay", "alright", "fine"],
    no: ["no", "nope", "nah", "not really", "never", "wrong"],
    good: ["good", "great", "fine", "well", "happy", "awesome", "amazing", "excellent", "fantastic", "nice", "cool", "wonderful"],
    bad: ["bad", "sad", "tired", "sick", "terrible", "awful", "not good", "unhappy", "angry", "upset", "stressed", "lonely", "bored"],
    help: ["help", "assist", "support", "emergency", "help me", "need help"],
    water: ["water", "thirsty"],
    drink: ["drink", "coffee", "tea", "juice", "milk"],
    eat: ["eat", "food", "lunch", "dinner", "breakfast", "snack", "meal"],
    hungry: ["hungry", "starving", "starved"],
    more: ["more", "again", "another", "repeat"],
    stop: ["stop", "wait", "pause", "hold on", "enough", "quiet"],
    call: ["call", "phone", "ring", "text"],
    think: ["think", "thinking", "hmm", "hm", "let me think"],
    rock: ["rock", "rock on", "metal"],
    nice: ["nice to meet you", "nice meeting you", "pleased to meet you"],
    name: ["name", "called"],
    what: ["what"],
    where: ["where"],
    you: ["you", "your", "yourself"],
    me: ["i", "me", "my", "mine", "myself"],
  };
  const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
                         eleven: 11, twelve: 12, twenty: 20, hundred: 100 };

  function hasPhrase(t, phrase) {
    return new RegExp("(^|\\s)" + phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\s|$)").test(t);
  }
  // → { greet: true, name: true, ... } for every concept mentioned
  function conceptsIn(t) {
    const found = {};
    Object.entries(CONCEPTS).forEach(([c, list]) => { if (list.some(p => hasPhrase(t, p))) found[c] = true; });
    return found;
  }
  // signed tokens → plain words for understanding (letters merged into words)
  function tokensToPlain(tokens) {
    const out = []; let cur = "";
    tokens.forEach(tok => {
      if (vocab.isLetterToken(tok)) { cur += vocab.letterOf(tok); return; }
      if (cur) { out.push(cur); cur = ""; }
      out.push(tok.replace(/-/g, " "));
    });
    if (cur) out.push(cur);
    return out.join(" ");
  }

  // ---------- helpers for replies ----------
  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const titleName = s => s.split(/\s+/).map(cap).join(" ");
  function spell(word) {
    // first word only, so "Maria Lopez" is spelled M-A-R-I-A
    return String(word).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "").split("").map(ch => "letter:" + ch);
  }
  // Gloss tokens for free text: known signs + fingerspelled names.
  const WORD_TO_SIGN = {
    hello: "hello", hi: "hello", hey: "hello", bye: "bye", goodbye: "bye", thanks: "thank-you", thank: "thank-you",
    welcome: "good", please: "please", sorry: "sorry", love: "i-love-you", yes: "yes", sure: "yes", no: "no",
    ok: "ok", okay: "ok", good: "good", great: "good", glad: "good", fine: "ok", bad: "bad", you: "you", your: "you",
    i: "me", me: "me", my: "me", what: "what", where: "where", name: "name", think: "think", help: "help",
    water: "water", eat: "eat", food: "eat", drink: "drink", hungry: "hungry", more: "more", stop: "stop",
    wait: "stop", call: "call", phone: "call", one: "one", two: "two", three: "three", four: "four", rock: "rock",
    nice: "nice",
  };
  function autoGloss(text, max = 5) {
    const out = [];
    words(normalize(text)).forEach(w => {
      const s = WORD_TO_SIGN[w];
      if (s && out[out.length - 1] !== s && out.length < max) out.push(s);
    });
    return out.length ? out : ["ok"];
  }

  // ---------- arithmetic tool ----------
  function parseNumber(tok) {
    if (/^-?\d+(\.\d+)?$/.test(tok)) return parseFloat(tok);
    if (tok in NUMBER_WORDS) return NUMBER_WORDS[tok];
    return null;
  }
  function tryMath(t) {
    const toks = t.replace(/what is|what's|calculate|compute|how much is/g, " ").split(/\s+/).filter(Boolean);
    const OPS = { "+": "+", plus: "+", add: "+", "-": "-", minus: "-", "*": "*", "×": "*", times: "*", x: "*",
                  multiplied: "*", "/": "/", "÷": "/", divided: "/", over: "/" };
    for (let i = 1; i < toks.length - 1; i++) {
      const op = OPS[toks[i]];
      if (!op) continue;
      let j = i + 1;
      if (toks[j] === "by") j++;
      const a = parseNumber(toks[i - 1]), b = parseNumber(toks[j]);
      if (a == null || b == null) continue;
      if (op === "/" && b === 0) return { text: "Dividing by zero is not something even I can do!", value: null };
      const v = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : a / b;
      const value = Math.round(v * 1000) / 1000;
      return { text: `${a} ${op === "*" ? "×" : op === "/" ? "÷" : op} ${b} = ${value}.`, value };
    }
    return null;
  }

  // ---------- the engine ----------
  class MockLLM {
    constructor(opts = {}) {
      this.random = opts.random || Math.random;
      this.now = opts.now || (() => new Date());
      this.reset();
    }
    reset() {
      this.state = { name: null, mood: null, pending: null, turns: 0, lastIntent: null, needs: [], lastBot: null };
      this.used = {};
    }

    // pick a variant, avoiding the one used last time for this key
    pick(key, options) {
      if (options.length === 1) return options[0];
      const last = this.used[key];
      let idx = Math.floor(this.random() * options.length);
      if (idx === last) idx = (idx + 1) % options.length;
      this.used[key] = idx;
      return options[idx];
    }

    /**
     * input: { text, tokens?: [sign ids / letter:x], source: "sign" | "text" }
     * returns { text, gloss: [tokens], intents: [..] }
     */
    respond(input) {
      const tokens = input.tokens || [];
      const raw = input.text != null ? input.text : tokensToPlain(tokens);
      const t = normalize(raw);
      const spelled = this._spelledWords(tokens);
      const C = conceptsIn(t);
      this.state.turns++;

      const parts = [];   // { text, gloss, intent }
      const add = (intent, text, gloss) => parts.push({ intent, text, gloss: gloss || autoGloss(text) });

      // 1) answers to something we asked last turn
      const pending = this.state.pending;
      this.state.pending = null;
      if (pending && this._handlePending(pending, t, C, spelled, add)) return this._finish(parts);

      // 2) explicit tools / question forms (checked before small talk)
      if (this._tools(t, C, add, tokens)) return this._finish(parts);

      // 3) name handling
      const name = this._extractName(t, tokens, spelled, C);
      if (C.greet) {
        const who = name || this.state.name;
        if (name) this.state.name = name;
        if (this.state.turns > 1 && this.state.lastIntent === "greet") {
          add("greet", this.pick("greet-again", ["Hello again!", "Hi again! 👋", "Hey, still here!"]), ["hello"]);
        } else if (who) {
          add("greet", this.pick("greet-name", [`Hello ${who}! Nice to meet you.`, `Hi ${who}! Great to see you.`]),
              ["hello", ...spell(who), "nice"]);
        } else {
          add("greet", this.pick("greet", ["Hello! How are you today?", "Hi there! How are you?", "Hey! How's your day going?"]),
              ["hello", "you", "good", "what"]);
          this.state.pending = "how-are-you";
        }
      } else if (name) {
        this.state.name = name;
        add("name", this.pick("name-set", [`Nice to meet you, ${name}!`, `${name} — what a great name. Nice to meet you!`]),
            ["nice", ...spell(name)]);
      }

      if (C.nice && !C.greet && !name) add("nice", "Nice to meet you too!", ["nice", "you"]);

      // 4) feelings / small talk
      if (/how are you|how is it going|how do you do|how have you been|you good|you ok/.test(t)) {
        add("how-are-you", this.pick("im-fine", ["I'm doing great, thanks for asking! How about you?",
                                                  "I'm good! And you — how are you feeling?"]), ["me", "good", "you"]);
        this.state.pending = "how-are-you";
      } else if (!parts.length && (C.good || C.bad) && !C.help && /(^| )(i am|i feel|feeling|me) /.test(" " + t + " ")) {
        this._mood(C, add);
      }

      // 5) needs
      if (C.help) {
        add("help", this.pick("help", ["I'm here to help. What do you need — water, food, or should I call someone?",
                                      "Of course. Tell me what you need: water, food, a call?"]), ["help", "what", "water", "eat", "call"]);
        this.state.pending = "help-what";
      }
      if (C.water || (C.drink && C.water)) {
        this._need("water", add);
      } else if (C.drink) {
        this._need("drink", add);
      }
      if (C.hungry || C.eat) this._need("food", add);
      if (C.call && !C.help) {
        add("call", "Sure — who should I call? You can sign or fingerspell a name.", ["call", "name", "what"]);
        this.state.pending = "call-who";
      }
      if (C.more && !parts.length) {
        if (this.state.lastBot) add("more", "Sure, here it is again: " + this.state.lastBot.text, this.state.lastBot.gloss);
        else add("more", "More of what? Tell me what you'd like.", ["more", "what"]);
      }

      // 6) social reactions
      if (C.thanks) add("thanks", this.pick("thanks", ["You're welcome!", "Anytime! 😊", "Happy to help!"]), ["good", "you"]);
      if (C.sorry) add("sorry", this.pick("sorry", ["No worries at all.", "That's okay — no problem!"]), ["ok", "good"]);
      if (C.love) add("love", this.pick("love", ["Aww, I love you too! 🤟", "That's so kind. 🤟 Right back at you!"]), ["i-love-you"]);
      if (C.stop) add("stop", "Okay, I'll pause. Sign or type when you're ready.", ["ok", "stop"]);
      if (C.rock) add("rock", "Rock on! 🤘", ["rock", "good"]);
      if (C.think && !parts.length) add("think", "Take your time — I'll wait.", ["think", "ok", "stop"]);
      if (C.bye) {
        const who = this.state.name ? ` ${this.state.name}` : "";
        add("bye", this.pick("bye", [`Goodbye${who}! Talk soon.`, `Bye${who}! It was nice chatting.`, `See you later${who}! 👋`]),
            ["bye", ...(this.state.name ? spell(this.state.name) : []), "good"]);
      }

      // 7) bare yes / no / ok / numbers
      if (!parts.length) {
        if (C.yes && !C.no) add("yes", this.pick("yes", ["Great!", "Awesome. 👍", "Perfect."]), ["good"]);
        else if (C.no) add("no", this.pick("no", ["Okay, no problem.", "Alright, got it."]), ["ok"]);
        else if (C.good) add("good", this.pick("good", ["That's great to hear!", "Nice! 😊"]), ["good"]);
        else if (C.bad) this._mood(C, add);
      }
      if (!parts.length) {
        const nums = words(t).map(parseNumber).filter(n => n != null);
        if (nums.length === 1) {
          add("number", `You signed the number ${nums[0]}.`, [["one", "two", "three", "four"][nums[0] - 1] || "ok"].filter(Boolean));
        } else if (nums.length > 1) {
          const sum = nums.reduce((a, b) => a + b, 0);
          add("number", `Those numbers add up to ${sum}.`, ["good"]);
        }
      }
      if (!parts.length && spelled.length) {
        const w = spelled.join(" ");
        add("spelled", `You fingerspelled "${w.toUpperCase()}". Is that your name? (yes / no)`, [...spell(spelled[0]), "name", "what"]);
        this.state.pending = { type: "confirm-name", value: titleName(spelled[0]) };
      }

      // 8) bare question words
      if (!parts.length && C.where) add("where", "Where... what? Ask me where something is and I'll do my best (I'm offline, so no maps).", ["where", "what"]);
      if (!parts.length && C.what) add("what", "What would you like to know? You can ask me the time, a sum, or how to sign a word.", ["what", "you", "think"]);
      if (!parts.length && C.you) add("you", "Me? I'm SignAI, your signing assistant. 🤟", ["me", ...spell("ai")]);
      if (!parts.length && C.me) add("me", this.state.name ? `You're ${this.state.name}!` : "Tell me more about you! What's your name?", ["you", "name", "what"]);

      // 9) fallback
      if (!parts.length) this._fallback(raw, t, add);

      return this._finish(parts);
    }

    _finish(parts) {
      const chosen = parts.slice(0, 3);
      const text = chosen.map(p => p.text).join(" ");
      let gloss = [];
      chosen.forEach(p => p.gloss.forEach(g => {
        if (!(SIGN_IDS.has(g) || (vocab.isLetterToken(g) && SPELLABLE.has(vocab.letterOf(g))) || vocab.isLetterToken(g))) return;
        if (gloss[gloss.length - 1] === g && !vocab.isLetterToken(g)) return;
        gloss.push(g);
      }));
      if (gloss.length > 14) gloss = gloss.slice(0, 14);
      if (!gloss.length) gloss = ["ok"];
      this.state.lastIntent = chosen[0] ? chosen[0].intent : null;
      const out = { text, gloss, intents: chosen.map(p => p.intent) };
      if (!chosen.some(p => p.intent === "more")) this.state.lastBot = out;
      return out;
    }

    _spelledWords(tokens) {
      const out = []; let cur = "";
      tokens.forEach(tok => {
        if (vocab.isLetterToken(tok)) cur += vocab.letterOf(tok);
        else if (cur) { out.push(cur); cur = ""; }
      });
      if (cur) out.push(cur);
      return out;
    }

    _extractName(t, tokens, spelled) {
      // "my name is sam" / "i am sam" / "call me sam" / "this is sam"
      const m = t.match(/(?:my name is|my name's|name is|call me|i am called|i am)\s+([a-z][a-z'\-]{1,20})(?:\s+([a-z][a-z'\-]{1,20}))?/);
      if (m) {
        const NOT_NAMES = new Set([...CONCEPTS.good, ...CONCEPTS.bad, ...CONCEPTS.hungry, "thirsty", "here", "back", "not", "so", "very",
          "a", "an", "the", "fine", "ok", "okay", "deaf", "hard", "feeling", "going", "doing", "sorry", "ready", "done", "lost", "busy",
          "good", "learning", "new", "from", "in", "at", "home", "cold", "hot", "scared", "excited", "confused", "thinking"]);
        if (!NOT_NAMES.has(m[1])) {
          const explicit = /my name|name is|call me|called/.test(t);
          const second = explicit && m[2] && !NOT_NAMES.has(m[2]) && !/^(and|but|nice|how|what|i|you|please|thanks|thank)$/.test(m[2]) ? " " + m[2] : "";
          return titleName(m[1] + second);
        }
      }
      // signed: NAME followed (or preceded) by a fingerspelled word, e.g. ME NAME S-A-M
      if (tokens.includes("name") && spelled.length) return titleName(spelled[0]);
      return null;
    }

    _mood(C, add) {
      if (C.bad) {
        this.state.mood = "bad";
        add("mood", this.pick("mood-bad", ["I'm sorry you're feeling that way. Do you want to talk about it, or can I help with something?",
                                           "Oh no, I'm sorry. Is there anything I can do to help?"]), ["sorry", "help", "you"]);
        this.state.pending = "offer-help";
      } else {
        this.state.mood = "good";
        add("mood", this.pick("mood-good", ["That's great to hear! 😊 What would you like to do?", "Glad you're doing well!"]), ["good"]);
      }
    }

    _need(what, add) {
      this.state.needs.push(what);
      const R = {
        water: [["Got it — you'd like some water. 💧 I'll let someone know.", "Water, coming up! 💧"], ["water", "ok"]],
        drink: [["Something to drink — would you like water? (yes / no)"], ["drink", "water", "what"]],
        food: [["You're hungry — let's find you something to eat. 🍽️", "Food it is! I'll pass that on. 🍽️"], ["eat", "ok"]],
      }[what];
      add("need-" + what, this.pick("need-" + what, R[0]), R[1]);
      if (what === "drink") this.state.pending = "want-water";
    }

    _handlePending(p, t, C, spelled, add) {
      const yes = C.yes && !C.no, no = C.no;
      if (p === "how-are-you") {
        if (C.good || C.bad || /i am (good|fine|ok)/.test(t)) { this._mood(C, add); return !C.help && !C.water && !C.eat; }
        if (yes) { add("mood", "Glad to hear it! 😊", ["good"]); return true; }
        return false;
      }
      if (p === "help-what") {
        if (C.water || C.drink) { this._need("water", add); return true; }
        if (C.eat || C.hungry) { this._need("food", add); return true; }
        if (C.call) { add("call", "Who should I call? Sign or fingerspell a name.", ["call", "name", "what"]); this.state.pending = "call-who"; return true; }
        if (no) { add("help", "Okay. I'm here if you need anything.", ["ok", "help"]); return true; }
        return false;
      }
      if (p === "offer-help") {
        if (yes) { add("help", "Okay — what do you need? Water, food, or should I call someone?", ["what", "water", "eat", "call"]); this.state.pending = "help-what"; return true; }
        if (no) { add("help", "Alright. I'm right here whenever you want to chat. 🤟", ["ok", "i-love-you"]); return true; }
        return false;
      }
      if (p === "want-water") {
        if (yes) { this._need("water", add); return true; }
        if (no) { add("drink", "Okay! Coffee, tea, juice? Just tell me.", ["ok", "drink", "what"]); return true; }
        return false;
      }
      if (p === "call-who") {
        const who = spelled[0] || (t.match(/(?:call|ring|phone)?\s*(?:my\s+)?([a-z]+)$/) || [])[1];
        if (no || C.stop) { add("call", "Okay, I won't call anyone.", ["ok", "stop"]); return true; }
        if (who && !["no", "nobody", "call", "phone"].includes(who)) {
          const n = titleName(who);
          add("call", `Calling ${n}... 📞 (demo — no real call is made)`, ["call", ...spell(who)]);
          return true;
        }
        return false;
      }
      if (p === "ask-name") {
        const n = this._extractName(t, [], spelled, C) || spelled[0] ||
                  (/^[a-z]{2,15}$/.test(t) && !Object.values(CONCEPTS).some(l => l.includes(t)) ? t : null);
        if (n) { this.state.name = titleName(n); add("name", `Nice to meet you, ${this.state.name}!`, ["nice", ...spell(n)]); return true; }
        return false;
      }
      if (p && p.type === "confirm-name") {
        if (yes) { this.state.name = p.value; add("name", `Nice to meet you, ${p.value}!`, ["nice", ...spell(p.value)]); return true; }
        if (no) { add("name", "Got it. What does it mean? You can type it or keep signing.", ["ok", "what"]); return true; }
        return false;
      }
      return false;
    }

    _tools(t, C, add, tokens) {
      // time & date
      if (/what time|the time|time is it|current time|what hour/.test(t)) {
        const d = this.now();
        const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        add("tool-time", `It's ${time} right now. ⏰`, ["ok"]);
        return true;
      }
      if (/what day|today's date|the date|what date|which day/.test(t)) {
        const d = this.now();
        const date = d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
        add("tool-date", `Today is ${date}. 📅`, ["ok"]);
        return true;
      }
      // arithmetic
      const math = tryMath(t);
      if (math) { add("tool-math", math.text, math.value != null && math.value >= 1 && math.value <= 4 && Number.isInteger(math.value)
                                                 ? [["one", "two", "three", "four"][math.value - 1]] : ["ok"]); return true; }
      // counting
      const count = t.match(/count to (\d+|[a-z]+)/);
      if (count) {
        const n = Math.min(parseNumber(count[1]) || 4, 20);
        const seq = Array.from({ length: n }, (_, i) => i + 1);
        add("tool-count", seq.join(", ") + "! 🎉", ["one", "two", "three", "four"].slice(0, Math.min(n, 4)));
        return true;
      }
      // sign lessons: "how do i sign water", "show me thank you", "what is the sign for help"
      const lesson = t.match(/(?:how (?:do|can) (?:i|you|we) sign|how to sign|show me(?: how to sign)?|teach me(?: to sign)?|sign for|the sign for|what is the sign for)\s+(?:the word\s+)?["']?([a-z\- ]{1,24})/);
      if (lesson) {
        const target = lesson[1].trim().replace(/^(a|an|the)\s+/, "");
        const sign = this._findSign(target);
        if (sign) {
          add("lesson", `Here's ${sign.text.toUpperCase()}: ${sign.hint}`, [sign.id]);
        } else if (/^[a-z]+$/.test(target) && target.length <= 12) {
          add("lesson", `I don't have a sign for "${target}" yet, so here it is fingerspelled: ${target.toUpperCase().split("").join("-")}.`, spell(target));
        } else {
          add("lesson", "I'm not sure which word you mean. Try: \"how do I sign water\".", ["what"]);
        }
        return true;
      }
      if (/(?:spell|fingerspell)\s+([a-z]+)/.test(t)) {
        const w = t.match(/(?:spell|fingerspell)\s+([a-z]+)/)[1];
        add("spell", `${w.toUpperCase().split("").join("-")} ✋`, spell(w));
        return true;
      }
      // vocabulary list
      if (/what (signs|words) do you (know|have|understand)|list (of )?(signs|words)|which signs|vocabulary/.test(t)) {
        add("vocab", `I know ${vocab.WORDS.length} signs: ${vocab.WORDS.map(w => w.text.toLowerCase()).join(", ")} — plus fingerspelling.`,
            ["hello", "me", "think", "more"]);
        return true;
      }
      // identity / capabilities
      if (/who are you|what are you|what is your name|your name|what can you do|what do you do/.test(t)) {
        if (/name/.test(t)) add("identity", "My name is SignAI! 🤟", ["me", "name", ...spell("sign"), ...spell("ai")]);
        else add("identity", "I'm SignAI, an offline signing assistant. I can chat, tell the time, do sums, and teach you signs — try \"how do I sign water\".",
                 ["me", "help", "you", "think"]);
        return true;
      }
      if (/what is my name|who am i|do you know my name|remember my name/.test(t) || (C.what && C.me && C.name && tokens.length)) {
        if (this.state.name) add("recall", `Your name is ${this.state.name}! 😊`, ["you", "name", ...spell(this.state.name)]);
        else { add("recall", "I don't know your name yet — what is it?", ["you", "name", "what"]); this.state.pending = "ask-name"; }
        return true;
      }
      // jokes
      if (/joke|funny|make me laugh/.test(t)) {
        add("joke", this.pick("joke", [
          "Why did the scarecrow win an award? Because he was outstanding in his field! 🌾",
          "What do you call a bear with no teeth? A gummy bear! 🐻",
          "Why don't eggs tell jokes? They'd crack each other up. 🥚",
          "What did one wall say to the other? I'll meet you at the corner!",
        ]), ["think", "good"]);
        return true;
      }
      // things a real assistant would need the internet for — be honest
      if (/weather|news|score|stock|price of|search|google|look up/.test(t)) {
        add("offline", "I'm running in offline mock mode, so I can't look that up. Connect a real LLM in ⚙️ settings for open questions.", ["sorry", "no"]);
        return true;
      }
      return false;
    }

    _findSign(target) {
      const norm = s => s.toLowerCase().replace(/[^a-z]/g, "");
      const tn = norm(target);
      return vocab.WORDS.find(w => norm(w.id) === tn || norm(w.text) === tn ||
                                   w.text.toLowerCase().split(/\s*\/\s*/).some(p => norm(p) === tn)) || null;
    }

    _fallback(raw, t, add) {
      const known = words(t).map(w => WORD_TO_SIGN[w]).filter(Boolean);
      const short = raw.length > 40 ? raw.slice(0, 40) + "…" : raw;
      if (known.length) {
        add("fallback", this.pick("fallback-known", [
          `I caught "${short}" but I'm not sure what you'd like me to do. Can you sign it another way?`,
          `Hmm, "${short}" — I understood some of that. Could you say a bit more?`,
        ]), ["think", "more", "please"]);
      } else {
        add("fallback", this.pick("fallback", [
          "I'm not sure I understood. Try signing HELLO, HELP, WATER or asking \"how do I sign thank you\".",
          "Sorry, I didn't get that. You can ask me the time, a sum like 2 + 3, or how to sign a word.",
        ]), ["sorry", "what"]);
      }
    }
  }

  const api = { MockLLM, normalize, conceptsIn, autoGloss, tryMath };
  root.SignAI = root.SignAI || {};
  root.SignAI.mockLLM = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
