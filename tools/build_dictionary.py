#!/usr/bin/env python3
"""Build static English dictionary shards from Wiktionary-derived data.

Runtime application code never calls the upstream API. Run this script locally
when you want to refresh or expand the bundled data set.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

API_URL = "https://freedictionaryapi.com/api/v1/entries/en/{}"
SOURCE_NAME = "English Wiktionary via FreeDictionaryAPI.com"
SOURCE_URL = "https://freedictionaryapi.com/"
LICENSE_NAME = "Creative Commons Attribution-ShareAlike 4.0 International"
LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"
VALID_WORD = re.compile(r"^[a-z]+(?:[ -][a-z]+)*$")


def read_words(path):
    words = []
    seen = set()
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip().lower()
        line = re.sub(r"\s+", " ", line)
        line = re.sub(r"-{2,}", "-", line)
        if not line:
            continue
        if not VALID_WORD.fullmatch(line):
            print(f"Skipping invalid entry: {line}", file=sys.stderr)
            continue
        if line not in seen:
            seen.add(line)
            words.append(line)
    return words


def fetch_word(word, timeout, retries):
    url = API_URL.format(urllib.parse.quote(word, safe=""))
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "YingshiSuixincha-DictionaryBuilder/0.1",
        },
    )
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if attempt >= retries:
                raise
            retry_after = error.headers.get("Retry-After")
            wait = float(retry_after) if retry_after else 1.5 * (attempt + 1)
            time.sleep(min(wait, 5.0))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt >= retries:
                raise
            time.sleep(1.5 * (attempt + 1))
    return None


def normalize_entry(payload, requested_word, max_senses):
    if not isinstance(payload, dict):
        return None

    phonetic = ""
    meanings = {}
    for item in payload.get("entries", []):
        if item.get("language", {}).get("code") != "en":
            continue
        if not phonetic:
            for pronunciation in item.get("pronunciations", []):
                text = pronunciation.get("text", "").strip()
                if text:
                    phonetic = text
                    break
        pos = item.get("partOfSpeech", "entry").strip() or "entry"
        bucket = meanings.setdefault(pos, [])
        for sense in item.get("senses", []):
            definition = sense.get("definition", "").strip()
            if not definition:
                continue
            examples = sense.get("examples") or []
            normalized = {"t": definition}
            if examples and isinstance(examples[0], str) and examples[0].strip():
                normalized["e"] = examples[0].strip()
            if not any(existing["t"] == definition for existing in bucket):
                bucket.append(normalized)
            if len(bucket) >= max_senses:
                break

    compact_meanings = [
        {"pos": pos, "d": definitions}
        for pos, definitions in meanings.items()
        if definitions
    ]
    if not compact_meanings:
        return None

    source = payload.get("source") or {}
    source_url = source.get("url") or (
        "https://en.wiktionary.org/wiki/"
        + urllib.parse.quote(requested_word.replace(" ", "_"))
    )
    return {
        "w": payload.get("word", requested_word).lower(),
        "p": phonetic,
        "m": compact_meanings,
        "u": source_url,
    }


def write_json(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def main():
    script_dir = Path(__file__).resolve().parent
    project_dir = script_dir.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--words", type=Path, default=script_dir / "words.txt")
    parser.add_argument("--output", type=Path, default=project_dir / "data")
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--max-senses", type=int, default=12)
    args = parser.parse_args()

    words = read_words(args.words)
    if args.limit > 0:
        words = words[: args.limit]
    args.output.mkdir(parents=True, exist_ok=True)

    shards = {letter: [] for letter in "abcdefghijklmnopqrstuvwxyz"}
    missing = []
    failed = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        future_words = {
            executor.submit(fetch_word, word, args.timeout, args.retries): word
            for word in words
        }
        for index, future in enumerate(as_completed(future_words), start=1):
            word = future_words[future]
            try:
                payload = future.result()
                if payload is None:
                    missing.append(word)
                else:
                    entry = normalize_entry(payload, word, args.max_senses)
                    if entry is None:
                        missing.append(word)
                    else:
                        shards[word[0]].append(entry)
            except Exception as error:
                failed.append({"word": word, "error": str(error)})
                print(f"ERROR {word}: {error}", file=sys.stderr, flush=True)
            if index % 25 == 0 or index == len(words):
                print(f"Processed {index}/{len(words)}", flush=True)

    counts = {}
    total = 0
    for letter, entries in shards.items():
        entries.sort(key=lambda item: item["w"])
        write_json(args.output / f"{letter}.json", entries)
        counts[letter] = len(entries)
        total += len(entries)

    flat_entries = [entry for entries in shards.values() for entry in entries]
    meta = {
        "name": "英释随心查",
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "totalEntries": total,
        "singleWords": sum(" " not in item["w"] and "-" not in item["w"] for item in flat_entries),
        "hyphenatedEntries": sum("-" in item["w"] for item in flat_entries),
        "phrases": sum(" " in item["w"] for item in flat_entries),
        "counts": counts,
        "source": {
            "name": SOURCE_NAME,
            "url": SOURCE_URL,
            "license": LICENSE_NAME,
            "licenseUrl": LICENSE_URL,
        },
    }
    write_json(args.output / "meta.json", meta)
    write_json(
        args.output / "build-report.json",
        {"requested": len(words), "included": total, "missing": missing, "failed": failed},
    )
    print(
        f"Built {total} entries: {meta['singleWords']} words, "
        f"{meta['hyphenatedEntries']} hyphenated, {meta['phrases']} phrases."
    )
    print(f"Missing: {len(missing)}; failed: {len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
