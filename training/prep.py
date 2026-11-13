"""Shared preprocessing for the SignAI sign classifier.

The browser (js/sign-model.js) implements EXACTLY the same steps, so keep both in sync.

Input  : one sequence [T, 107, 3] of MediaPipe Holistic landmarks (NaN = missing)
         point order: left hand 0-20, right hand 21-41, pose 42-66 (pose idx 0-24), lips 67-106
Output : positions [MAX_LEN, N_POINTS, 2] (float32) and the number of real frames
"""
import numpy as np

MAX_LEN = 32
LH = list(range(0, 21))
RH = list(range(21, 42))
POSE_ARMS = [42 + i for i in range(11, 23)]          # shoulders, elbows, wrists, hand points
LIPS = list(range(67, 107))
# after dominant-hand normalisation the dominant hand always sits in the RH slot
SELECT = RH + LH + POSE_ARMS + LIPS                   # 21 + 21 + 12 + 40 = 94 points
N_POINTS = len(SELECT)
# pose left/right pairs (MediaPipe pose indices) swapped when mirroring
POSE_PAIRS = [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 18), (19, 20), (21, 22), (23, 24)]


def mirror(seq):
    """Flip x and swap the left/right hand and pose slots."""
    out = seq.copy()
    out[..., 0] = 1.0 - out[..., 0]
    out[:, LH], out[:, RH] = seq[:, RH].copy(), seq[:, LH].copy()
    out[:, LH, 0] = 1.0 - out[:, LH, 0]
    out[:, RH, 0] = 1.0 - out[:, RH, 0]
    for a, b in POSE_PAIRS:
        out[:, 42 + a], out[:, 42 + b] = out[:, 42 + b].copy(), out[:, 42 + a].copy()
    return out


def preprocess(seq):
    seq = np.asarray(seq, dtype=np.float32)
    # 1) dominant hand: the hand seen in more frames goes to the RH slot
    lh_frames = np.isfinite(seq[:, LH, 0]).any(1).sum()
    rh_frames = np.isfinite(seq[:, RH, 0]).any(1).sum()
    if lh_frames > rh_frames:
        seq = mirror(seq)
    # 2) keep frames where a hand is visible (unless there are none)
    hand = np.isfinite(seq[:, LH + RH, 0]).any(1)
    if hand.any():
        seq = seq[hand]
    # 3) resample long sequences to MAX_LEN frames (nearest frame)
    T = len(seq)
    if T > MAX_LEN:
        # floor(x + 0.5), not np.round (banker's rounding), so JavaScript matches exactly
        idx = np.floor(np.arange(MAX_LEN) * (T - 1) / (MAX_LEN - 1) + 0.5).astype(np.int64)
        seq = seq[idx]
        T = MAX_LEN
    xy = seq[:, SELECT, :2]
    # 4) normalise by the mean / std of all visible coordinates in the sequence
    #    (mean per axis; std = RMS distance of the centred coordinates)
    if np.isfinite(xy).any():
        mean = np.nanmean(xy.reshape(-1, 2), axis=0)
        c = xy - mean
        std = float(np.sqrt(np.nanmean(c ** 2)))
    else:
        mean, std = np.zeros(2, np.float32), 1.0
    xy = (xy - mean) / max(std, 1e-6)
    xy = np.nan_to_num(xy, nan=0.0)
    out = np.zeros((MAX_LEN, N_POINTS, 2), np.float32)
    out[:T] = xy
    return out, T
