#!/usr/bin/env python3
"""Run benchmark cases through a local model role and save outputs for judging.

Usage:
  python run-bench.py --round 0 --role analyst [--lens skeptic] [--case bug-01]
Outputs: bench/results/round<N>/<role>[-<lens>]/<case>.out.md
The subject never sees anything at or below the '## GROUND TRUTH' marker.
"""
import argparse
import pathlib
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).parent
RUNNER = HERE.parent / "local-run.py"
MARKER = "## GROUND TRUTH"


def subject_view(case_text):
    return case_text.split(MARKER)[0].rstrip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--round", required=True)
    p.add_argument("--role", default="analyst")
    p.add_argument("--lens")
    p.add_argument("--case", help="run one case (stem match); default all")
    p.add_argument("--taught", action="store_true",
                   help="run with the Fable doctrine attached (teach rounds)")
    p.add_argument("--rag", action="store_true",
                   help="run with project-law RAG retrieval (round 2+)")
    p.add_argument("--exemplars", action="store_true",
                   help="run with worked review exemplars (round 3+)")
    p.add_argument("--crib", nargs="*", default=None,
                   help="attach crib sheet(s): bare flag = 'law'; or names "
                        "(law, ledger, import, decode, testing)")
    p.add_argument("--effort", choices=["low", "medium", "high"],
                   help="thinking effort override for reasoning models")
    p.add_argument("--suite", default="main", choices=["main", "heldout"],
                   help="main = cases/ + results/; heldout = heldout/cases/ + heldout/results/")
    args = p.parse_args()

    base = HERE if args.suite == "main" else HERE / "heldout"
    cases = sorted((base / "cases").glob("*.md"))
    if args.case:
        cases = [c for c in cases if args.case in c.stem]
    if not cases:
        sys.exit("no cases matched")

    label = args.role + (f"-{args.lens}" if args.lens else "")
    outdir = base / "results" / f"round{args.round}" / label
    outdir.mkdir(parents=True, exist_ok=True)

    for case in cases:
        out_file = outdir / f"{case.stem}.out.md"
        if out_file.exists():
            print(f"skip {case.stem} (exists)")
            continue
        view = subject_view(case.read_text(encoding="utf-8"))
        cmd = [sys.executable, str(RUNNER), "--role", args.role]
        if args.lens:
            cmd += ["--lens", args.lens]
        if args.taught:
            cmd += ["--doctrine"]
        if args.rag:
            cmd += ["--rag"]
        if args.crib is not None:
            for name in (args.crib or ["law"]):
                cmd += ["--crib", name]
        if args.exemplars:
            cmd += ["--exemplars"]
        if args.effort:
            cmd += ["--effort", args.effort]
        cmd += ["-"]
        t0 = time.time()
        r = subprocess.run(cmd, input=view, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=1800)
        elapsed = time.time() - t0
        body = r.stdout if r.returncode == 0 else f"RUN FAILED\n{r.stderr}"
        out_file.write_text(
            f"<!-- subject={label} case={case.stem} round={args.round} "
            f"elapsed={elapsed:.0f}s rc={r.returncode} -->\n{body}",
            encoding="utf-8")
        print(f"done {case.stem} [{label}] {elapsed:.0f}s rc={r.returncode}")


if __name__ == "__main__":
    main()
