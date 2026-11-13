"""Turn the compacted Kaggle data into model-ready arrays.

Reads  : DATA/islr_frames.npy, DATA/islr_index.csv, DATA/train.csv, DATA/sign_to_prediction_index_map.json
Writes : DATA/ds_X.npy [N, 32, 94, 2] float16, ds_len.npy, ds_y.npy, ds_pid.npy
"""
import json, os, sys, time
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from prep import preprocess, MAX_LEN, N_POINTS

DATA = sys.argv[1] if len(sys.argv) > 1 else "data"
frames = np.load(f"{DATA}/islr_frames.npy", mmap_mode="r")
index = pd.read_csv(f"{DATA}/islr_index.csv")
train = pd.read_csv(f"{DATA}/train.csv")
sign_map = json.load(open(f"{DATA}/sign_to_prediction_index_map.json"))
meta = index.merge(train, on="path", how="inner")
print(len(index), "sequences,", len(meta), "with labels")

N = len(meta)
X = np.zeros((N, MAX_LEN, N_POINTS, 2), np.float16)
L = np.zeros(N, np.int16)
t0 = time.time()
for i, r in enumerate(meta.itertuples()):
    seq = np.asarray(frames[r.start:r.start + r.length], dtype=np.float32)
    X[i], L[i] = preprocess(seq)
    if i % 10000 == 0:
        print(i, f"{time.time() - t0:.0f}s", flush=True)
np.save(f"{DATA}/ds_X.npy", X)
np.save(f"{DATA}/ds_len.npy", L)
np.save(f"{DATA}/ds_y.npy", meta["sign"].map(sign_map).values.astype(np.int16))
np.save(f"{DATA}/ds_pid.npy", meta["participant_id"].values.astype(np.int32))
print("saved", X.shape, "in", round(time.time() - t0), "s")
