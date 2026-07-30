# Local Manager Demo

Purpose: run a repeatable ten-minute Scanbin presentation entirely on this computer, with external lookup and cloud activity disabled.

## Goals and current focus

Show a manager that Scanbin counts every physical scan immediately, identifies trusted tires exactly, preserves unknown scans, supports safe correction, and produces useful local reports without contacting production services.

## Safety boundary

This walkthrough is localhost-only. Use only the commands in this guide.

- Do not run `npm.cmd run dev:prod`.
- Do not use GitHub Actions, Vercel, Firebase production, Turso promotion, or any live provider.
- Do not add provider keys. OpenAI, Gemini, Go-UPC, Brave, Firecrawl, and other external lookup services must remain off.
- Do not open a network or deployed URL. The presentation URL is exactly `http://localhost:3400`.
- Do not use **Delete account and all data**. The safe presentation reset is **Clear local cache** in Settings.

## Operator setup

Use PowerShell in the repository root:

```powershell
Set-Location C:\tmp\inventory-local-tire-demo
```

1. Provision the pinned local database when this checkout does not already contain it:

   ```powershell
   npm.cmd run demo:provision
   ```

2. Generate the immutable 3,000-tire proof manifest:

   ```powershell
   npm.cmd run demo:manifest
   ```

   The generator intentionally refuses to overwrite an existing run for the same Git revision and database hash. If `reports/local-tire-demo/active-run.json` already names the current validated run, keep that run and continue.

3. Start the guarded local production build and server:

   ```powershell
   npm.cmd run demo:local
   ```

   Leave this terminal open. Wait for all of the following:

   - `LOCAL TIRE DEMO`
   - `http://localhost:3400/scan`
   - a database SHA-256
   - `external decode disabled`

4. In Chrome, open:

   ```text
   http://localhost:3400/scan
   ```

5. Confirm the persistent green banner says **Local tire demo** and **External lookup off**. It must also say that cloud sync, AI lookup, and telemetry are off.

If the banner is absent, the port is not 3400, or the terminal reports blocked egress, stop the presentation. Do not fall back to `dev:prod`.

## Ten-minute manager script

### 0:00 to 1:00: Establish trust

Say:

> This copy is running only on my computer. External lookup, cloud sync, AI lookup, and telemetry are off. Tire identities come from a fixed tire list stored on this computer.

Point to the green **External lookup off** banner. On Scan, expand **Sessions and export**, enter `Manager demo` as the session name and an optional location such as `Front counter`, then select **Start new session**.

### 1:00 to 2:30: Scan one exact tire twice

Use this current pinned database example:

| Field | Exact value |
|---|---|
| Barcode | `758823190407` |
| Brand | `westlake` |
| Model | `SA07 Sport` |
| Size | `245/55R18` |
| Canonical product ID | `TIRE_5BAC923891027924DEE7` |

1. Focus **Scan a code**.
2. Enter `758823190407` and press Enter.
3. Confirm the row appears immediately in **What you just scanned** and settles as a verified local-corpus match with the exact brand, model, and size above.
4. Enter the same barcode again.
5. Confirm there are two physical feed rows and the final-count quantity is `2`.

Say:

> Repeated scans remain separate audit events, while inventory rolls them into one product quantity.

### 2:30 to 4:00: Prove an invalid near-match is still counted

Use the derived invalid-checksum near-match `758823190408`. It differs only in the final digit and is not the certified barcode.

1. Enter `758823190408` and press Enter.
2. Confirm a third physical feed row appears immediately.
3. Confirm it remains an **Unidentified item** or needs-review item. It must not inherit the Westlake identity.
4. Confirm total counted quantity is now `3`: Westlake quantity `2`, plus one provisional unidentified item.

Say:

> Wrong identity is worse than unknown. Scanbin refuses the near-match, but it never drops the physical scan.

### 4:00 to 5:15: Correct the unknown and prove quantity transfer

1. Open **Review**.
2. Find barcode `758823190408`.
3. Leave **Add to count** checked.
4. In **Select a product...**, choose the existing Westlake SA07 Sport product.
5. Select **Link**. If the mismatch warning appears, read it aloud and use **Link anyway** only because this is the deliberate correction demonstration.
6. Return to Scan.
7. Confirm the provisional unidentified quantity disappeared and the Westlake quantity became `3`.
8. Confirm the overall quantity stayed `3`. Correction transfers the already-counted event; it does not delete or count it twice.

The local demo saves in this browser and never syncs to production. Offline and retry controls are administrator diagnostics, so they are not part of this manager walkthrough.

### 5:15 to 6:30: Reload and inspect history

1. Reload the Chrome page.
2. Confirm the current session, feed, and quantities return from local browser persistence.
3. Select **Finish session**.
4. Open **History**.
5. Open the `Manager demo` session and confirm the saved scan log shows the physical scans and quantities.

Say:

> A refresh does not erase the count, and the session history preserves the scan audit trail.

### 6:30 to 7:45: Show the manager report and print view

