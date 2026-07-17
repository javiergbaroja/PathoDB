"""
Synthetic unit tests for count_budding (no GPU / no WSI needed).

Run with the metassist env:
    module load Anaconda3 && source activate metassist
    python models/crc_tumour_budding/test_budding.py
"""

import cv2
import numpy as np

from budding import count_budding

LABEL2ID = {"Background": 1, "Stroma": 5, "Tumor": 7, "Normal Mucosa": 3}
MPP = 1.0
TUMOR, STROMA, MUCOSA = LABEL2ID["Tumor"], LABEL2ID["Stroma"], LABEL2ID["Normal Mucosa"]

MAIN_C = (400, 400)   # main tumour centre
BUD_C  = (400, 560)   # bud cluster centre (150 px from main centre → in front band)


def scene():
    seg = np.full((1200, 1200), STROMA, np.int32)
    cv2.circle(seg, MAIN_C, 70, TUMOR, -1)     # main tumour mass (~15 400 px)
    return seg


def stamp_buds(seg, center, n, spacing=26, radius=4):
    """Stamp n single-cell buds (~50 px each) in a compact grid around center."""
    cx, cy = center
    side = int(np.ceil(np.sqrt(n)))
    k = 0
    for r in range(side):
        for c in range(side):
            if k >= n:
                return
            x = cx + (c - side // 2) * spacing
            y = cy + (r - side // 2) * spacing
            cv2.circle(seg, (x, y), radius, TUMOR, -1)
            k += 1


def check(name, cond):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
    assert cond, name


def test_bd1():
    seg = scene(); stamp_buds(seg, BUD_C, 3)
    r = count_budding(seg, LABEL2ID, MPP)
    print("Bd1 ->", r.grade, r.bud_count_hotspot, r.confidence)
    check("grade Bd1", r.grade == "Bd1")
    check("hotspot 3", r.bud_count_hotspot == 3)
    check("label 0", r.label == 0)


def test_bd2():
    seg = scene(); stamp_buds(seg, BUD_C, 7)
    r = count_budding(seg, LABEL2ID, MPP)
    print("Bd2 ->", r.grade, r.bud_count_hotspot)
    check("grade Bd2", r.grade == "Bd2")
    check("hotspot 7", r.bud_count_hotspot == 7)


def test_bd3():
    seg = scene(); stamp_buds(seg, BUD_C, 12)
    r = count_budding(seg, LABEL2ID, MPP)
    print("Bd3 ->", r.grade, r.bud_count_hotspot)
    check("grade Bd3", r.grade == "Bd3")
    check("label 1", r.label == 1)
    check("hotspot 12", r.bud_count_hotspot == 12)
    check("hotspot centre set", r.hotspot_center_xy is not None)


def test_far_buds_excluded():
    # Buds far from the main tumour front should not be counted.
    seg = scene(); stamp_buds(seg, (1080, 1080), 8)
    r = count_budding(seg, LABEL2ID, MPP)
    print("far ->", r.grade, "total", r.total_buds)
    check("no buds counted", r.total_buds == 0)
    check("grade Bd1", r.grade == "Bd1")


def test_noise_excluded():
    # Sub-single-cell specks (radius 2 → ~12 px < noise floor) are not buds.
    seg = scene()
    for i in range(10):
        cv2.circle(seg, (400 + i * 20, 540), 2, TUMOR, -1)
    r = count_budding(seg, LABEL2ID, MPP)
    print("noise ->", r.total_buds)
    check("noise not counted", r.total_buds == 0)


def test_mucosa_side_excluded():
    # Buds on the mucosal side of the tumour are excluded from the front count.
    seg = scene()
    seg[0:260, :] = MUCOSA           # mucosa above the tumour
    stamp_buds(seg, (400, 250), 8)   # buds inside/next to the mucosa
    r = count_budding(seg, LABEL2ID, MPP)
    print("mucosa ->", r.total_buds)
    check("mucosal buds excluded", r.total_buds == 0)


def test_no_tumor():
    seg = np.full((600, 600), STROMA, np.int32)
    r = count_budding(seg, LABEL2ID, MPP)
    check("no_tumor", r.status == "no_tumor")
    check("confidence low", r.confidence == "low")


def test_outcome_serialisable():
    import json
    seg = scene(); stamp_buds(seg, BUD_C, 7)
    out = count_budding(seg, LABEL2ID, MPP).to_outcome()
    json.dumps(out)
    check("primary metric has Bd2", out["primary_metric"]["value"].startswith("Bd2"))
    check("caveats present", len(out["caveats"]) >= 3)
    check("card severity warning (Bd2)", out["card"]["severity"] == "warning")
    check("card has budding row", out["card"]["rows"][0]["label"] == "Tumour budding")


if __name__ == "__main__":
    for fn in [test_bd1, test_bd2, test_bd3, test_far_buds_excluded,
               test_noise_excluded, test_mucosa_side_excluded, test_no_tumor,
               test_outcome_serialisable]:
        print(f"\n=== {fn.__name__} ===")
        fn()
    print("\nAll budding tests passed.")
