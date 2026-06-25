"""
Install a new Firecrawl API key WITHOUT it ever entering the chat transcript.

Usage:  uv run python scripts/set_firecrawl_key.py <path_to_key_file>

- Reads the key from a local file (its contents never get printed).
- Writes it to the Firecrawl CLI's standard credentials store (credentials.json).
- Deletes the temp key file.
- Resets the harvester credit counter for the fresh budget.
- Prints ONLY a masked confirmation + remaining credits (never the key).
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    if len(sys.argv) < 2:
        print("ERROR: pass the key file path")
        sys.exit(1)
    keyfile = sys.argv[1]
    if not os.path.exists(keyfile):
        print(f"ERROR: file not found: {keyfile}")
        sys.exit(1)

    # Read + extract the key (first fc-... token). Never print it.
    raw = open(keyfile, encoding="utf-8").read()
    m = re.search(r"fc-[A-Za-z0-9]{8,}", raw)
    if not m:
        print("ERROR: no 'fc-...' key found in the file. Nothing changed.")
        sys.exit(1)
    key = m.group(0)

    # Write to the Firecrawl CLI's standard credentials store.
    cred_dir = os.path.join(os.environ["APPDATA"], "firecrawl-cli")
    os.makedirs(cred_dir, exist_ok=True)
    cred_path = os.path.join(cred_dir, "credentials.json")
    json.dump({"apiKey": key, "apiUrl": "https://api.firecrawl.dev"},
              open(cred_path, "w", encoding="utf-8"), indent=2)

    # Reset the harvester spend counter for the new key's budget.
    pol_path = os.path.join(ROOT, "firecrawl_policy.json")
    pol = json.load(open(pol_path, encoding="utf-8"))
    pol["total_credits_spent"] = 0
    pol["TOTAL_CAP"] = 1000     # new key budget; actual spend still controlled per run
    pol["PER_RUN_CAP"] = 30
    json.dump(pol, open(pol_path, "w", encoding="utf-8"), indent=2)

    # Securely remove the temp key file.
    try:
        os.remove(keyfile)
        removed = True
    except Exception:
        removed = False

    masked = key[:5] + "..." + key[-4:]   # e.g. fc-ab...wxyz  (safe to show)
    print(f"[ok] key installed ({masked}); temp file deleted: {removed}")
    print("[ok] policy reset: total_credits_spent=0, TOTAL_CAP=1000, PER_RUN_CAP=30")

    # Confirm by reading live status (shows credits, not the key).
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    try:
        import firecrawl_client as fc
        print("[ok] remaining credits on new key:", fc.get_remaining_credits())
    except Exception as e:
        print("[warn] could not read status:", str(e)[:120])


if __name__ == "__main__":
    main()
