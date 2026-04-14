#!/usr/bin/env python3
"""
Circa listings sync.

Reads the Google Sheet, walks the Drive parent folder, fuzzy-matches each
property row to a Drive subfolder by name, collects image URLs, and writes
./listings.json at the repo root.

Auth: reuses ~/.claude/credentials/gdrive_credentials.pickle (Drive + Sheets).
Run: python3 scripts/sync_listings.py
"""
import io
import json
import pickle
import re
import shutil
import sys
from difflib import SequenceMatcher
from pathlib import Path

from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

SHEET_ID = "17nryG-WPTeSxC1n2XiPuRZ1h2CByXUQPlttul35P6Ck"
SHEET_RANGE = "Sheet1!A1:Z200"
PARENT_FOLDER_ID = "1Hi-vv5ief_z_1MwQBsn8QTk1H5ryp9ZI"
PICKLE = Path.home() / ".claude/credentials/gdrive_credentials.pickle"
REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "listings.json"
IMG_DIR = REPO / "images" / "listings"

IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


GENERIC_TOKENS = {"villa", "casa", "blue", "condo", "duplex", "the", "de", "del"}


def tokens(s: str) -> set:
    return {w for w in re.split(r"[^a-z0-9]+", (s or "").lower()) if w}


def pair_score(name: str, folder_name: str) -> float:
    """Score a (sheet-row-name, drive-folder-name) pair. 0..1.
    Requires at least one non-generic token overlap to count."""
    a, b = norm(name), norm(folder_name)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    ta, tb = tokens(name), tokens(folder_name)
    # specific (non-generic) overlap required
    specific_overlap = (ta & tb) - GENERIC_TOKENS
    if not specific_overlap:
        return 0.0
    ratio = SequenceMatcher(None, a, b).ratio()
    contain = 1.0 if (a in b or b in a) else 0.0
    return max(contain * 0.9, ratio)


def assign_folders(rows: list[dict], folders: list[dict], threshold: float = 0.72):
    """Greedy one-to-one assignment: best scores first; each folder used at most once."""
    pairs = []
    for i, r in enumerate(rows):
        for f in folders:
            s = pair_score(r["name"], f["name"])
            if s >= threshold:
                pairs.append((s, i, f))
    pairs.sort(key=lambda x: -x[0])
    assigned = {}  # row_index -> (folder, score)
    used = set()
    for s, i, f in pairs:
        if i in assigned or f["id"] in used:
            continue
        assigned[i] = (f, s)
        used.add(f["id"])
    return assigned


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


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def ext_for(mime: str) -> str:
    return {
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
        "image/heic": "heic", "image/heif": "heif",
    }.get(mime, "jpg")


def download_image(svc, file_id: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True  # cache
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        req = svc.files().get_media(fileId=file_id)
        buf = io.FileIO(dest, "wb")
        downloader = MediaIoBaseDownload(buf, req)
        done = False
        while not done:
            _, done = downloader.next_chunk()
        buf.close()
        return True
    except Exception as e:
        if dest.exists():
            try:
                dest.unlink()
            except Exception:
                pass
        print(f"  ! download failed {file_id}: {e}")
        return False


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

    # 3) Explicit name_map.json is the only source of truth. No fuzzy matching.
    overrides_path = Path(__file__).resolve().parent / "name_map.json"
    overrides = json.loads(overrides_path.read_text()) if overrides_path.exists() else {}
    by_folder_norm = {norm(f["name"]): f for f in folders}
    used_folder_ids = set()
    assigned = {}
    for i, r in enumerate(rows):
        # 1) Exact name match first (normalized)
        folder = by_folder_norm.get(norm(r["name"]))
        if folder and folder["id"] not in used_folder_ids:
            assigned[i] = (folder, 1.0)
            used_folder_ids.add(folder["id"])
            continue
        # 2) Override map
        folder_name = overrides.get(r["name"])
        if folder_name:
            folder = by_folder_norm.get(norm(folder_name))
            if folder and folder["id"] not in used_folder_ids:
                assigned[i] = (folder, 1.0)
                used_folder_ids.add(folder["id"])
            elif not folder:
                print(f"  ! override folder not found: {r['name']!r} -> {folder_name!r}")

    # 4) Collect images for each assigned folder
    properties = []
    matched = 0
    unmatched = []
    empty_folders = []
    for i, row in enumerate(rows):
        images = []
        match_info = None
        if i in assigned:
            folder, score = assigned[i]
            imgs = list_images(drive, folder["id"])
            if not imgs:
                empty_folders.append((row["name"], folder["name"]))
            slug = slugify(row["name"]) or folder["id"]
            for idx, f in enumerate(imgs):
                ext = ext_for(f["mimeType"])
                fname = f"{idx:02d}-{f['id']}.{ext}"
                local = IMG_DIR / slug / fname
                ok = download_image(drive, f["id"], local)
                if not ok:
                    continue
                rel = f"images/listings/{slug}/{fname}"
                images.append({
                    "id": f["id"],
                    "name": f["name"],
                    "url": rel,
                    "thumb": rel,
                })
            match_info = {"folder_name": folder["name"], "folder_id": folder["id"], "score": round(score, 2)}
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
