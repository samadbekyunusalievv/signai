/* Mock LLM conversation tests: node tests/mock-llm.test.js */
"use strict";
const assert = require("assert");
const { MockLLM, tryMath } = require("../js/mock-llm.js");

let n = 0;
function check(name, fn) {
  try { fn(); n++; } catch (e) { console.log("  ✗ " + name + "\n    " + e.message); process.exitCode = 1; }
}
const bot = () => new MockLLM({ random: () => 0, now: () => new Date(2026, 10, 13, 14, 5) });
const has = (r, re) => assert.ok(re.test(r.text), `"${r.text}" !~ ${re}`);

check("greeting asks how you are, then mood follow-up", () => {
  const b = bot();
  const r1 = b.respond({ text: "hello" });
  has(r1, /how are you|how's your day/i);
  assert.ok(r1.gloss.includes("hello"));
  const r2 = b.respond({ text: "I'm tired" });
  has(r2, /sorry/i);
  const r3 = b.respond({ text: "yes" });
  has(r3, /what do you need/i);
  const r4 = b.respond({ text: "water please" });
  has(r4, /water/i);
});

check("compound: greeting + name, name is remembered and fingerspelled", () => {
  const b = bot();
  const r = b.respond({ text: "hi, my name is Sam" });
  has(r, /Sam/);
  assert.deepStrictEqual(r.gloss.filter(g => g.startsWith("letter:")), ["letter:s", "letter:a", "letter:m"]);
  has(b.respond({ text: "what's my name?" }), /Your name is Sam/);
  has(b.respond({ text: "bye" }), /Sam/);
});

check("signed tokens: ME NAME + fingerspelling", () => {
  const b = bot();
  const r = b.respond({ tokens: ["me", "name", "letter:a", "letter:l", "letter:i"] });
  has(r, /Ali/);
});

check("fingerspelled word alone asks to confirm a name", () => {
  const b = bot();
  has(b.respond({ tokens: ["letter:b", "letter:o", "letter:b"] }), /BOB.*name/i);
  has(b.respond({ tokens: ["yes"] }), /Nice to meet you, Bob/);
});

check("'i am hungry' is a need, not a name", () => {
  const b = bot();
  const r = b.respond({ text: "i am hungry" });
  has(r, /eat|food|hungry/i);
  assert.strictEqual(b.state.name, null);
});

check("tools: time, date, math, count", () => {
  const b = bot();
  has(b.respond({ text: "what time is it" }), /2:05/);
  has(b.respond({ text: "what day is it?" }), /Friday/);
  has(b.respond({ text: "what is 12 times 3" }), /= 36/);
  has(b.respond({ text: "2+2" }), /= 4/);
  assert.strictEqual(tryMath("five minus seven").value, -2);
  has(b.respond({ text: "count to 5" }), /1, 2, 3, 4, 5/);
});

check("sign lessons return the sign itself", () => {
  const b = bot();
  const r = b.respond({ text: "how do I sign thank you?" });
  assert.deepStrictEqual(r.gloss, ["thank-you"]);
  const r2 = b.respond({ text: "how do i sign pizza" });
  has(r2, /P-I-Z-Z-A/);
  assert.strictEqual(r2.gloss.length, 5);
});

check("call flow asks who, then calls the spelled name", () => {
  const b = bot();
  has(b.respond({ tokens: ["call"] }), /who should I call/i);
  has(b.respond({ tokens: ["letter:m", "letter:o", "letter:m"] }), /Calling Mom/);
});

check("drink → want water? → yes", () => {
  const b = bot();
  has(b.respond({ tokens: ["drink"] }), /water\?/);
  has(b.respond({ tokens: ["yes"] }), /water/i);
});

check("more repeats the last answer", () => {
  const b = bot();
  const first = b.respond({ text: "tell me a joke" });
  const again = b.respond({ tokens: ["more"] });
  assert.ok(again.text.includes(first.text));
});

check("offline honesty + fallback", () => {
  const b = bot();
  has(b.respond({ text: "what's the weather" }), /offline/);
  has(b.respond({ text: "blorp zix" }), /not sure|didn't get/i);
});

check("variety: same intent does not repeat the same wording twice in a row", () => {
  const b = new MockLLM({ random: () => 0 });
  const a = b.respond({ text: "thanks" }).text;
  const c = b.respond({ text: "thanks" }).text;
  assert.notStrictEqual(a, c);
});

check("every gloss token is a known sign or a letter", () => {
  const vocab = require("../js/vocab.js");
  const ids = new Set(vocab.WORDS.map(w => w.id));
  const b = bot();
  ["hello", "help", "i love you", "sorry", "stop", "rock on", "what can you do", "who are you", "nice to meet you",
   "i feel great", "where", "what", "you", "three"].forEach(t => {
    b.respond({ text: t }).gloss.forEach(g => assert.ok(ids.has(g) || g.startsWith("letter:"), `${t}: bad token ${g}`));
  });
});

console.log(`Mock LLM: ${n} checks passed${process.exitCode ? " (with failures above)" : ""}`);
