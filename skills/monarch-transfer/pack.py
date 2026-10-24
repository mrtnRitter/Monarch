"""monarch-transfer – pack files from /workspace/output into one checksummed bundle that monarch fetches from an awork task."""

# --------- IMPORTS ---------
import argparse
import base64
import gzip
import hashlib
import json
import re
import traceback
from datetime import datetime, timezone
from pathlib import Path

# --------- STATIC ---------
junk_parts = {"__pycache__", ".git"}
session_pattern = re.compile(r"^-\s*sessionId:\s*([0-9a-fA-F-]{36})\s*$", re.MULTILINE)

# --------- CONFIG ---------
app_name = "monarch-transfer"
app_version = "0.2"
output_dir = Path("/workspace/output")
bundle_dir = Path("/workspace/scratch/monarch-transfer")
index_file = Path("/workspace/context/index.md")


# --------- FUNC ---------
def read_thread(index: Path) -> str:
    """Id of the current chat (sessionId in the context index); monarch only takes bundles of its own chat."""
    match = session_pattern.search(index.read_text(encoding="utf-8")) if index.is_file() else None
    if not match:
        raise SystemExit(f"{app_name}: no sessionId in {index}. Pass the chat id with --thread.")
    return match.group(1).lower()


def select_files(root: Path, names: list[str], take_all: bool) -> list[Path]:
    """Files to send: the given paths (relative to root or absolute below it) or all files; caches are skipped."""
    if not root.is_dir():
        raise SystemExit(f"{app_name}: {root} not found. Save the files there first.")
    if not names and not take_all:
        raise SystemExit(f"{app_name}: name the files you created or changed (paths below {root}) or use --all.")
    candidates = sorted(path for path in root.rglob("*") if path.is_file()) if take_all else []
    for name in names:
        path = (Path(name) if Path(name).is_absolute() else root / name.removeprefix("output/")).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise SystemExit(f"{app_name}: {name} is not a file below {root}.")
        candidates.append(path)
    return [path for path in dict.fromkeys(candidates) if path.suffix != ".pyc" and not junk_parts & set(path.relative_to(root).parts)]


def build_bundle(root: Path, files: list[Path], thread: str) -> bytes:
    """gzip JSON {format, version, thread, created, files: [{path, sha256, size, data (base64)}]}."""
    items = []
    for path in files:
        data = path.read_bytes()
        items.append({"path": path.relative_to(root).as_posix(), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "data": base64.b64encode(data).decode("ascii")})
    bundle = {"format": "monarch-bundle", "version": 1, "thread": thread, "created": datetime.now(timezone.utc).isoformat(), "files": items}
    return gzip.compress(json.dumps(bundle).encode("utf-8"), mtime=0)


# --------- MAIN ---------
def main():
    parser = argparse.ArgumentParser(prog=app_name, description="Pack output files into one bundle for monarch.")
    parser.add_argument("paths", nargs="*", help="files below the output folder that you created or changed")
    parser.add_argument("--all", action="store_true", help="send every file of the output folder")
    parser.add_argument("--thread", help="chat id (default: sessionId from the context index)")
    parser.add_argument("--root", type=Path, default=output_dir, help="output folder")
    parser.add_argument("--out-dir", type=Path, default=bundle_dir, help="folder for the bundle")
    args = parser.parse_args()
    root = args.root.resolve()
    files = select_files(root, args.paths, args.all)
    if not files:
        raise SystemExit(f"{app_name}: no files to send in {root}.")
    thread = (args.thread or read_thread(index_file)).lower()
    now = datetime.now(timezone.utc)
    target = args.out_dir / f"monarch_{thread}_{now:%Y%m%dT%H%M%S}{now.microsecond // 1000:03d}Z.json.gz"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(build_bundle(root, files, thread))
    print(f"bundle: {target}")
    print(f"files ({len(files)}): {', '.join(path.relative_to(root).as_posix() for path in files)}")


# --------- EXEC ---------
if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Unhandled error in main: {exc}")
        print(traceback.format_exc())
