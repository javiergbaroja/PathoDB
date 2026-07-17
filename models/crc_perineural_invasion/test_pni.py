"""
Synthetic unit tests for detect_pni (no GPU / no WSI needed).

Run with the metassist env:
    module load Anaconda3 && source activate metassist
    python models/crc_perineural_invasion/test_pni.py
"""

import cv2
import numpy as np

from pni import detect_pni

LABEL2ID = {"Background": 1, "Stroma": 5, "Tumor": 7, "Nerve": 10}
MPP = 1.0
NERVE, TUMOR, STROMA = LABEL2ID["Nerve"], LABEL2ID["Tumor"], LABEL2ID["Stroma"]


def blank():
    return np.full((600, 600), STROMA, np.int32)


def check(name, cond):
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
    assert cond, name


def test_surrounded():
    # Nerve fully surrounded by a large tumour → PNI present, ~100% encirclement.
    seg = blank()
    cv2.circle(seg, (300, 300), 200, TUMOR, -1)
    cv2.circle(seg, (300, 300),  60, NERVE, -1)
    r = detect_pni(seg, LABEL2ID, MPP)
    print("surrounded ->", r.status, r.confidence, f"{r.max_encirclement_pct:.0f}%",
          f"{r.pni_positive_nerves}/{r.nerves_examined}")
    check("present", r.status == "present")
    check("label 1", r.label == 1)
    check("encirclement > 80%", r.max_encirclement_pct > 80)
    check("confidence high", r.confidence == "high")


def test_half():
    # Tumour on one side → ~50% circumference → present.
    seg = blank()
    seg[:, :300] = TUMOR
    cv2.circle(seg, (300, 300), 60, NERVE, -1)
    r = detect_pni(seg, LABEL2ID, MPP)
    print("half ->", r.status, f"{r.max_encirclement_pct:.0f}%")
    check("present", r.status == "present")
    check("encirclement 35-65%", 35 <= r.max_encirclement_pct <= 65)


def test_negative_far():
    # A nerve and a tumour that don't touch → not identified.
    seg = blank()
    cv2.circle(seg, (150, 150), 60, NERVE, -1)
    cv2.rectangle(seg, (400, 400), (600, 600), TUMOR, -1)
    r = detect_pni(seg, LABEL2ID, MPP)
    print("negative_far ->", r.status, r.confidence,
          f"{r.pni_positive_nerves}/{r.nerves_examined}")
    check("not identified", r.status == "not_identified")
    check("1 nerve examined", r.nerves_examined == 1)
    check("0 positive", r.pni_positive_nerves == 0)


def test_no_nerve():
    seg = blank()
    cv2.circle(seg, (300, 300), 150, TUMOR, -1)
    r = detect_pni(seg, LABEL2ID, MPP)
    print("no_nerve ->", r.status, r.confidence, r.nerves_examined)
    check("not identified", r.status == "not_identified")
    check("0 nerves examined", r.nerves_examined == 0)
    check("confidence low", r.confidence == "low")


def test_two_nerves_one_positive():
    seg = blank()
    cv2.circle(seg, (150, 150), 120, TUMOR, -1)   # nerve A surrounded
    cv2.circle(seg, (150, 150),  50, NERVE, -1)
    cv2.circle(seg, (450, 450),  50, NERVE, -1)   # nerve B bare
    r = detect_pni(seg, LABEL2ID, MPP)
    print("two_nerves ->", r.status, f"{r.pni_positive_nerves}/{r.nerves_examined}")
    check("present", r.status == "present")
    check("2 examined", r.nerves_examined == 2)
    check("1 positive", r.pni_positive_nerves == 1)


def test_intraneural():
    # Nerve ring with tumour inside its central hole → intraneural PNI.
    seg = blank()
    cv2.circle(seg, (300, 300), 180, NERVE, -1)
    cv2.circle(seg, (300, 300), 140, STROMA, -1)   # carve the hole
    cv2.circle(seg, (300, 300), 130, TUMOR, -1)    # tumour inside the nerve
    r = detect_pni(seg, LABEL2ID, MPP)
    print("intraneural ->", r.status, f"{r.pni_positive_nerves}/{r.nerves_examined}")
    check("present", r.status == "present")
    check("1 positive", r.pni_positive_nerves >= 1)


def test_outcome_serialisable():
    import json
    seg = blank()
    cv2.circle(seg, (300, 300), 200, TUMOR, -1)
    cv2.circle(seg, (300, 300),  60, NERVE, -1)
    out = detect_pni(seg, LABEL2ID, MPP).to_outcome()
    json.dumps(out)
    check("primary metric present", out["primary_metric"]["value"] == "Present")
    check("caveats present", len(out["caveats"]) >= 3)
    check("card severity positive", out["card"]["severity"] == "positive")
    check("card has PNI row", out["card"]["rows"][0]["label"] == "Perineural invasion")


if __name__ == "__main__":
    for fn in [test_surrounded, test_half, test_negative_far, test_no_nerve,
               test_two_nerves_one_positive, test_intraneural,
               test_outcome_serialisable]:
        print(f"\n=== {fn.__name__} ===")
        fn()
    print("\nAll PNI tests passed.")
