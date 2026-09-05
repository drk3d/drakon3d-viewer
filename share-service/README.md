# Drakon3D public share service

This Cloudflare Worker stores temporary `.3dm` snapshots for `DkShare` and
returns them only to the Drakon3D Viewer. It is designed for a public Drakon
release: a valid, online Drakon licence is checked by Keygen for **every new
upload** and quotas are enforced by the service, not by a value hidden in the
Rhino plug-in.

## Public sharing rules

| Licence | Allowance |
|---|---:|
| Trial | 3 exports total for the entire trial (up to 3 live at once) |
| Educational | 10 active links |
| Lab | 10 active links |
| Commercial | 10 active links |
| Commercial Pro | 30 active links |
| Expired, suspended, unsupported or offline | No new links |

Links expire after **7 days by default**. At link creation, `DkShare` lets the
user choose any whole number of days from **1 to 14**. The service enforces the
14-day maximum itself, so it cannot be bypassed by changing the plug-in. Links
remain available for their scheduled lifetime if a licence later expires; the
user simply cannot create a new link. The viewer redirects expired or unavailable share links to
`https://viewer.drakon3d.com/`.

The service retains an absolute 100 MB model limit and a global 8 GiB live-data
limit. The latter is deliberately below the R2 free storage allowance, leaving
headroom for ordinary service operation.

## Architecture

1. `DkShare` first performs Drakon's normal local licence check.
2. It sends the current user session, licence ID and activated-machine details
   over HTTPS. It does **not** contain a global upload secret.
3. The Worker validates those credentials with Keygen, checks the policy, and
   reserves capacity in `ShareQuotaCoordinator` before writing to R2.
4. The Durable Object keeps quota changes serialised, records trial exports,
   and uses alarms to remove expired uploads and release their quota.
5. R2 lifecycle deletion at 15 days remains a second cleanup backstop.

Only small accounting records are kept in the Durable Object. Files remain in
R2, so the licence layer can later be moved to another Drakon service or the
quota store can be expanded without changing public share links or the viewer.

## Deploy once the code is approved

From this directory:

```powershell
npx wrangler deploy
```

The deploy creates the SQLite-backed Durable Object namespace declared in
`wrangler.jsonc`; it does not need a database created manually in the dashboard.
Keep the existing R2 lifecycle rule for the `shares/` prefix at 15 days.

The released plug-in no longer needs `DRAKON_SHARE_TOKEN`. It has a built-in
production service URL; `DRAKON_SHARE_API_URL` remains an optional HTTPS
override for a staging service.

## Changing limits later

Edit only `DRAKON_SHARE_LIMITS_JSON` in `wrangler.jsonc`, then deploy. For
example, the current values are:

```json
{
  "trial": { "active": 3, "total": 3 },
  "educational": { "active": 10 },
  "lab": { "active": 10 },
  "commercial": { "active": 10 },
  "commercialPro": { "active": 30 }
}
```

`DRAKON_SHARE_MAX_LIVE_BYTES` is the project-wide safety ceiling. It is
currently `8589934592` (8 GiB). Existing links continue to count against the
new active-link limit until they expire; the trial lifetime counter is never
reduced by cleanup.

Objects made by the earlier, pre-quota Worker are not in the accounting store.
Allow the existing 15-day R2 lifecycle cleanup to complete before treating the
8 GiB guard as an exact total for the new service.
