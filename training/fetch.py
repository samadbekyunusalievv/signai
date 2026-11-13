"""Stream the Kaggle asl-signs zip (resumable) and keep only the landmarks we need.
Needs the Kaggle API set up and the competition rules accepted.
Output: DATA/islr_{frames.npy, index.csv} (float16 [N_total_frames, P, 3])."""
import io, os, sys, time, json, numpy as np, pandas as pd
DATA = sys.argv[1] if len(sys.argv) > 1 else "data"
os.makedirs(DATA, exist_ok=True)
from stream_unzip import stream_unzip
from kaggle.api.kaggle_api_extended import KaggleApi
from kagglesdk.competitions.types.competition_api_service import ApiDownloadDataFilesRequest

LIPS = [61,185,40,39,37,0,267,269,270,409,291,146,91,181,84,17,314,405,321,375,
        78,191,80,81,82,13,312,311,310,415,95,88,178,87,14,317,402,318,324,308]
POSE = list(range(25))
# point order: left_hand 0-20, right_hand 21-41, pose 42-66, lips 67-106
P = 21 + 21 + len(POSE) + len(LIPS)
face_pos = {v: i for i, v in enumerate(LIPS)}

def convert(buf):
    df = pd.read_parquet(io.BytesIO(buf), columns=["frame", "type", "landmark_index", "x", "y", "z"])
    frames = np.sort(df["frame"].unique())
    fidx = {f: i for i, f in enumerate(frames)}
    out = np.full((len(frames), P, 3), np.nan, dtype=np.float32)
    t = df["type"].values; li = df["landmark_index"].values
    fi = np.fromiter((fidx[f] for f in df["frame"].values), dtype=np.int64, count=len(df))
    xyz = df[["x", "y", "z"]].values.astype(np.float32)
    col = np.full(len(df), -1)
    m = t == "left_hand"; col[m] = li[m]
    m = t == "right_hand"; col[m] = 21 + li[m]
    m = (t == "pose") & (li < 25); col[m] = 42 + li[m]
    m = t == "face"
    if m.any():
        fl = li[m]; c = np.array([face_pos.get(v, -1) for v in fl]); c[c >= 0] += 67; col[np.where(m)[0]] = c
    keep = col >= 0
    out[fi[keep], col[keep]] = xyz[keep]
    return out.astype(np.float16)

api = KaggleApi(); api.authenticate()
t0 = time.time()
with api.build_kaggle_client() as kaggle:
    req = ApiDownloadDataFilesRequest(); req.competition_name = "asl-signs"
    resp = kaggle.competitions.competition_api_client.download_data_files(req)
    total = int(resp.headers.get("Content-Length", 0))
    print("zip size GB:", round(total / 1e9, 2), flush=True)
    got = [0]
    import requests
    url = resp.url
    def chunks():
        # resumable byte stream: on a dropped connection, continue from the exact byte with a Range request
        r, tries = resp, 0
        while True:
            try:
                for c in r.iter_content(4 << 20):
                    got[0] += len(c); tries = 0; yield c
                if got[0] >= total:
                    return
                raise IOError("stream ended early")
            except Exception as e:
                tries += 1
                if tries > 30: raise
                print(f"connection dropped at {got[0]/1e9:.2f} GB ({type(e).__name__}); resuming (try {tries})", flush=True)
                time.sleep(min(30, 2 * tries))
                nonlocal_url = url
                r = requests.get(nonlocal_url, headers={"Range": f"bytes={got[0]}-"}, stream=True, timeout=120)
                if r.status_code in (401, 403):   # signed URL expired: ask Kaggle for a fresh one
                    fresh = kaggle.competitions.competition_api_client.download_data_files(req)
                    r = requests.get(fresh.url, headers={"Range": f"bytes={got[0]}-"}, stream=True, timeout=120)
                if r.status_code != 206:
                    raise IOError(f"resume failed: HTTP {r.status_code}")
    seqs, rows, meta = [], [], {}
    n = 0
    for name, size, unzipped in stream_unzip(chunks()):
        name = name.decode()
        data = b"".join(unzipped)
        if name.endswith(".parquet"):
            arr = convert(data)
            seqs.append(arr); rows.append((name, len(arr))); n += 1
            if n % 2000 == 0:
                el = time.time() - t0
                print(f"{n} seqs  {got[0]/1e9:.1f}/{total/1e9:.1f} GB  {got[0]/1e6/el:.1f} MB/s  {el/60:.1f} min", flush=True)
        elif name in ("train.csv", "sign_to_prediction_index_map.json"):
            meta[name] = data
for k, v in meta.items():
    open(f"{DATA}/{k}", "wb").write(v)
offsets = np.cumsum([0] + [r[1] for r in rows])
np.save(f"{DATA}/islr_frames.npy", np.concatenate(seqs))
pd.DataFrame({"path": [r[0] for r in rows], "start": offsets[:-1], "length": [r[1] for r in rows]}).to_csv(f"{DATA}/islr_index.csv", index=False)
print("done", n, "sequences in", round((time.time() - t0) / 60, 1), "min", flush=True)
