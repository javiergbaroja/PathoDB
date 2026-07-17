"""
Synthetic unit tests for stage_invasion (no GPU / no WSI needed).

Builds toy transmural "bowel wall" label masks and checks that the pT category,
depth-beyond-MP and interfaces come out as expected.

Run with the metassist env:
    module load Anaconda3 && source activate metassist
    python models/crc_invasion_extent/test_staging.py
"""

import numpy as np

from staging import stage_invasion

# Minimal label2id matching the crc_tissue_segmentation backbone.
LABEL2ID = {
    "Background": 1, "Fat": 2, "Normal Mucosa": 3, "Stroma": 5,
    "Mucous": 6, "Tumor": 7, "Muscle/vessel": 9,
}
MPP = 1.0  # µm/px, as the backbone runs at ~1.0


S = 4  # scale factor -> realistic mm-scale geometry at 1 µm/px


def make_wall(tumor_bottom_row: int) -> np.ndarray:
    """
    Vertical wall, (600*S) rows tall (rows = depth, top = lumen), at 1 µm/px:
        0-100   Normal Mucosa
        100-200 Stroma (submucosa)
        200-340 Muscle/vessel (muscularis propria; outer edge at row 340)
        340-600 Fat (pericolic adipose)
    A tumour column invades from the luminal surface (row 0) down to
    `tumor_bottom_row`. All coordinates are given in pre-scale units and
    multiplied by S, so the tumour is comfortably above the min-object size.
    """
    s = S
    seg = np.zeros((600 * s, 400 * s), np.int32)
    seg[0:100 * s]        = LABEL2ID["Normal Mucosa"]
    seg[100 * s:200 * s]  = LABEL2ID["Stroma"]
    seg[200 * s:340 * s]  = LABEL2ID["Muscle/vessel"]
    seg[340 * s:600 * s]  = LABEL2ID["Fat"]
    seg[0:tumor_bottom_row * s, 140 * s:260 * s] = LABEL2ID["Tumor"]
    return seg


def check(name, cond):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
    assert cond, name


def test_pt1_or_lower():
    # Tumour confined to mucosa/superficial submucosa (well clear of muscle,
    # which starts at row 200*S; adjacency radius is 120 µm).
    r = stage_invasion(make_wall(140), LABEL2ID, MPP)
    print("pT1_or_lower case ->", r.status, r.confidence, r.interfaces)
    check("status pT1_or_lower", r.status == "pT1_or_lower")
    check("no muscle interface", r.interfaces["tumor_in_muscle"] is False)
    check("depth == 0", r.depth_beyond_mp_mm == 0.0)


def test_pt2():
    # Tumour into the muscularis propria but not through it.
    r = stage_invasion(make_wall(300), LABEL2ID, MPP)
    print("pT2 case ->", r.status, r.confidence, r.interfaces)
    check("status pT2", r.status == "pT2")
    check("muscle interface", r.interfaces["tumor_in_muscle"] is True)
    check("not beyond MP", r.depth_beyond_mp_mm == 0.0)
    check("label 0", r.label == 0)


def test_pt3():
    # Tumour through the muscularis into pericolic fat (to row 480 -> (480-340)*S
    # = 560 µm beyond the outer MP edge at row 340).
    r = stage_invasion(make_wall(480), LABEL2ID, MPP)
    print("pT3 case ->", r.status, r.confidence,
          f"depth={r.depth_beyond_mp_mm:.3f} mm", r.interfaces)
    check("status pT3", r.status == "pT3")
    check("label 1", r.label == 1)
    check("fat interface", r.interfaces["tumor_in_fat"] is True)
    check("depth > 0.40 mm", r.depth_beyond_mp_mm > 0.40)
    check("depth < 0.75 mm", r.depth_beyond_mp_mm < 0.75)  # ~560 µm
    check("deepest point set", r.deepest_point_xy is not None)
    check("overlay masks present", r.beyond_mp_tumor_mask is not None
          and r.beyond_mp_tumor_mask.any())


def test_no_tumor():
    seg = make_wall(0)  # no tumour rows
    r = stage_invasion(seg, LABEL2ID, MPP)
    print("no_tumor case ->", r.status, r.confidence)
    check("status no_tumor", r.status == "no_tumor")


def test_outcome_serialisable():
    import json
    r = stage_invasion(make_wall(480), LABEL2ID, MPP)
    out = r.to_outcome()
    json.dumps(out)  # must be JSON-serialisable
    check("primary_metric present", out["primary_metric"]["value"].startswith("pT3"))
    check("caveats present", len(out["caveats"]) >= 3)
    check("card severity positive", out["card"]["severity"] == "positive")
    check("card has pT row", any(r["label"] == "pT (AI estimate)" for r in out["card"]["rows"]))


if __name__ == "__main__":
    for fn in [test_pt1_or_lower, test_pt2, test_pt3, test_no_tumor,
               test_outcome_serialisable]:
        print(f"\n=== {fn.__name__} ===")
        fn()
    print("\nAll staging tests passed.")
