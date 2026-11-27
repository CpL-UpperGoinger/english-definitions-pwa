#!/usr/bin/env python3
"""Build a compact, frequency-ranked dictionary from kaikki.org JSONL data.

Install the selection dependency with: python -m pip install wordfreq
Download https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl
and pass its path as --source. The large source is never deployed.
"""

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from wordfreq import top_n_list, zipf_frequency

VALID_WORD = re.compile(r"^[a-z]+(?:[ -][a-z]+)*$")
SKIP_POS = {"name", "prefix", "suffix", "infix", "interfix", "circumfix", "character", "punct", "symbol"}
SKIP_SENSE_TAGS = {"form-of", "alt-of", "no-gloss", "in-plural"}
SOURCE_URL = "https://kaikki.org/dictionary/English/index.html"


def read_seeds(path):
    if not path.exists():
        return set()
    result = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        word = line.split("#", 1)[0].strip().lower()
        word = re.sub(r"\s+", " ", word)
        word = re.sub(r"-{2,}", "-", word)
        if VALID_WORD.fullmatch(word):
            result.add(word)
    return result


def clean_text(value, limit):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    shortened = text[: limit + 1].rsplit(" ", 1)[0].rstrip(" ,;:")
    return shortened + "…" if shortened else text[:limit]


def add_record(records, raw, max_senses, max_pos):
    word = raw.get("word", "").strip().lower()
    pos = raw.get("pos", "entry")
    if not VALID_WORD.fullmatch(word) or pos in SKIP_POS or raw.get("lang_code") != "en":
        return False
    if len(word) > 40 or word.startswith(("-", " ")) or word.endswith(("-", " ")):
        return False

    record = records[word]
    if record is None:
        record = records[word] = {"w": word, "p": "", "m": {}, "u": "https://en.wiktionary.org/wiki/" + word.replace(" ", "_")}
    if pos not in record["m"] and len(record["m"]) >= max_pos:
        return False
    definitions = record["m"].setdefault(pos, [])
    added = False
    for sense in raw.get("senses", []):
        tags = set(sense.get("tags") or [])
        if tags & SKIP_SENSE_TAGS:
            continue
        glosses = sense.get("glosses") or []
        if not glosses:
            continue
        definition = clean_text(glosses[0], 600)
        if not definition or any(item["t"] == definition for item in definitions):
            continue
        if len(definitions) >= max_senses:
            break
        item = {"t": definition}
        for example in sense.get("examples") or []:
            if isinstance(example, dict) and example.get("text"):
                item["e"] = clean_text(example["text"], 280)
                break
            if isinstance(example, str) and example.strip():
                item["e"] = clean_text(example, 280)
                break
        definitions.append(item)
        added = True

    if not record["p"]:
        for sound in raw.get("sounds") or []:
            if sound.get("ipa"):
                record["p"] = clean_text(sound["ipa"], 100)
                break
    return added


def finalize_record(record):
    meanings = [{"pos": pos, "d": definitions} for pos, definitions in record["m"].items() if definitions]
    if not meanings:
        return None
    return {"w": record["w"], "p": record["p"], "m": meanings, "u": record["u"]}


