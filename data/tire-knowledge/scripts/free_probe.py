"""Free probe: fetch a URL with requests, report status/len/robots and GTIN-valid barcode density."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests, certifi
import validate as v

H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36"}


def get(url):
    try:
        r = requests.get(url, headers=H, timeout=25, verify=certifi.where())
        return r.status_code, r.text
    except Exception as e:
        return None, repr(e)[:160]


for url in sys.argv[1:]:
    st, body = get(url)
    if st is None:
        print(f"[ERR] {url} -> {body}")
        continue
    nums = set(re.findall(r"(?<!\d)\d{12,14}(?!\d)", body))
    valid = [n for n in nums if v.gtin_check_digit_valid(n)]
    title = re.search(r"<title>(.*?)</title>", body or "", re.I | re.S)
    print(f"[{st}] len={len(body)} valid_gtins={len(valid)} | {url}")
    print(f"     title: {title.group(1).strip()[:80] if title else '?'}")
    low = (body or "").lower()
    for kw in ["tire", "captcha", "blocked", "access denied", "cloudflare", "enable javascript"]:
        if kw in low:
            print(f"     has '{kw}'")
