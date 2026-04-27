#!/usr/bin/env python3
"""
PathoDB — Create first admin user.
Run once interactively after the API is deployed.

Usage:
    cd /path/to/pathodb
    python create_admin.py
"""
import os
import sys
from getpass import getpass
from dotenv import load_dotenv

load_dotenv()

db_url = os.getenv("DATABASE_URL")
if not db_url:
    print("ERROR: DATABASE_URL not set in .env")
    sys.exit(1)

import bcrypt
import psycopg2

print("=== PathoDB — Create Admin User ===")
username = input("Username: ").strip()
email    = input("Email: ").strip()
password = getpass("Password: ")
confirm  = getpass("Confirm password: ")

if password != confirm:
    print("ERROR: Passwords do not match.")
    sys.exit(1)

if len(password) < 8:
    print("ERROR: Password must be at least 8 characters.")
    sys.exit(1)

password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

conn = psycopg2.connect(db_url)
cur  = conn.cursor()

cur.execute("SELECT id FROM users WHERE username = %s", (username,))
if cur.fetchone():
    print(f"ERROR: Username '{username}' already exists.")
    cur.close()
    conn.close()
    sys.exit(1)

cur.execute(
    """
    INSERT INTO users (username, email, password_hash, role, is_active)
    VALUES (%s, %s, %s, 'admin', TRUE)
    """,
    (username, email, password_hash),
)
conn.commit()
cur.close()
conn.close()

print(f"\nAdmin user '{username}' created successfully.")
print("You can now start the API and log in.")