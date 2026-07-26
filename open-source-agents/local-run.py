#!/usr/bin/env python3
"""Local model runner: routes prompts to Ollama (native API, port 11434).

Roles map to a persona (system prompt) + a model + efficiency caps:
  analyst -> gpt-oss-20b     (reasoning critic; 16k ctx, high thinking)
  coder   -> qwen3-coder-30b (code work; 16k ctx)
  chore   -> qwen3-8b        (fast triage; 8k ctx - the small-model default)

Usage:
  python local-run.py --role analyst "Review this design: ..."
  python local-run.py --role analyst --lens skeptic --context src/foo.ts "Review"
  echo "long text" | python local-run.py --role chore -

Layers: --doctrine prepends the Fable reasoning doctrine (teach rounds);
--lens <name> sharpens the analyst to one angle; --rag prepends retrieved
project-law chunks (needs rag-index.jsonl built by rag-index.py).

Heavy cloud route: for zero-local-load analysis on big tasks, the orchestrator
dispatches the agy:runner agent (gpt-oss-120b on the Antigravity subscription)
instead of this script - see README.

Models auto-load on first call and unload after 30 idle minutes (keep_alive).
Prints the answer to stdout; model + token usage to stderr. $0 per call.
"""
import argparse
import json
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://localhost:11434"
HERE = pathlib.Path(__file__).parent
RAM_CEILING = 85    # owner order 2026-07-25: never start work above this
RAM_KILL = 92       # mid-run watchdog: abort rather than crash the machine


def ram_percent():
    import ctypes
    from ctypes import wintypes

    class MS(ctypes.Structure):
        _fields_ = [("dwLength", wintypes.DWORD),
                    ("dwMemoryLoad", wintypes.DWORD),
                    ("ullTotalPhys", ctypes.c_uint64),
                    ("ullAvailPhys", ctypes.c_uint64),
                    ("pad", ctypes.c_uint64 * 4)]
    m = MS()
    m.dwLength = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.dwMemoryLoad


def resource_guard():
    """Pre-flight: refuse to add model load when RAM is already hot."""
    for _ in range(30):  # wait up to 5 min for pressure to drop
        pct = ram_percent()
        if pct <= RAM_CEILING:
            return
        print(f"[local-run] RAM at {pct}% > {RAM_CEILING}% ceiling - waiting "
              f"for pressure to drop before loading a model...", file=sys.stderr)
        time.sleep(10)
    sys.exit(f"[local-run] ABORTED: RAM stayed above {RAM_CEILING}% for 5 min; "
             "not loading a local model into a hot machine. Close apps or use "
             "the agy cloud route.")


def start_watchdog():
    """Mid-generation: if RAM crosses RAM_KILL, abort this process instead of
    letting Windows start killing apps."""
    import threading

    def watch():
        while True:
            time.sleep(10)
            pct = ram_percent()
            if pct >= RAM_KILL:
                print(f"[local-run] WATCHDOG: RAM {pct}% >= {RAM_KILL}% - "
                      "aborting generation to protect the machine", file=sys.stderr)
                import os
                os._exit(3)
    threading.Thread(target=watch, daemon=True).start()
ROLES = {
    "analyst": {"model": "gpt-oss-20b", "num_ctx": 16384, "think": "high"},
    "coder": {"model": "qwen3-coder-30b", "num_ctx": 16384, "think": None},
    "chore": {"model": "qwen3-8b", "num_ctx": 8192, "think": None},
    # recall: knowledge Q&A - separate identity so the review persona's
    # verify-everything framing never primes refusal; crib sheet auto-attached
    "recall": {"model": "gpt-oss-20b", "num_ctx": 16384, "think": "low"},
    # stock: untaught control for benchmarking - neutral persona, no layers
    "stock": {"model": "gpt-oss-20b", "num_ctx": 16384, "think": "medium"},
}
KEEP_ALIVE = "30m"


def get_json(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def post_json(path, payload, timeout):
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def ensure_server():
    try:
        get_json(f"{BASE}/api/tags")
        return
    except (urllib.error.URLError, OSError):
        pass
    print("[local-run] ollama down, starting...", file=sys.stderr)
    subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL,
                     shell=(sys.platform == "win32"))
    for _ in range(30):
        time.sleep(1)
        try:
            get_json(f"{BASE}/api/tags")
            return
        except (urllib.error.URLError, OSError):
            continue
    sys.exit("[local-run] FATAL: ollama did not come up on :11434")


