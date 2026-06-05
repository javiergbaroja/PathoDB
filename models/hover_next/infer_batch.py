"""
PathoDB — HoVer-Net Next (BATCH MODE)
===================================

Batch wrapper for HoVer-NeXt, modelled after the CRC tissue segmentation
batch scripts.

Inputs arrive via a batch_context.json file passed as sys.argv[1].
The expected schema matches PathoDB's batch runner:

  {
    "job_id": "...",
    "result_dir": "/path/for/progress_and_result_json",
    "output_dir": "/path/for_heavy_outputs",   # optional, falls back to result_dir
    "params": { ... model params ... },
    "targets": [
      {"scan_id": 123, "file_path": "/abs/path/to/slide.svs", "roi": <optional>},
      ...
    ]
  }

Outputs written to RESULT_DIR (lightweight API-polled files):
  - progress.json  (live progress)
  - result.json    (aggregated per-slide summary)
  - error.txt      (only on catastrophic failure)

Per-slide heavy outputs are written to OUTPUT_DIR:
  - <wsi>_cells.geojson

"""

from __future__ import annotations

import json
import os
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
TARGETS = CONTEXT.get("targets", [])  # List of {scan_id, file_path, roi?}
MODEL_ID = "hover_next"

os.makedirs(RESULT_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)


def _atomic_write_json(path: str, payload: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, path)


def update_progress(state: dict, global_pct: int | None = None, global_msg: str | None = None) -> None:
    """Write detailed live progress.json atomically."""
    if global_pct is not None:
        state["pct"] = max(0, min(100, int(global_pct)))
    if global_msg is not None:
        state["message"] = global_msg
        print(f"[{state['pct']:3d}%] {global_msg}", flush=True)

    _atomic_write_json(os.path.join(RESULT_DIR, "progress.json"), state)


def write_result_json(final_result: dict) -> None:
    with open(os.path.join(RESULT_DIR, "result.json"), "w") as f:
        json.dump(final_result, f, indent=2)


