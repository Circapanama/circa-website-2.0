#!/usr/bin/env python3
"""
Circa listings sync.

Reads the Google Sheet, walks the Drive parent folder, fuzzy-matches each
property row to a Drive subfolder by name, collects image URLs, and writes
./listings.json at the repo root.

Auth: reuses ~/.claude/credentials/gdrive_credentials.pickle (Drive + Sheets).
Run: python3 scripts/sync_listings.py
"""
import json
import pickle
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

from googleapiclient.discovery import build

SHEET_ID = "17nryG-WPTeSxC1n2XiPuRZ1h2CByXUQPlttul35P6Ck"
SHEET_RANGE = "Sheet1!A1:Z200"
PARENT_FOLDER_ID = "1Hi-vv5ief_z_1MwQBsn8QTk1H5ryp9ZI"
PICKLE = Path.home() / ".claude/credentials/gdrive_credentials.pickle"
OUT = Path(__file__).resolve().parent.parent / "listings.json"

IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def best_match(name: str, folders: list[dict], threshold: float = 0.55):
    t = norm(name)
    if not t:
        return None, 0.0
    best = (None, 0.0)
    for f in folders:
        f_norm = norm(f["name"])
        # exact / containment boost
        if t == f_norm:
            return f, 1.0
        contain = 1.0 if (t in f_norm or f_norm in t) else 0.0
        ratio = SequenceMatcher(None, t, f_norm).ratio()
        score = max(contain * 0.9, ratio)
        if score > best[1]:
            best = (f, score)
    return best if best[1] >= threshold else (None, best[1])


def walk_folders(svc, parent_id: str) -> list[dict]:
    """Return all subfolders recursively (flat list)."""
    out = []
    queue = [parent_id]
    while queue:
        pid = queue.pop()
        page_token = None
        while True:
            res = svc.files().list(
                q=f"'{pid}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
                fields="nextPageToken, files(id,name)",
                pageSize=200,
                pageToken=page_token,
            ).execute()
            for f in res.get("files", []):
                out.append(f)
                queue.append(f["id"])
            page_token = res.get("nextPageToken")
            if not page_token:
                break
    return out


def list_images(svc, folder_id: str) -> list[dict]:
    """Return image files directly in a folder (not recursive)."""
    res = svc.files().list(
        q=f"'{folder_id}' in parents and trashed=false",
        fields="files(id,name,mimeType)",
        pageSize=200,
        orderBy="name",
    ).execute()
    files = [f for f in res.get("files", []) if f["mimeType"] in IMAGE_MIMES]
    return files


def parse_sheet_rows(values: list[list[str]]) -> list[dict]:
    """The sheet has an empty row at top; header is row 2 (index 1)."""
    # find header row: the one with 'Property Project Name' or 'Location'
    header_idx = None
    for i, row in enumerate(values[:5]):
        joined = " ".join(row).lower()
        if "property" in joined and "location" in joined:
            header_idx = i
            break
    if header_idx is None:
        header_idx = 1  # fallback

    rows = []
    for r in values[header_idx + 1:]:
        if not r or not r[0] or not r[0].strip():
            continue
        def g(i):
            return r[i].strip() if i < len(r) and r[i] else ""
        name = g(0)
        if not name or name.lower().startswith("property"):
            continue
        rows.append({
            "name": name,
            "location": g(1),
            "category": g(2),
            "lot_size": g(3),
            "construction_size": g(4),
            "price_per_sqm": g(5),
            "price": g(6),
            "bedrooms": g(7),
            "bathrooms": g(8),
            "parking": g(9),
            "amenities": g(10),
            "owner": g(11),
            "contact": g(12),
            "drive_link": g(13),
            "status": g(14),
            "legal_docs": g(15),
            "notes": g(16),
        })
    return rows


def main():
    with open(PICKLE, "rb") as f:
        creds = pickle.load(f)

    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)

    # 1) Sheet
    sh = sheets.spreadsheets().values().get(spreadsheetId=SHEET_ID, range=SHEET_RANGE).execute()
    rows = parse_sheet_rows(sh.get("values", []))
    print(f"Sheet rows: {len(rows)}")

    # 2) Drive folders
    folders = walk_folders(drive, PARENT_FOLDER_ID)
    print(f"Drive subfolders (recursive): {len(folders)}")

    # 3) Match + collect images
    properties = []
    matched = 0
    unmatched = []
    empty_folders = []
    for row in rows:
        match, score = best_match(row["name"], folders)
        images = []
        match_info = None
        if match:
            imgs = list_images(drive, match["id"])
            if not imgs:
                empty_folders.append((row["name"], match["name"]))
            for f in imgs:
                images.append({
                    "id": f["id"],
                    "name": f["name"],
                    "url": f"https://lh3.googleusercontent.com/d/{f['id']}=w1200",
                    "thumb": f"https://lh3.googleusercontent.com/d/{f['id']}=w600",
                })
            match_info = {"folder_name": match["name"], "folder_id": match["id"], "score": round(score, 2)}
            matched += 1
        else:
            unmatched.append(row["name"])
        properties.append({**row, "images": images, "match": match_info})

    used_folder_ids = {p["match"]["folder_id"] for p in properties if p["match"]}
    unused_folders = [f["name"] for f in folders if f["id"] not in used_folder_ids]

    # Only publish properties that matched a Drive folder AND have at least one image
    published = [p for p in properties if p.get("match") and p.get("images")]

    out = {
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "count": len(published),
        "properties": published,
        "report": {
            "matched": matched,
            "unmatched_sheet_rows": unmatched,
            "unmatched_drive_folders": unused_folders,
            "matched_but_empty_folders": empty_folders,
        },
    }
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(f"\nWrote {OUT}")
    print(f"  matched: {matched}/{len(rows)}")
    print(f"  unmatched sheet rows: {len(unmatched)}")
    if unmatched:
        for n in unmatched:
            print(f"    - {n}")
    print(f"  unmatched drive folders: {len(unused_folders)}")
    if unused_folders:
        for n in unused_folders:
            print(f"    - {n}")
    if empty_folders:
        print(f"  matched but empty: {len(empty_folders)}")
        for sheet_name, folder_name in empty_folders:
            print(f"    - {sheet_name} → {folder_name}")


if __name__ == "__main__":
    main()
