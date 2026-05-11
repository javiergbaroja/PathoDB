import sys
import os
import json
import time
from pathlib import Path
import psycopg2

def calculate_bbox(coordinates):
    """Calculate bbox_x, bbox_y, bbox_w, bbox_h from GeoJSON polygon coordinates"""
    # Assuming standard GeoJSON Polygon: [[[x1, y1], [x2, y2], ...]]
    if not coordinates or not coordinates[0]:
        return 0, 0, 0, 0
    
    xs = [pt[0] for pt in coordinates[0]]
    ys = [pt[1] for pt in coordinates[0]]
    
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    
    return min_x, min_y, (max_x - min_x), (max_y - min_y)

def main():
    if len(sys.argv) < 3:
        sys.exit(1)

    watch_dir = Path(sys.argv[1])
    context_path = Path(sys.argv[2])
    
    with open(context_path, "r") as f:
        context = json.load(f)
        
    params = context.get("params", {})
    class_mapping = params.get("class_mapping")
    project_id = params.get("project_id") # <-- Grab the project ID
    
    if not project_id:
        print("Error: No project_id provided in context. Cannot insert into database.")
        sys.exit(1)

    processed_files = set()
    db_user = os.getenv("POSTGRES_USER")
    db_pass = os.getenv("POSTGRES_PASSWORD")
    db_host = os.getenv("POSTGRES_HOST", "localhost") 
    db_port = os.getenv("POSTGRES_PORT", "5432")
    db_name = os.getenv("POSTGRES_DB")

    conn_str = f"postgresql://{db_user}:{db_pass}@{db_host}:{db_port}/{db_name}"
    
    # Connect to database
    conn = psycopg2.connect(conn_str)

    while True:
        new_files = set(watch_dir.glob("*.geojson")) - processed_files

        for file_path in new_files:
            try:
                with open(file_path, "r") as f:
                    data = json.load(f)

                scan_id = int(file_path.stem.split("_")[-1]) 
                cursor = conn.cursor()
                
                for feature in data.get("features", []):
                    pred_class = feature["properties"]["classification"]["name"]
                    final_class = pred_class

                    if class_mapping:
                        mapped_val = class_mapping.get(pred_class)
                        if mapped_val == "IGNORE":
                            continue
                        elif mapped_val:
                            final_class = mapped_val

                    # Get GeoJSON geometry
                    geom = feature["geometry"]
                    
                    # Calculate bbox for PathoDB schema
                    bx, by, bw, bh = calculate_bbox(geom.get("coordinates"))

                    # EXACT MATCH for your Schema (Raw JSONB, no PostGIS, requires project_id)
                    cursor.execute(
                        """
                        INSERT INTO annotations 
                        (project_id, scan_id, class_name, annotation_type, bbox_x, bbox_y, bbox_w, bbox_h, geometry) 
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                        """, 
                        (
                            project_id, 
                            scan_id, 
                            final_class, 
                            'polygon',  # Fulfills CHECK constraint
                            bx, by, bw, bh, 
                            json.dumps(geom)
                        )
                    )
                
                conn.commit()
                processed_files.add(file_path)

            except Exception as e:
                print(f"Error processing {file_path.name}: {e}")
                conn.rollback()

        if (watch_dir / "result.json").exists() and len(processed_files) == len(set(watch_dir.glob("*.geojson"))):
            break
        time.sleep(3)
        
    conn.close()

if __name__ == "__main__":
    main()