1. Open **Report** in the main navigation.
2. Confirm **Boss Report** shows the session totals and brand/category rollups.
3. Select **Print**.
4. In the browser print preview, confirm navigation and screen-only controls are removed and the report is formatted for paper or Save as PDF.
5. Cancel print preview unless the manager asks for a local copy.

Shareable links are intentionally absent in local-demo mode.

### 7:45 to 8:45: Export CSV

1. Return to **Scan**.
2. Expand **Sessions and export**.
3. Open **Export**.
4. Under **Inventory**, select **CSV** beside **Final counts**.
5. Confirm Chrome downloads a local `final-counts` CSV.

The export is generated from the local session. Do not upload it or import real customer data during this demonstration.

### 8:45 to 10:00: Close with proof

Open this loopback-only status URL:

```text
http://localhost:3400/api/local-demo/status
```

Confirm:

- `"localDemo": true`
- `"externalDecodeEnabled": false`
- the database SHA-256 matches the launcher output
- `"egress": { "blockedAttemptCount": 0, "attempts": [] }`

Say:

> This status confirms local-demo mode, the database fingerprint, and that the server recorded no blocked outbound attempts. It does not verify the browser network or the scan results.

## Certification mode with proofBatch

Certification uses the proof UI at `/report?proofBatch=NN`. A displayed **PASS** is required, but it is
not enough by itself. Do not claim a certified batch from the ten-minute walkthrough or from the status
endpoint alone; every listed check below is required for acceptance.

The ten-minute narrative does not require proof mode. For a locked certification batch, start at:

```text
http://localhost:3400/scan?proofBatch=01
```

Valid values are exactly `01` through `30`. Keep the query parameter while moving from Scan to Report. The Report proof must name the same batch, contain exactly 100 physical events, show final quantity `100`, show replayed quantity `100`, and pass its manifest/hash checks before the batch is accepted.

In the proof UI, each rendered scan row must expose its local-demo event ID, app-local matched product
ID, and actual local-corpus canonical product UID. The batch proof must bind those rows to the selected
`proofBatch`. Do not accept a batch when a
row is missing, duplicated, assigned to a different product, or bound to a different batch.

Use the matching immutable batch endpoint only from loopback:

```text
http://localhost:3400/api/local-demo/manifest/01
```

For each certified batch, also open `/api/local-demo/status` and require `blockedAttemptCount: 0`: this
means zero recorded blocked server-egress attempts, not proof that the browser made no network requests.
Capture browser DevTools network proof separately and require no non-local browser request. A missing
proof, wrong batch, hash mismatch, nonzero recorded blocked server-egress attempt, console error,
non-local browser request, dropped event, or duplicate event is a failed batch, never a partial pass.

## Reset before a real presentation

Perform this before the audience arrives, not during the walkthrough:

1. Open **Settings**.
2. Scroll to **Danger zone**.
3. Select **Clear local cache**.
4. Confirm the browser prompt. Enter the owner PIN if the app requests it.
5. Wait for **Local browser cache cleared. Cloud data was not deleted.**
6. Allow the automatic reload.
7. Return to `http://localhost:3400/scan`.
8. Confirm the green **External lookup off** banner and an empty scan feed.
9. Start a fresh `Manager demo` session.

This reset clears browser-local demo state only. Never use **Delete account and all data** as a presentation reset.

## Operator checklist

### Before opening the room

- [ ] Correct checkout: `C:\tmp\inventory-local-tire-demo`
- [ ] Local database provisioned with `npm.cmd run demo:provision` when needed
- [ ] Current manifest available from `npm.cmd run demo:manifest` or an already validated active run
- [ ] Server started with `npm.cmd run demo:local`
- [ ] Terminal shows `external decode disabled`
- [ ] Chrome is at `http://localhost:3400/scan`
- [ ] Green **Local tire demo / External lookup off** banner is visible
- [ ] Settings **Clear local cache** completed
- [ ] Fresh `Manager demo` session started
- [ ] No production credentials, provider keys, tunnels, GitHub, Vercel, or production consoles open

### Required outcomes

- [ ] Exact Westlake tire shows barcode `758823190407`, model `SA07 Sport`, and size `245/55R18`
- [ ] Second exact scan increments quantity to `2`
- [ ] Invalid near-match `758823190408` remains unidentified and counted
- [ ] Review correction transfers quantity without changing total physical scans
- [ ] Local-demo mode remains browser-local and does not enable production sync
- [ ] Reload preserves local state
- [ ] History contains the finished session and scan log
- [ ] Report totals are correct and Print opens the local print view
- [ ] Final counts CSV downloads locally
- [ ] `/api/local-demo/status` reports external decode disabled and zero recorded blocked server-egress attempts

### Stop conditions

Stop and mark the walkthrough not ready if any of these occur:

- the local-demo banner is missing
- a known tire is not an exact database identity
- the invalid near-match receives a verified identity
- a physical scan is missing from the feed or total quantity
- correction changes the total number of physical scans
- reload loses the session
- any console exception or non-local browser request appears
- the status egress record shows any blocked external attempt
- anyone proposes `dev:prod`, GitHub, Vercel, Firebase production, Turso promotion, or a live provider as a workaround
