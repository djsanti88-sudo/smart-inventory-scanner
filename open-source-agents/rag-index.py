#!/usr/bin/env python3
"""Build the local RAG knowledge index for the fleet (round-2 teaching).

Chunks the project's law/architecture docs, embeds each chunk with the local
nomic-embed model via LM Studio's /v1/embeddings, and writes rag-index.jsonl
(one {text, source, vector} per line). Retrieval happens in local-run.py --rag.

Usage:  python rag-index.py            (build/rebuild the index)
        python rag-index.py --query "..."  (test retrieval, prints top chunks)

$0, fully local. Requires: lms server running (auto-started), nomic-embed
downloaded (verified present 2026-07-22).
"""
import argparse
import json
import pathlib
import re
import sys
import urllib.request

BASE = "http://localhost:11434"
EMBED_MODEL = "nomic"  # substring-matched against /api/tags
HERE = pathlib.Path(__file__).parent
REPO = HERE.parent
INDEX = HERE / "rag-index.jsonl"
DOCS = [
    REPO / "CLAUDE.md",
    REPO / "docs" / "ARCHITECTURE.md",
    REPO / "LESSONS_LEARNED.md",
    REPO / "DECISIONS.md",
    REPO / "docs" / "PLAN_EXECUTION.md",
    REPO / "docs" / "DECODER_ARCHITECTURE.md",
    REPO / "TESTING.md",
]
CHUNK_MAX_CHARS = 1600  # ~400 tokens; small enough to pack several into 16k ctx


def post_json(path, payload):
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def resolve_embed_model():
    with urllib.request.urlopen(f"{BASE}/api/tags", timeout=10) as r:
        models = [m["name"] for m in json.load(r)["models"]]
    hits = [m for m in models if EMBED_MODEL in m.lower()]
    if not hits:
        sys.exit(f"FATAL: no embedding model matching '{EMBED_MODEL}' in {models}")
    return hits[0]


def chunk(doc_path):
    """Split on markdown headings, then hard-wrap oversized sections."""
    text = doc_path.read_text(encoding="utf-8", errors="replace")
    sections = re.split(r"(?m)^(?=#{1,3} )", text)
    for sec in sections:
        sec = sec.strip()
        if not sec:
            continue
        while len(sec) > CHUNK_MAX_CHARS:
            cut = sec.rfind("\n", 0, CHUNK_MAX_CHARS)
            cut = cut if cut > 200 else CHUNK_MAX_CHARS
            yield sec[:cut].strip()
            sec = sec[cut:].strip()
        if sec:
            yield sec


def embed(model, texts):
    out = post_json("/api/embed", {"model": model, "input": texts})
    return out["embeddings"]


def build():
    model = resolve_embed_model()
    rows = []
    for doc in DOCS:
        if not doc.exists():
            print(f"skip missing {doc}", file=sys.stderr)
            continue
        chunks = list(chunk(doc))
        for i in range(0, len(chunks), 16):
            batch = chunks[i:i + 16]
            for text, vec in zip(batch, embed(model, batch)):
                rows.append({"text": text, "source": doc.name, "vector": vec})
        print(f"indexed {doc.name}: {len(chunks)} chunks", file=sys.stderr)
    with INDEX.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    print(f"wrote {len(rows)} chunks -> {INDEX}", file=sys.stderr)


def top_k(query, k=6):
    model = resolve_embed_model()
    qv = embed(model, [query])[0]
    def dot(a, b):
        return sum(x * y for x, y in zip(a, b))
    qn = dot(qv, qv) ** 0.5
    scored = []
    with INDEX.open(encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            v = row["vector"]
            sim = dot(qv, v) / (qn * (dot(v, v) ** 0.5) + 1e-9)
            scored.append((sim, row))
    scored.sort(key=lambda t: -t[0])
    return scored[:k]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--query")
    ap.add_argument("-k", type=int, default=6)
    args = ap.parse_args()
    if args.query:
        for sim, row in top_k(args.query, args.k):
            print(f"--- {sim:.3f} [{row['source']}]\n{row['text'][:300]}\n")
    else:
        build()
