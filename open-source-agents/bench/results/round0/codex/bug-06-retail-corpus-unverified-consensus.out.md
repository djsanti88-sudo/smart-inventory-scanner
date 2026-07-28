# Defect

The final settled ladder result bypasses the evidence/consensus firewall. `win.decision.status` may be the `"verified"` value self-reported by a single paid rung, and the code returns `win` verbatim without re-running the decision against `retailHit` or independently verified evidence.

For example, if the local retail row identifies code C as product A but one paid provider confidently returns product B and labels it verified, the `win` branch can publish B as verified even though the sources conflict. Conversely, a paid provider that repeats an erroneous retail identity can turn two non-authoritative assertions into a verified result without the required independent evidence. Provider output must remain evidence, not authority: the assembled winner must pass the same code-specific consensus/conflict checks before `"verified"` is returned.