def resolve_model(pattern):
    models = [m["name"] for m in get_json(f"{BASE}/api/tags")["models"]]
    hits = [m for m in models if pattern.lower() in m.lower()]
    if not hits:
        sys.exit(f"[local-run] FATAL: no model matches '{pattern}'. "
                 f"Available: {models}")
    return sorted(hits, key=len)[0]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--role", choices=sorted(ROLES), default="chore",
                   help="chore is the default: small model first, big on demand")
    p.add_argument("--lens", help="single-angle lens (personas/lenses/<name>.md)")
    p.add_argument("--doctrine", action="store_true",
                   help="prepend the Fable reasoning doctrine (teach rounds)")
    p.add_argument("--rag", action="store_true",
                   help="prepend retrieved project-law chunks (rag-index.jsonl)")
    p.add_argument("--exemplars", action="store_true",
                   help="append worked review exemplars (personas/exemplars.md)")
    p.add_argument("--crib", action="append", default=[],
                   help="append a crib sheet by name: 'law' (personas/crib-sheet.md) "
                        "or a domain crib from personas/cribs/<name>.md "
                        "(ledger, import, decode, testing). Repeatable. "
                        "'law' auto-attaches for the recall role.")
    p.add_argument("--effort", choices=["low", "medium", "high"],
                   help="thinking level for reasoning models (default per role)")
    p.add_argument("--model", help="exact or partial model name override")
    p.add_argument("--context", action="append", default=[],
                   help="file appended to the prompt (repeatable)")
    p.add_argument("--max-tokens", type=int, default=8192)
    p.add_argument("--temperature", type=float, default=0.2)
    p.add_argument("--timeout", type=int, default=1750)
    p.add_argument("--show-reasoning", action="store_true")
    p.add_argument("prompt", help="prompt text, or '-' to read from stdin")
    args = p.parse_args()

    prompt = sys.stdin.read() if args.prompt == "-" else args.prompt
    for path in args.context:
        text = pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
        prompt += f"\n\n--- FILE: {path} ---\n{text}"

    role = ROLES[args.role]
    system = (HERE / "personas" / f"{args.role}.md").read_text(encoding="utf-8")
    crib_names = list(args.crib)
    if args.role == "recall" and "law" not in crib_names:
        crib_names.insert(0, "law")
    for name in crib_names:
        path = (HERE / "personas" / "crib-sheet.md") if name == "law" \
            else (HERE / "personas" / "cribs" / f"{name}.md")
        if not path.exists():
            sys.exit(f"[local-run] FATAL: unknown crib '{name}' ({path})")
        system += f"\n\n# REFERENCE (trusted crib: {name})\n" + \
            path.read_text(encoding="utf-8")
    if args.exemplars:
        ex = HERE / "personas" / "exemplars.md"
        system += "\n\n" + ex.read_text(encoding="utf-8")
    if args.doctrine:
        doctrine = (HERE / "personas" / "doctrine.md").read_text(encoding="utf-8")
        system = doctrine + "\n\n" + system
    if args.lens:
        lens_file = HERE / "personas" / "lenses" / f"{args.lens}.md"
        if not lens_file.exists():
            available = sorted(f.stem for f in (HERE / "personas" / "lenses").glob("*.md"))
            sys.exit(f"[local-run] FATAL: unknown lens '{args.lens}'. Available: {available}")
        system += "\n\n" + lens_file.read_text(encoding="utf-8")

    ensure_server()

    if args.rag:
        import importlib.util
        spec = importlib.util.spec_from_file_location("ragindex", HERE / "rag-index.py")
        ragindex = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ragindex)
        hits = ragindex.top_k(prompt[:2000], k=6)
        ref = "\n\n".join(f"[{r['source']}] {r['text']}" for _, r in hits)
        prompt = ("REFERENCE MATERIAL (trusted project documentation, retrieved "
                  "for this task - prefer it over general knowledge):\n"
                  f"{ref}\n\n=== TASK ===\n{prompt}")

    resource_guard()
    start_watchdog()
    model = resolve_model(args.model or role["model"])
    think = args.effort or role["think"]
    print(f"[local-run] model={model} role={args.role} lens={args.lens or '-'} "
          f"doctrine={args.doctrine} rag={args.rag} think={think or '-'}",
          file=sys.stderr)

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "keep_alive": KEEP_ALIVE,
        "options": {
            "num_ctx": role["num_ctx"],
            "temperature": args.temperature,
            "num_predict": args.max_tokens,
        },
    }
    if think:
        payload["think"] = think

    t0 = time.time()
    out = post_json("/api/chat", payload, timeout=args.timeout)

    msg = out.get("message", {})
    content = msg.get("content")
    thinking = msg.get("thinking")
    if args.show_reasoning and thinking:
        print(f"=== reasoning ===\n{thinking}\n=== answer ===")
    if not content and thinking:
        print("[local-run] WARNING: no final answer (budget spent in thinking); "
              "raw reasoning follows", file=sys.stderr)
        content = thinking
    print(content or "")
    print(f"[local-run] {time.time()-t0:.1f}s | prompt={out.get('prompt_eval_count')} "
          f"completion={out.get('eval_count')} tokens | $0.00 (local)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
