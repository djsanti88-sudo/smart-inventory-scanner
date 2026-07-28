# Defect

Deleting a product destroys already-counted session quantity while retaining the scan events that produced it. For example, if product P has three scans and a `finalCounts` row with quantity 3, deleting P removes that count row but leaves all three feed rows, merely changing them to `needs_review`. The session total immediately loses three units even though no scan was removed, so the feed and count ledger disagree.

This also discards the count row's applied-event/idempotency history. If those preserved feed events are later relinked or replayed, the store no longer has the count-side record proving that they were already applied, creating a risk of counting them again. Archiving/unmatching a product must preserve or transfer the quantities represented by its feed events rather than filtering the count row away.
