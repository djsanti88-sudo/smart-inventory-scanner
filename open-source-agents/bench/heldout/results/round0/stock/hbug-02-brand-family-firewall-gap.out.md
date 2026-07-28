<!-- subject=stock case=hbug-02-brand-family-firewall-gap round=0 elapsed=122s rc=0 -->
**Result:**  
No functional defects were identified in the provided module. The logic correctly normalizes brand names, pre‑computes family indices, and determines same‑company relationships per the curated table while respecting the constraints that unknown brands never match unless they normalize identically. All edge cases (empty strings, missing data, identical names) are handled as intended.