def main() -> None:
    total_slides = len(TARGETS)

    # 1) Initialize live state
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

    if total_slides == 0:
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

    print(f"=== PathoDB HoVer-Net Next (BATCH) ===")
    print(f"Context    : {CONTEXT_FILE}")
    print(f"Result dir : {RESULT_DIR}")
    print(f"Output dir : {OUTPUT_DIR}")
    print(f"Targets    : {total_slides} slides", flush=True)

    empty_result = {
        "scan_id": None,
        "scan_path": None,
        "status": None,
        "error": None,
        "timing_s": None,
        "files": {},
        "outcome": None,
        "overlays": None,
    }

    batch_results: list[dict] = []
    for t in TARGETS:
        batch_results.append({**empty_result, "scan_id": t.get("scan_id"), "scan_path": t.get("file_path")})

    successful = 0
    failed = 0

    # create result.json early so API can read it even while running
    final_result: dict = {
        "model_id": MODEL_ID,
        "scope": "batch",
        "job_id": JOB_ID,
        "job_status": "running",
        "params": PARAMS,
        "batch_summary": {"total_slides": total_slides, "successful": successful, "failed": failed},
        "scans": batch_results,
    }
    write_result_json(final_result)

    update_progress(state, 1, "Starting batch…")

    # 2) Process each slide by delegating to the existing per-slide wrapper
    #    (models/hover_next/infer.py), using env vars just like run.sh.
    script_dir = os.path.dirname(os.path.abspath(__file__))
    infer_script = os.path.join(script_dir, "infer.py")

    for idx, target in enumerate(TARGETS):
        scan_id = target.get("scan_id")
        scan_id_str = str(scan_id)
        scan_path = target.get("file_path")
        roi = target.get("roi", None)

        wsi_name = os.path.splitext(os.path.basename(scan_path or ""))[0] or f"scan_{scan_id}"

        # leave 1% for init, 1% for finalization
        base_pct = 1 + (idx / total_slides) * 98

        def slide_prog(sub_pct: int, msg: str) -> None:
            global_pct = int(base_pct + (sub_pct / 100.0) * (98 / total_slides))
            state["slides"][scan_id_str]["status"] = "running"
            state["slides"][scan_id_str]["progress"] = int(sub_pct)
            state["slides"][scan_id_str]["message"] = msg
            update_progress(state, global_pct, f"[{idx+1}/{total_slides}] {wsi_name}: {msg}")

        try:
            if not scan_path or not os.path.isfile(scan_path):
                raise FileNotFoundError(f"WSI not found on disk: {scan_path}")

            slide_prog(5, "Launching per-slide inference…")

            env = os.environ.copy()
            env["PATHODB_JOB_ID"] = str(JOB_ID)
            env["PATHODB_SCAN_PATH"] = scan_path
            env["PATHODB_RESULT_DIR"] = OUTPUT_DIR  # heavy outputs should go here
            env["PATHODB_SCOPE"] = "whole_slide"
            env["PATHODB_PARAMS"] = json.dumps(PARAMS)
            env["PATHODB_ROI"] = json.dumps(roi) if roi is not None else "null"

            start = time.time()
            # infer.py handles progress.json/result.json writing for single-slide, but
            # we still keep our own aggregate progress/result for the batch contract.
            # We just run it as a subprocess and then read its result.json.
            import subprocess

            proc = subprocess.run([sys.executable, infer_script], env=env, capture_output=True, text=True)
            if proc.returncode != 0:
                # write stderr to batch RESULT_DIR for visibility
                err_path = os.path.join(RESULT_DIR, f"{wsi_name}_error.txt")
                with open(err_path, "w") as f:
                    f.write(proc.stdout)
                    f.write("\n--- stderr ---\n")
                    f.write(proc.stderr)
                raise RuntimeError(f"Slide inference failed (exit={proc.returncode}). See {err_path}")

            # infer.py writes its own result.json under OUTPUT_DIR
            per_slide_result_path = os.path.join(OUTPUT_DIR, "result.json")
            if not os.path.exists(per_slide_result_path):
                raise FileNotFoundError(
                    f"Expected per-slide result.json not found at {per_slide_result_path}. "
                    "Check hover_next/infer.py output contract."
                )

            with open(per_slide_result_path, "r") as f:
                per_res = json.load(f)

            # Move the GeoJSON next to batch OUTPUT_DIR if needed (infer.py already writes there).
            geojson_path = per_res.get("files", {}).get("download_file")

            batch_results[idx] = {
                "scan_id": scan_id,
                "scan_path": scan_path,
                "status": "success",
                "timing_s": round(time.time() - start, 2),
                "files": {
                    "download_file": geojson_path,
                    "geojson_overlay": geojson_path,
                    "per_slide_result": per_slide_result_path,
                },
                "outcome": per_res.get("outcome"),
                "overlays": per_res.get("overlays"),
            }
            successful += 1

            state["slides"][scan_id_str]["status"] = "success"
            state["slides"][scan_id_str]["progress"] = 100
            state["slides"][scan_id_str]["message"] = "Processed successfully."
            update_progress(state)

            slide_prog(100, "Done")

        except Exception as e:
            tb = traceback.format_exc()
            print(f"\n[ERROR] Slide {wsi_name} failed:\n{tb}", file=sys.stderr)

            batch_results[idx] = {
                "scan_id": scan_id,
                "scan_path": scan_path,
                "status": "failed",
                "error": str(e),
            }
            failed += 1

            state["slides"][scan_id_str]["status"] = "failed"
            state["slides"][scan_id_str]["progress"] = 0
            state["slides"][scan_id_str]["message"] = f"Error: {str(e)}"
            update_progress(state)

        finally:
            final_result = {
                "model_id": MODEL_ID,
                "scope": "batch",
                "job_id": JOB_ID,
                "job_status": "running",
                "params": PARAMS,
                "batch_summary": {"total_slides": total_slides, "successful": successful, "failed": failed},
                "scans": batch_results,
            }
            write_result_json(final_result)

    final_result["job_status"] = "complete"
    write_result_json(final_result)
    update_progress(state, 100, f"Batch complete. {successful}/{total_slides} successful.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        tb = traceback.format_exc()
        try:
            _atomic_write_json(
                os.path.join(RESULT_DIR, "progress.json"),
                {"pct": 0, "message": "Fatal batch failure — see error.txt", "slides": {}},
            )
        except Exception:
            pass

        with open(os.path.join(RESULT_DIR, "error.txt"), "w") as f:
            f.write(tb)
        print(tb, file=sys.stderr)
        sys.exit(1)
