#!/usr/bin/env python3
"""Resumable parallel download of the large kaikki English JSONL source."""

import argparse
import concurrent.futures
import os
import time
import urllib.request
from pathlib import Path

URL = "https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl"
TOTAL_SIZE = 3431211190


def download_part(url, path, start, end, index):
    expected = end - start + 1
    existing = path.stat().st_size if path.exists() else 0
    if existing > expected:
        raise RuntimeError(f"Part {index} is larger than expected")
    while existing < expected:
        request = urllib.request.Request(url, headers={"Range": f"bytes={start + existing}-{end}", "User-Agent": "YingshiDictionaryBuilder/0.2"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                if response.status != 206:
                    raise RuntimeError(f"Server did not honor range request: HTTP {response.status}")
                with path.open("ab") as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        output.write(chunk)
                        existing += len(chunk)
        except Exception:
            if path.exists() and path.stat().st_size >= expected:
                break
            raise
        print(f"Part {index + 1}: {existing / 1048576:.0f}/{expected / 1048576:.0f} MiB", flush=True)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / ".cache" / "kaikki-english.jsonl")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    parts_dir = args.output.parent / "kaikki-parts"
    parts_dir.mkdir(exist_ok=True)
    if args.output.exists() and args.output.stat().st_size < TOTAL_SIZE:
        first = parts_dir / "part000"
        if not first.exists():
            args.output.rename(first)
    chunk_size = (TOTAL_SIZE + args.workers - 1) // args.workers
    jobs = []
    for index in range(args.workers):
        start = index * chunk_size
        end = min(TOTAL_SIZE - 1, start + chunk_size - 1)
        jobs.append((parts_dir / f"part{index:03d}", start, end, index))
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(download_part, URL, *job) for job in jobs]
        for future in concurrent.futures.as_completed(futures):
            future.result()
    with args.output.open("wb") as output:
        for path, _, _, _ in jobs:
            with path.open("rb") as source:
                while True:
                    chunk = source.read(8 * 1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
    if args.output.stat().st_size != TOTAL_SIZE:
        raise RuntimeError("Combined file size does not match the published source size")
    for path, _, _, _ in jobs:
        path.unlink()
    parts_dir.rmdir()
    print(f"Download complete: {TOTAL_SIZE / 1073741824:.2f} GiB in {(time.monotonic()-started)/60:.1f} minutes", flush=True)


if __name__ == "__main__":
    main()
