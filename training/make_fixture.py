"""Write tests/fixtures/prep-cases.json: random landmark clips + expected preprocess() output,
so tests/sign-model.test.js can check the JavaScript port matches Python exactly."""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from prep import preprocess

rng = np.random.default_rng(42)
cases = []
for T, left_dominant in [(40, False), (20, True), (9, False)]:
    seq = rng.random((T, 107, 3)).astype(np.float32).round(4)
    seq[rng.random(T) < 0.3, 0:21] = np.nan            # some frames lose the left hand
    if left_dominant:
        seq[:, 21:42] = np.nan; seq[::3, 21:42] = rng.random((len(range(0, T, 3)), 21, 3)).round(4)
    seq[rng.random(T) < 0.15, 0:42] = np.nan           # frames with no hands at all
    seq[:, 67:80] = np.nan                             # some lips missing
    x, n = preprocess(seq)
    cases.append({"input": np.where(np.isnan(seq), None, seq).tolist(), "T": int(n),
                  "expected": np.round(x[:n], 5).tolist()})
out = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "prep-cases.json")
json.dump(cases, open(out, "w"), separators=(",", ":"))
print("wrote", out, os.path.getsize(out) // 1024, "KB")
