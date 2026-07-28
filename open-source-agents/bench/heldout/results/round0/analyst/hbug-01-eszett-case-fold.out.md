<!-- subject=analyst case=hbug-01-eszett-case-fold round=0 elapsed=65s rc=0 -->
**TRACE:**  
1. `uniq(['a','b','a'])` →  
   - out = []  
   - v='a': truthy, not in out → push → out=['a']  
   - v='b': truthy, not in out → push → out=['a','b']  
   - v='a': truthy, already in out → skip. Result `['a','b']`.  

2. `candidatesInclude(['ABC'], 'abc')` →  
   - field truthy → folded = foldCase('abc') = `'ABC'`  
   - candidates.some: c='ABC', foldCase(c) = `'ABC'`, equals folded → return true.

**SYNTAX‑FILTER:** No candidate finding is a claim about spelling, an undefined identifier, or a missing declaration.  

**VERDICT:** SOUND – the provided excerpts behave as intended for the tested scenarios.  

**FINDINGS:** none - no defect met the evidence bar.  

**QUESTIONS:**  
- What is the exact `ScanResolution` type definition? (to confirm that the returned object in `pickTier` matches the expected shape, especially the optional `conflictProductIds` field.)
