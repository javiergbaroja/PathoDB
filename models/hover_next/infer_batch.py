"""
PathoDB — HoVer-Net Next (BATCH MODE)
====================================

Batch wrapper for HoVer-NeXt.

Unlike the earlier "loop over infer.py" approach, HoVer-NeXt's upstream
entry point can run *multiple slides in one invocation*, loading the model
only once:

  /storage/research/igmp_dp_workspace/baumann_elias/hover_next_inference/main.py

This script:
  - reads a PathoDB batch_context.json passed as argv[1]
  - writes a temporary TXT list of slide paths
  - runs HoVer-NeXt in one go on that list (via --input <slides.txt>)
  - tracks per-slide output files to update progress + aggregated result.json

Input (batch_context.json)
--------------------------
Expected keys (same contract as crc_tissue_segmentation/infer_batch.py):

  {
    "job_id": "...",
    "result_dir": "/path/for/progress_and_result_json",
    "output_dir": "/path/for_heavy_outputs",  # optional, defaults to result_dir
    "params": { ... },
    "targets": [
      {"scan_id": 123, "file_path": "/abs/path/to/slide.svs"},
      ...
    ]
  }

Notes / constraints
-------------------
- Current HoVer-NeXt wrapper (infer.py) supports ROI via PATHODB_ROI, but the
  upstream multi-slide mode may not. For now this batch runner ignores per-target
  ROI fields.
- The upstream tool is assumed to write per-slide outputs under OUTPUT_DIR
  in per-slide subfolders, containing a class_inst.json. We watch for those
  files to determine when each slide completes.

Outputs
-------
Written to RESULT_DIR:
  - progress.json  (polled by API)
  - result.json    (aggregated scan results)
  - error.txt      (on fatal failure)

"""

from __future__ import annotations

import glob
import json
import os
import subprocess
import sys
import time
import traceback


# ── PathoDB Batch Context ──────────────────────────────────────────────────────
if len(sys.argv) < 2:
    print("Error: Missing batch_context.json argument.", file=sys.stderr)
    sys.exit(1)

CONTEXT_FILE = sys.argv[1]
with open(CONTEXT_FILE, "r") as f:
    CONTEXT = json.load(f)

JOB_ID = CONTEXT.get("job_id", "unknown")
RESULT_DIR = CONTEXT.get("result_dir", os.getcwd())
OUTPUT_DIR = CONTEXT.get("output_dir", RESULT_DIR)
PARAMS = CONTEXT.get("params", {})
TARGETS = CONTEXT.get("targets", [])  # List of {scan_id, file_path, ...}
MODEL_ID = "hover_next"

os.makedirs(RESULT_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)


# ── HoverNext entry point ──────────────────────────────────────────────────────
PYTHON = sys.executable
HOVERNEXT_MAIN_PY = "/storage/research/igmp_dp_workspace/baumann_elias/hover_next_inference/main.py"


def _atomic_write_json(path: str, payload: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, path)


def update_progress(state: dict, global_pct: int | None = None, global_msg: str | None = None) -> None:
    if global_pct is not None:
        state["pct"] = max(0, min(100, int(global_pct)))
    if global_msg is not None:
        state["message"] = global_msg
        print(f"[{state['pct']:3d}%] {global_msg}", flush=True)

    _atomic_write_json(os.path.join(RESULT_DIR, "progress.json"), state)


def write_result_json(payload: dict) -> None:
    with open(os.path.join(RESULT_DIR, "result.json"), "w") as f:
        json.dump(payload, f, indent=2)


def _slide_expected_class_inst_path(output_dir: str, slide_path: str) -> str:
    """Best-effort: HoVer-NeXt commonly writes <output_root>/<wsi_stem>/class_inst.json."""
    stem = os.path.splitext(os.path.basename(slide_path))[0]
    return os.path.join(output_dir, stem, "class_inst.json")


def _find_latest_class_inst(output_dir: str, slide_path: str) -> str | None:
    """Fallback search if canonical path differs (e.g., extension handling)."""
    stem = os.path.splitext(os.path.basename(slide_path))[0]

    canonical = _slide_expected_class_inst_path(output_dir, slide_path)
    if os.path.exists(canonical):
        return canonical

    hits = glob.glob(os.path.join(output_dir, f"*{stem}*", "class_inst.json"))
    if hits:
        hits.sort(key=os.path.getmtime, reverse=True)
        return hits[0]

    return None


