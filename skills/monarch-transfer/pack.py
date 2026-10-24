"""monarch-transfer – print files from /workspace/output as checksummed MONARCH-FILE lines that monarch writes into the repo."""

# --------- IMPORTS ---------
import argparse
import base64
import gzip
import hashlib
import traceback
from pathlib import Path

# --------- STATIC ---------
junk_parts = {"__pycache__", ".git"}
line_reserve = 200

# --------- CONFIG ---------
app_name = "monarch-transfer"
app_version = "0.1"
output_dir = Path("/workspace/output")
max_chars = 30000
lines_per_batch = 4


# --------- FUNC ---------
def b64url(data: bytes) -> str:
    # urlsafe alphabet without padding: awork stores tool results JSON-escaped and would escape "+" (\u002B)
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


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


def file_lines(root: Path, path: Path, size: int) -> list[str]:
    """MONARCH-FILE lines of one file: gzip, base64url, split into parts of size chars; sha256 of the original bytes."""
    data = path.read_bytes()
    packed = b64url(gzip.compress(data, mtime=0))
    chunks = [packed[index:index + size] for index in range(0, len(packed), size)] or [""]
    head = f"MONARCH-FILE v1 path={b64url(path.relative_to(root).as_posix().encode('utf-8'))} sha256={hashlib.sha256(data).hexdigest()}"
    return [f"{head} part={number}of{len(chunks)} data={chunk}" for number, chunk in enumerate(chunks, 1)]


def split_batches(lines: list[str], limit: int) -> list[list[str]]:
    """Group lines into batches of at most limit chars (one tool result each)."""
    batches, size = [[]], 0
    for line in lines:
        if batches[-1] and size + len(line) + 1 > limit:
            batches.append([])
            size = 0
        batches[-1].append(line)
        size += len(line) + 1
    return batches


# --------- MAIN ---------
def main():
    parser = argparse.ArgumentParser(prog=app_name, description="Print output files as MONARCH-FILE lines for monarch.")
    parser.add_argument("paths", nargs="*", help="files below the output folder that you created or changed")
    parser.add_argument("--all", action="store_true", help="send every file of the output folder")
    parser.add_argument("--batch", type=int, default=1, help="batch to print (1 = first)")
    parser.add_argument("--max-chars", type=int, default=max_chars, help="max. chars per batch (one tool result)")
    parser.add_argument("--root", type=Path, default=output_dir, help="output folder")
    args = parser.parse_args()
    if args.max_chars < 2 * lines_per_batch * line_reserve:
        raise SystemExit(f"{app_name}: --max-chars must be at least {2 * lines_per_batch * line_reserve}.")
    root = args.root.resolve()
    files = select_files(root, args.paths, args.all)
    if not files:
        raise SystemExit(f"{app_name}: no files to send in {root}.")
    size = args.max_chars // lines_per_batch - line_reserve
    batches = split_batches([line for path in files for line in file_lines(root, path, size)], args.max_chars)
    if not 1 <= args.batch <= len(batches):
        raise SystemExit(f"{app_name}: --batch must be between 1 and {len(batches)}.")
    print("\n".join(batches[args.batch - 1]))
    next_hint = f"; next: run again with --batch {args.batch + 1}" if args.batch < len(batches) else "; done"
    print(f"MONARCH-BATCH {args.batch} of {len(batches)} ({len(files)} files: {', '.join(path.relative_to(root).as_posix() for path in files)}){next_hint}")


# --------- EXEC ---------
if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Unhandled error in main: {exc}")
        print(traceback.format_exc())
