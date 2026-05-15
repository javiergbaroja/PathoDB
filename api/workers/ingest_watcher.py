import sys
import os
import json
import time
from pathlib import Path
import psycopg2
from psycopg2.extras import execute_values  # <-- Required for bulk inserts

def calculate_bbox(coordinates):
    """Calculate bbox_x, bbox_y, bbox_w, bbox_h from GeoJSON polygon coordinates"""
    if not coordinates or not coordinates[0]:
        return 0, 0, 0, 0
    
    xs = [pt[0] for pt in coordinates[0]]
    ys = [pt[1] for pt in coordinates[0]]
    
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    
    return min_x, min_y, (max_x - min_x), (max_y - min_y)

def main():
    if len(sys.argv) < 3:
        print("Usage: python ingest_watcher.py <watch_dir> <context_file>", flush=True)
        sys.exit(1)

    watch_dir = Path(sys.argv[1])
    context_path = Path(sys.argv[2])
    
    with open(context_path, "r") as f:
        context = json.load(f)
        
    params = context.get("params", {})
    class_mapping = params.get("class_mapping")
    project_id = params.get("project_id")
    
    if not project_id:
        print("Error: No project_id provided in context. Cannot insert.", flush=True)
        sys.exit(1)

    processed_files = set()
    failed_files = set()

    db_user = os.getenv("POSTGRES_USER")
    db_pass = os.getenv("POSTGRES_PASSWORD")
    db_host = os.getenv("POSTGRES_HOST", "localhost")
    db_port = os.getenv("POSTGRES_PORT", os.getenv("PGPORT", "5432"))
    db_name = os.getenv("POSTGRES_DB")

    conn_str = f"postgresql://{db_user}:{db_pass}@{db_host}:{db_port}/{db_name}"
    
    print(f"Connecting to database at {db_host}:{db_port}...", flush=True)
    conn = psycopg2.connect(conn_str)
    print("Connected successfully. Starting watch loop...", flush=True)

    while True:
        job_complete = False
        scan_map = {}
        result_file = watch_dir / "result.json"
        
        if result_file.exists():
            try:
                with open(result_file, "r") as rf:
                    res_data = json.load(rf)
                    
                    if res_data.get("job_status") == "complete":
                        job_complete = True
                        
                    for scan in res_data.get("scans", []):
                        if scan and scan.get("scan_path") and scan.get("scan_id"):
                            stem = Path(scan["scan_path"]).stem
                            scan_map[stem] = scan["scan_id"]
                            
            except json.JSONDecodeError:
                pass

        current_geojsons = set(watch_dir.glob("*.geojson"))
        new_files = current_geojsons - processed_files - failed_files

        for file_path in new_files:
            stem = file_path.stem
            scan_id = scan_map.get(stem)
            
            if not scan_id:
                continue

            try:
                print(f"Loading {file_path.name} from disk...", flush=True)
                with open(file_path, "r") as f:
                    data = json.load(f)

                cursor = conn.cursor()
                features = data.get("features", [])
                
                # --- BULK INSERT BATCHING ---
                insert_records = []
                
                for feature in features:
                    pred_class = feature["properties"]["classification"]["name"]
                    final_class = pred_class

                    if class_mapping:
                        mapped_val = class_mapping.get(pred_class)
                        if mapped_val == "IGNORE":
                            continue
                        elif mapped_val:
                            final_class = mapped_val

                    geom = feature["geometry"]
                    bx, by, bw, bh = calculate_bbox(geom.get("coordinates"))

                    # Add to our batch list instead of querying immediately
                    insert_records.append((
                        project_id, scan_id, final_class, 'polygon', bx, by, bw, bh, json.dumps(geom)
                    ))

                if insert_records:
                    print(f"Bulk inserting {len(insert_records)} polygons for scan {scan_id}...", flush=True)
                    execute_values(
                        cursor,
                        """
                        INSERT INTO annotations 
                        (project_id, scan_id, class_name, annotation_type, bbox_x, bbox_y, bbox_w, bbox_h, geometry) 
                        VALUES %s
                        """,
                        insert_records
                    )
                
                conn.commit()
                processed_files.add(file_path)
                print(f"Successfully committed {stem} to the database.", flush=True)

            except Exception as e:
                print(f"Error processing {file_path.name}: {e}", flush=True)
                conn.rollback()
                failed_files.add(file_path)

        if job_complete and len(processed_files) + len(failed_files) == len(current_geojsons):
            print("Upstream job complete and all files processed. Exiting.", flush=True)
            break
            
        time.sleep(60)
        print("\tChecking for new files...", flush=True)
        
    conn.close()

if __name__ == "__main__":
    main()