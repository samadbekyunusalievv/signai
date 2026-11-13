"""Train the SignAI 250-sign classifier on CPU and export it to ONNX for the browser.

usage: python train.py [--epochs 40] [--holdout 2] [--all] [--out ../models]
  --holdout N : keep N signers out of training to measure accuracy on unseen people
  --all       : after evaluating, train the final model on every signer
"""
import argparse, json, math, os, sys, time
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F
sys.path.insert(0, os.path.dirname(__file__))
from prep import MAX_LEN, N_POINTS

ap = argparse.ArgumentParser()
ap.add_argument("--data", default="/tmp/claude-0/data")
ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "models"))
ap.add_argument("--epochs", type=int, default=30)
ap.add_argument("--batch", type=int, default=256)
ap.add_argument("--lr", type=float, default=2e-3)
ap.add_argument("--dim", type=int, default=160)
ap.add_argument("--holdout", type=int, default=2)
ap.add_argument("--all", action="store_true")
ap.add_argument("--limit", type=int, default=0, help="debug: use only this many samples")
args = ap.parse_args()
torch.set_num_threads(os.cpu_count())
torch.manual_seed(0); np.random.seed(0)

# ---------------- model ----------------
class ConvBlock(nn.Module):
    def __init__(self, d, k=7, drop=0.2):
        super().__init__()
        self.ln = nn.LayerNorm(d)
        self.dw = nn.Conv1d(d, d, k, padding=k // 2, groups=d)
        self.ff1, self.ff2 = nn.Linear(d, 2 * d), nn.Linear(2 * d, d)
        self.drop = nn.Dropout(drop)
    def forward(self, h, m):
        y = self.ln(h) * m
        y = self.dw(y.transpose(1, 2)).transpose(1, 2)
        y = self.ff2(F.silu(self.ff1(y)))
        return h + self.drop(y)

class AttnBlock(nn.Module):
    """Plain multi-head self-attention (written out so ONNX export stays simple)."""
    def __init__(self, d, heads=4, drop=0.2):
        super().__init__()
        self.h = heads
        self.ln1, self.ln2 = nn.LayerNorm(d), nn.LayerNorm(d)
        self.qkv, self.proj = nn.Linear(d, 3 * d), nn.Linear(d, d)
        self.ff1, self.ff2 = nn.Linear(d, 2 * d), nn.Linear(2 * d, d)
        self.drop = nn.Dropout(drop)
    def forward(self, h, m):
        B, T, D = h.shape
        q, k, v = self.qkv(self.ln1(h)).reshape(B, T, 3, self.h, D // self.h).permute(2, 0, 3, 1, 4)
        att = (q @ k.transpose(-1, -2)) / math.sqrt(D // self.h)
        att = att + (1.0 - m[:, None, None, :, 0]) * -1e4
        y = (att.softmax(-1) @ v).transpose(1, 2).reshape(B, T, D)
        h = h + self.drop(self.proj(y))
        return h + self.drop(self.ff2(F.silu(self.ff1(self.ln2(h)))))

class SignNet(nn.Module):
    def __init__(self, n_cls=250, d=192):
        super().__init__()
        f = N_POINTS * 2 * 2   # positions + velocities
        self.inp = nn.Sequential(nn.Linear(f, d), nn.LayerNorm(d), nn.SiLU())
        self.blocks = nn.ModuleList([ConvBlock(d), ConvBlock(d), AttnBlock(d), ConvBlock(d), ConvBlock(d), AttnBlock(d)])
        self.head = nn.Sequential(nn.LayerNorm(d), nn.Dropout(0.3), nn.Linear(d, n_cls))
    def forward(self, x, mask):
        # x: [B, T, P, 2] normalised positions (0 = missing); mask: [B, T] 1 for real frames
        B, T = x.shape[:2]
        m = mask.unsqueeze(-1)
        pos = x.reshape(B, T, -1)
        vel = torch.cat([torch.zeros_like(pos[:, :1]), pos[:, 1:] - pos[:, :-1]], 1) * m
        vel = vel * torch.cat([torch.zeros_like(m[:, :1]), m[:, :-1]], 1)   # no velocity across padding
        h = self.inp(torch.cat([pos, vel], -1)) * m
        for b in self.blocks:
            h = b(h, m) * m
        pooled = h.sum(1) / m.sum(1).clamp(min=1.0)
        return self.head(pooled)

# ---------------- data ----------------
X = np.load(f"{args.data}/ds_X.npy", mmap_mode="r")
L = np.load(f"{args.data}/ds_len.npy").astype(np.int64)
Y = np.load(f"{args.data}/ds_y.npy").astype(np.int64)
PID = np.load(f"{args.data}/ds_pid.npy")
if args.limit:
    X, L, Y, PID = X[:args.limit], L[:args.limit], Y[:args.limit], PID[:args.limit]
X = torch.from_numpy(np.ascontiguousarray(X))           # float16, converted per batch
L, Y = torch.from_numpy(L), torch.from_numpy(Y)
people = np.unique(PID)
held = people[-args.holdout:] if args.holdout else []
val_idx = np.where(np.isin(PID, held))[0]
train_idx = np.where(~np.isin(PID, held))[0]
print(f"{len(people)} signers; training on {len(train_idx)} clips, validating on {len(val_idx)} clips from {len(held)} unseen signers", flush=True)

def batch(idx, augment):
    x = X[idx].float()
    lens = L[idx].clamp(min=1)
    B = len(idx)
    if augment:
        # temporal speed change (0.7x – 1.3x): resample frame indices
        r = torch.empty(B).uniform_(0.7, 1.3)
        new_len = (lens.float() * r).round().long().clamp(1, MAX_LEN)
        t = torch.arange(MAX_LEN).float()[None]
        src = (t * lens[:, None].float() / new_len[:, None].float()).floor().long()
        src = torch.minimum(src, (lens - 1)[:, None])
        x = torch.gather(x, 1, src[:, :, None, None].expand(-1, -1, N_POINTS, 2))
        lens = new_len
        missing = (x == 0).all(-1, keepdim=True)
        # random affine: rotation, per-axis scale, shear, shift
        a = torch.empty(B).uniform_(-0.26, 0.26)
        sx, sy = torch.empty(B).uniform_(0.8, 1.2), torch.empty(B).uniform_(0.8, 1.2)
        sh = torch.empty(B).uniform_(-0.15, 0.15)
        M = torch.stack([torch.stack([sx * torch.cos(a), -torch.sin(a) + sh], -1),
                         torch.stack([torch.sin(a), sy * torch.cos(a)], -1)], 1)   # [B,2,2]
        x = torch.einsum("btpc,bdc->btpd", x, M) + torch.empty(B, 1, 1, 2).uniform_(-0.15, 0.15)
        # sometimes hide the second hand or the lips (robustness to tracking drop-outs)
        hide2 = torch.rand(B) < 0.1
        x[hide2, :, 21:42] = 0
        hidel = torch.rand(B) < 0.1
        x[hidel, :, 54:] = 0
        x = x.masked_fill(missing, 0.0)
    mask = (torch.arange(MAX_LEN)[None] < lens[:, None]).float()
    x = x * mask[:, :, None, None]
    return x, mask

def evaluate(model, idx):
    model.eval(); top1 = top3 = 0
    with torch.no_grad():
        for i in range(0, len(idx), 1024):
            b = idx[i:i + 1024]
            x, m = batch(b, False)
            logits = model(x, m)
            t3 = logits.topk(3, -1).indices
            y = Y[b]
            top1 += (t3[:, 0] == y).sum().item(); top3 += (t3 == y[:, None]).any(1).sum().item()
    return top1 / max(len(idx), 1), top3 / max(len(idx), 1)

def train(idx, epochs, eval_idx=None):
    model = SignNet(d=args.dim)
    print("params:", sum(p.numel() for p in model.parameters()), flush=True)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.05)
    steps = epochs * math.ceil(len(idx) / args.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps, pct_start=0.1)
    for ep in range(epochs):
        model.train(); t0 = time.time(); tot = 0.0
        perm = np.random.permutation(idx)
        for i in range(0, len(perm), args.batch):
            b = perm[i:i + args.batch]
            x, m = batch(b, True)
            loss = F.cross_entropy(model(x, m), Y[b], label_smoothing=0.1)
            opt.zero_grad(); loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step(); tot += loss.item() * len(b)
        msg = f"epoch {ep + 1}/{epochs}  loss {tot / len(idx):.3f}  {time.time() - t0:.0f}s"
        if eval_idx is not None and len(eval_idx) and ((ep + 1) % 5 == 0 or ep + 1 == epochs):
            a1, a3 = evaluate(model, eval_idx)
            msg += f"  unseen-signer acc top1 {a1:.3f} top3 {a3:.3f}"
        print(msg, flush=True)
    return model

def export(model, path):
    model.eval()
    x = torch.zeros(1, MAX_LEN, N_POINTS, 2); m = torch.ones(1, MAX_LEN)
    torch.onnx.export(model, (x, m), path, input_names=["x", "mask"], output_names=["logits"],
                      opset_version=17, dynamo=False)
    import onnxruntime as ort
    xs, ms = batch(np.arange(min(8, len(Y))), False)
    sess = ort.InferenceSession(path)
    with torch.no_grad():
        ref = model(xs[:1], ms[:1]).numpy()
    got = sess.run(None, {"x": xs[:1].numpy(), "mask": ms[:1].numpy()})[0]
    print(f"exported {path} ({os.path.getsize(path) / 1e6:.1f} MB), max |torch - onnx| = {np.abs(ref - got).max():.2e}", flush=True)

os.makedirs(args.out, exist_ok=True)
model = train(train_idx, args.epochs, val_idx)
results = {}
if len(val_idx):
    a1, a3 = evaluate(model, val_idx)
    results = {"unseen_signers": [int(p) for p in held], "val_clips": int(len(val_idx)), "top1": round(a1, 4), "top3": round(a3, 4)}
    print("FINAL unseen-signer accuracy:", results, flush=True)
if args.all:
    print("retraining on all signers for the final model", flush=True)
    model = train(np.arange(len(Y)), args.epochs)
export(model, os.path.join(args.out, "sign-model.onnx"))
sign_map = json.load(open(f"{args.data}/sign_to_prediction_index_map.json"))
labels = [s for s, _ in sorted(sign_map.items(), key=lambda kv: kv[1])]
json.dump({"labels": labels, "max_len": MAX_LEN, "n_points": N_POINTS, "eval": results,
           "epochs": args.epochs, "trained_on_all": bool(args.all)}, open(os.path.join(args.out, "sign-model.json"), "w"), indent=1)
print("done", flush=True)