def main() -> None:
    total = len(TARGETS)

    # Live state for progress.json (matches CRC tissue batch structure)
    state = {
        "pct": 0,
        "message": "Initializing batch…",
        "slides": {
            str(t.get("scan_id")): {
                "scan_path": t.get("file_path"),
                "status": "pending",
                "progress": 0,
                "message": "Queued",
            }
            for t in TARGETS
        },
    }

    empty_scan_result = {
        "scan_id": None,
        "scan_path": None,
        "status": None,
        "error": None,
        "timing_s": None,
        "files": {},
        "outcome": None,
        "overlays": None,
    }

    scans: list[dict] = [
        {**empty_scan_result, "scan_id": t.get("scan_id"), "scan_path": t.get("file_path")}
        for t in TARGETS
    ]

    successful = 0
    failed = 0

    if total == 0:
        update_progress(state, 100, "No targets provided. Exiting.")
        write_result_json(
            {
                "model_id": MODEL_ID,
                "scope": "batch",
                "job_id": JOB_ID,
                "job_status": "complete",
                "params": PARAMS,
                "batch_summary": {"total_slides": 0, "successful": 0, "failed": 0},
                "scans": [],
            }
        )
        return

    # write early result.json so API can read it
    final_result: dict = {
        "model_id": MODEL_ID,
        "scope": "batch",
        "job_id": JOB_ID,
        "job_status": "running",
        "params": PARAMS,
        "batch_summary": {"total_slides": total, "successful": successful, "failed": failed},
        "scans": scans,
    }
    write_result_json(final_result)

    print("=== PathoDB HoVer-Net Next (BATCH) ===", flush=True)
    print(f"Context    : {CONTEXT_FILE}", flush=True)
    print(f"Result dir : {RESULT_DIR}", flush=True)
    print(f"Output dir : {OUTPUT_DIR}", flush=True)
    print(f"Targets    : {total} slides", flush=True)

    # Validate inputs and build slide list
    slide_paths: list[str] = []
    bad_idxs: list[int] = []
    for i, t in enumerate(TARGETS):
        p = t.get("file_path")
        if not p or not os.path.isfile(p):
            bad_idxs.append(i)
            continue
        slide_paths.append(p)

    if bad_idxs:
        for i in bad_idxs:
            t = TARGETS[i]
            sid = t.get("scan_id")
            scans[i] = {"scan_id": sid, "scan_path": t.get("file_path"), "status": "failed", "error": "WSI not found on disk"}
            state["slides"][str(sid)]["status"] = "failed"
            state["slides"][str(sid)]["message"] = "WSI not found on disk"
            state["slides"][str(sid)]["progress"] = 0
            failed += 1

        final_result["batch_summary"] = {"total_slides": total, "successful": successful, "failed": failed}
        final_result["scans"] = scans
        write_result_json(final_result)
        update_progress(state)

        if len(slide_paths) == 0:
            final_result["job_status"] = "complete"
            write_result_json(final_result)
            update_progress(state, 100, "Batch complete (no valid slides).")
            return

    # Map scan_id -> index for updates
    scan_id_to_idx = {str(t.get("scan_id")): i for i, t in enumerate(TARGETS)}

    # Write the slide list as a txt file (one path per line)
    slides_txt = os.path.join(RESULT_DIR, f"hover_next_slides_{JOB_ID}.txt")
    with open(slides_txt, "w") as f:
        for p in slide_paths:
            f.write(p)
            f.write("\n")

    # Mark all valid as running
    update_progress(state, 2, "Starting HoVer-NeXt multi-slide inference…")
    for t in TARGETS:
        sid = t.get("scan_id")
        sid_str = str(sid)
        if sid_str not in state["slides"]:
            continue
        if state["slides"][sid_str]["status"] == "failed":
            continue
        state["slides"][sid_str]["status"] = "running"
        state["slides"][sid_str]["progress"] = 1
        state["slides"][sid_str]["message"] = "Running"

    update_progress(state)

    # Build command for upstream tool
    cp = PARAMS.get("cp", "lizard_convnextv2_large")
    tta = str(PARAMS.get("tta", 8))
    pp_tiling = str(PARAMS.get("pp_tiling", 8))
    inf_workers = str(PARAMS.get("inf_workers", 12))
    inf_writers = str(PARAMS.get("inf_writers", 4))

    cmd: list[str] = [
        PYTHON,
        HOVERNEXT_MAIN_PY,
        "--input",
        slides_txt,
        "--output_root",
        OUTPUT_DIR,
        "--cp",
        str(cp),
        "--tta",
        str(tta),
        "--inf_workers",
        str(inf_workers),
        "--inf_writers",
        str(inf_writers),
        "--pp_workers",
        str(inf_workers),
        "--pp_tiling",
        str(pp_tiling),
    ]

    start_time = time.time()

    # Launch inference
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)

    # Poll for output files to drive progress.
    # We treat a slide as complete when we see its class_inst.json.
    done: set[str] = set()
    last_update_t = 0.0

    try:
        while True:
            # update done set
            for t in TARGETS:
                sid = t.get("scan_id")
                sid_str = str(sid)

                if state["slides"].get(sid_str, {}).get("status") in ("failed", "success"):
                    continue

                slide_path = t.get("file_path")
                if not slide_path or not os.path.isfile(slide_path):
                    continue

                class_inst = _find_latest_class_inst(OUTPUT_DIR, slide_path)
                if class_inst and os.path.exists(class_inst):
                    if sid_str not in done:
                        done.add(sid_str)
                        state["slides"][sid_str]["status"] = "success"
                        state["slides"][sid_str]["progress"] = 100
                        state["slides"][sid_str]["message"] = "Inference complete"

                        idx = scan_id_to_idx.get(sid_str)
                        if idx is not None:
                            scans[idx] = {
                                "scan_id": sid,
                                "scan_path": slide_path,
                                "status": "success",
                                "timing_s": None,
                                "files": {
                                    "class_inst": class_inst,
                                },
                                "outcome": None,
                                "overlays": None,
                            }
                        successful += 1

            completed = len(done) + failed
            pct = int(2 + (completed / total) * 96)
            msg = f"Running… ({completed}/{total} completed)"

            now = time.time()
            if now - last_update_t > 2.0:
                update_progress(state, pct, msg)
                final_result["batch_summary"] = {"total_slides": total, "successful": successful, "failed": failed}
                final_result["scans"] = scans
                write_result_json(final_result)
                last_update_t = now

            if completed >= total:
                break

            rc = proc.poll()
            if rc is not None:
                # process ended before we saw all outputs
                break

            time.sleep(1.0)

        stdout, stderr = proc.communicate(timeout=30)
        rc = proc.returncode

        if rc != 0:
            err_path = os.path.join(RESULT_DIR, "error.txt")
            with open(err_path, "w") as f:
                f.write("Command:\n")
                f.write(" ".join(cmd) + "\n\n")
                f.write("--- stdout ---\n")
                f.write(stdout or "")
                f.write("\n--- stderr ---\n")
                f.write(stderr or "")

            # mark remaining pending/running as failed
            for t in TARGETS:
                sid = str(t.get("scan_id"))
                if state["slides"].get(sid, {}).get("status") in ("success", "failed"):
                    continue
                state["slides"][sid]["status"] = "failed"
                state["slides"][sid]["progress"] = 0
                state["slides"][sid]["message"] = "Failed (see error.txt)"

                idx = scan_id_to_idx.get(sid)
                if idx is not None:
                    scans[idx] = {
                        "scan_id": t.get("scan_id"),
                        "scan_path": t.get("file_path"),
                        "status": "failed",
                        "error": f"HoVer-NeXt failed (exit={rc})",
                    }
                failed += 1

            raise RuntimeError(f"HoVer-NeXt batch process failed (exit={rc}). See {err_path}")

        # Success
        _ = round(time.time() - start_time, 2)
        final_result["job_status"] = "complete"
        final_result["batch_summary"] = {"total_slides": total, "successful": successful, "failed": failed}
        final_result["scans"] = scans
        write_result_json(final_result)
        update_progress(state, 100, f"Batch complete. {successful}/{total} successful.")

    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

        tb = traceback.format_exc()
        try:
            with open(os.path.join(RESULT_DIR, "error.txt"), "a") as f:
                f.write("\n\n--- Python exception ---\n")
                f.write(tb)
        except Exception:
            pass

        try:
            _atomic_write_json(
                os.path.join(RESULT_DIR, "progress.json"),
                {"pct": 0, "message": "Fatal batch failure — see error.txt", "slides": state.get("slides", {})},
            )
        except Exception:
            pass

        raise


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
