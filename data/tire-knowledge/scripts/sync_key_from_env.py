"""
Sync the FIRECRAWL_API_KEY from inventory/.env.local into the Firecrawl CLI store
(which is what the harvester actually reads), and reset the spend counter.

- Reads .env.local; never prints the key (only a masked confirmation).
- Does NOT modify or delete .env.local (your source of truth stays intact).
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, "..", "..", ".env.local")  # C:\Users\djsan\inventory\.env.local


def main():
    if not os.path.exists(ENV):
        print("ERROR: .env.local not found at", os.path.abspath(ENV))
        sys.exit(1)
    txt = open(ENV, encoding="utf-8").read()
    m = re.search(r"FIRECRAWL_API_KEY\s*=\s*[\"']?(fc-[A-Za-z0-9]{8,})", txt)
    if not m:
        print("ERROR: FIRECRAWL_API_KEY (fc-...) not found in .env.local. Nothing changed.")
        sys.exit(1)
    key = m.group(1)

    cred_dir = os.path.join(os.environ["APPDATA"], "firecrawl-cli")
    os.makedirs(cred_dir, exist_ok=True)
    json.dump({"apiKey": key, "apiUrl": "https://api.firecrawl.dev"},
              open(os.path.join(cred_dir, "credentials.json"), "w", encoding="utf-8"), indent=2)

    pol_path = os.path.join(ROOT, "firecrawl_policy.json")
    pol = json.load(open(pol_path, encoding="utf-8"))
    pol["total_credits_spent"] = 0
    pol["TOTAL_CAP"] = 1000
    pol["PER_RUN_CAP"] = 30
    json.dump(pol, open(pol_path, "w", encoding="utf-8"), indent=2)

    masked = key[:5] + "..." + key[-4:]
    print(f"[ok] synced key from .env.local ({masked}) -> Firecrawl CLI store (.env.local untouched)")
    print("[ok] policy reset: total_credits_spent=0, TOTAL_CAP=1000, PER_RUN_CAP=30")
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    try:
        import firecrawl_client as fc
        print("[ok] remaining credits on this key:", fc.get_remaining_credits())
    except Exception as e:
        print("[warn] could not read status:", str(e)[:120])


if __name__ == "__main__":
    main()