def shard_key(word):
    letters = re.sub(r"[^a-z]", "", word)
    return (letters[:2] or word[0]).ljust(2, "_")


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main():
    script_dir = Path(__file__).resolve().parent
    project_dir = script_dir.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=script_dir / ".cache" / "kaikki-english.jsonl")
    parser.add_argument("--output", type=Path, default=project_dir / "data")
    parser.add_argument("--seeds", type=Path, default=script_dir / "words.txt")
    parser.add_argument("--target", type=int, default=100000)
    parser.add_argument("--candidate-pool", type=int, default=180000)
    parser.add_argument("--max-senses", type=int, default=8)
    parser.add_argument("--max-pos", type=int, default=4)
    parser.add_argument("--min-phrase-frequency", type=float, default=3.0)
    parser.add_argument("--phrase-limit", type=int, default=10000)
    args = parser.parse_args()

    if not args.source.is_file():
        parser.error(f"Source file not found: {args.source}")
    seeds = read_seeds(args.seeds)
    frequent = set(top_n_list("en", args.candidate_pool, wordlist="large"))
    selected_words = {word for word in frequent if VALID_WORD.fullmatch(word) and len(word) <= 40} | seeds
    records = defaultdict(lambda: None)
    started = time.monotonic()
    scanned = considered = 0

    with args.source.open("r", encoding="utf-8") as source:
        for scanned, line in enumerate(source, start=1):
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            word = raw.get("word", "").strip().lower()
            if raw.get("lang_code") != "en" or raw.get("pos") in SKIP_POS:
                continue
            is_candidate = word in selected_words
            if not is_candidate and " " in word and VALID_WORD.fullmatch(word):
                is_candidate = zipf_frequency(word, "en", wordlist="large") >= args.min_phrase_frequency
            if not is_candidate:
                continue
            considered += 1
            add_record(records, raw, args.max_senses, args.max_pos)
            if scanned % 250000 == 0:
                print(f"Scanned {scanned:,} lines; {len(records):,} candidates; {time.monotonic()-started:.0f}s", flush=True)

    candidates = []
    for word, record in records.items():
        entry = finalize_record(record) if record else None
        if entry:
            frequency = zipf_frequency(word, "en", wordlist="large")
            candidates.append((word in seeds, frequency, -len(word), word, entry))
    candidates.sort(reverse=True)
    word_candidates = [item for item in candidates if " " not in item[-1]["w"]]
    phrase_candidates = [item for item in candidates if " " in item[-1]["w"]]
    chosen = word_candidates[: args.target - args.phrase_limit] + phrase_candidates[: args.phrase_limit]
    if len(chosen) < args.target:
        chosen_words = {item[-1]["w"] for item in chosen}
        for item in candidates:
            if item[-1]["w"] not in chosen_words:
                chosen.append(item)
                chosen_words.add(item[-1]["w"])
                if len(chosen) >= args.target:
                    break
    if len(chosen) < args.target:
        print(f"Warning: only {len(chosen):,} usable entries were found", file=sys.stderr)

    index_shards = defaultdict(list)
    detail_shards = defaultdict(list)
    for is_seed, frequency, _, word, entry in chosen:
        summary = {"w": entry["w"], "p": entry["p"], "m": [{"pos": meaning["pos"], "d": [{"t": definition["t"]} for definition in meaning["d"][:2]]} for meaning in entry["m"][:2]]}
        index_shards[word[0]].append(summary)
        detail_shards[shard_key(word)].append(entry)

    # Overwrite active shards in place. Unreferenced files from older builds are
    # left untouched so rebuilding never requires a bulk-delete permission.
    args.output.mkdir(parents=True, exist_ok=True)
    counts = {}
    for letter in "abcdefghijklmnopqrstuvwxyz":
        entries = sorted(index_shards[letter], key=lambda item: item["w"])
        write_json(args.output / "index" / f"{letter}.json", entries)
        counts[letter] = len(entries)
    for key, entries in detail_shards.items():
        write_json(args.output / "words" / f"{key}.json", sorted(entries, key=lambda item: item["w"]))

    flat = [item[-1] for item in chosen]
    meta = {
        "name": "英释随心查",
        "version": 2,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "totalEntries": len(flat),
        "singleWords": sum(" " not in e["w"] and "-" not in e["w"] for e in flat),
        "hyphenatedEntries": sum("-" in e["w"] for e in flat),
        "phrases": sum(" " in e["w"] for e in flat),
        "counts": counts,
        "detailShards": len(detail_shards),
        "source": {"name": "English Wiktionary via kaikki.org / Wiktextract", "url": SOURCE_URL, "license": "Creative Commons Attribution-ShareAlike 4.0 International", "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/"},
        "selection": {"method": "wordfreq large English frequency list, plus frequent phrases and bundled seed words", "candidatePool": args.candidate_pool, "phraseLimit": args.phrase_limit, "maxSensesPerPartOfSpeech": args.max_senses, "maxPartsOfSpeech": args.max_pos},
    }
    write_json(args.output / "meta.json", meta)
    report = {"sourceLines": scanned, "candidateRecords": considered, "usableBeforeLimit": len(candidates), "included": len(flat), "elapsedSeconds": round(time.monotonic() - started, 1), "seedsMissing": sorted(seeds - {e["w"] for e in flat})}
    write_json(args.output / "build-report.json", report)
    total_bytes = sum(path.stat().st_size for path in args.output.rglob("*.json"))
    print(f"Built {len(flat):,} entries in {len(detail_shards)} detail shards; {total_bytes/1024/1024:.1f} MiB", flush=True)
    print(f"Words: {meta['singleWords']:,}; hyphenated: {meta['hyphenatedEntries']:,}; phrases: {meta['phrases']:,}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
