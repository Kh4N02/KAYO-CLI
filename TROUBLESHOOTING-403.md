# HTTP 403 on Kayo (Playback / CDN)

Reddit threads about **Nuvio + TorBox** often fix 403 with **DNS whitelisting** and **switching CDN**. Kayo is different (no TorBox), but the same *ideas* apply.

## Not the same app

| Reddit (TorBox) | Kayo CLI |
|-----------------|----------|
| TorBox CDN (`*.tb-cdn.*`) | Kayo CDNs `dck1-ac-vod`, `dck1-fs-vod`, live variants |
| TorBox account “change CDN” | Pick CDN via env + automatic probe (see below) |
| Torrentio / Nuvio | `kayo.cmd` + Python playback + N_m3u8DL |

TorBox whitelist URLs do **not** help Kayo.

## 1. Whitelist / don’t block (DNS, router, AV, VPN “threat protection”)

If **AdGuard**, **NextDNS**, **Pi-hole**, **CleanWeb**, **NetShield**, ISP “security”, etc. block streaming CDNs, you get **403**, **SSL errors**, or “source blocked” in players.

Allow (or disable filtering for) at least:

- `kayosports.com.au` and `www.kayosports.com.au`
- `tv.kayosports.com.au`
- `*.indazn.com` (especially `api.playback.indazn.com`, `authentication-prod.ar.indazn.com`, `user-profile.ar.indazn.com`)
- Kayo manifest/segment hosts (CloudFront / DAZN CDN — hostnames come from the MPD, often `*.cloudfront.net` and `dck1-*` paths)

**Clash / TUN:** use an **AU** exit. Blocking `indazn.com` while allowing `kayosports.com.au` causes **Playback API 403** with a CloudFront HTML page.

Quick check:

```powershell
node scripts/kayo-connectivity-check.js
```

## 2. “Change CDN” (Kayo equivalent)

TorBox lets you pick a CDN in the account. Kayo returns several CDNs in one playback response; this repo **probes init-segment auth** and picks the first that works.

Default VOD order: **`dck1-ac-vod`** then **`dck1-fs-vod`**. UHD/F1 often works on **ac-vod**.

Force the other CDN (like switching source in a debrid app):

```env
# Prefer fs-vod first (1080p catchup sometimes better on fs)
KAYO_VOD_CDN=fs-vod

# Or explicitly ac-vod first (common for 4K)
KAYO_VOD_CDN=ac-vod
```

If one CDN fails mid-download, re-run; UHD/live paths already **try the next CDN** when keys/manifest fail.

## 3. “No key found” / **10-000-000** / **97-000** (login page)

This is **Kayo’s website failing during sign-in**, not “we couldn’t decrypt 4K.” Kayo’s help text: refresh, clear cache, another browser — often it’s **network/VPN**.

Typical causes when **1080p CLI still works** but **browser login** shows this:

- **Two VPNs at once** — e.g. ExpressVPN/Nord **and** Clash **TUN** (or `KAYO_BROWSER_PROXY=127.0.0.1:7897` on top of system VPN).
- **Corporate / DNS filter** blocking DAZN auth or crypto scripts.
- **Stale Playwright profile** — delete folder **`.kayo-browser-profile`** in this repo and retry.

**Fastest bypass for the CLI:** log in on **normal Chrome** (one AU connection, no Clash HTTP proxy on the browser if you can):

1. Open `https://kayosports.com.au` → sign in → play any video.
2. DevTools → Network → filter `indazn` → copy **`Authorization: Bearer …`** from any request.
3. Put the JWT in `.env` as **`KAYO_TOKEN=eyJ...`** (no `Bearer` prefix).
4. Run **`kayo.cmd`** again — 1080p keeps working; 4K still needs Playback API **200** on webOS/4K profiles (see §4 below).

Fix `.env`: **`KAYO_BROWSER_PROXY=1` is invalid** — use `127.0.0.1:7897`, `0`, or remove the line and set **`KAYO_BROWSER_NO_PROXY=1`** when the browser should use system VPN only.

## 4. “Premium” but 4K dead while 1080p works

This is usually **not** the CDM (`.prd` / `.wvd`). Check in order:

1. **Run** `node scripts/kayo-connectivity-check.js` — the **SignIn + 1080p vs 4K** section at the bottom.
2. **`DAZN isn't available via VPN` (code 10075)** — your Clash/Webshare **AU datacenter IP** is flagged. Kayo **home** can still return 301 while **SignIn and 4K Playback GET fail**. 1080p may still work if you logged in via **Chrome/Playwright** earlier (`kayo-token.json`) using the **web Widevine** profile only (max 1080p on the MPD).
3. **`allow4k=true` in JWT but Playback 200 with no 2160p** — try another household profile (`python scripts/kayo-profile-playback-test.py <assetId>`) or **`KAYO_UHD_PROFILE=webos-widevine`** after auth works.
4. **Direct `KAYO_PROXY` from Python** — often `CONNECT aborted` on Windows; use **`KAYO_PROXY_TUNNEL=127.0.0.1:7897`** only.

**Workarounds for 10075:** rotate **KAYO-AU** node in Clash; sign in with **`KAYO_BROWSER_HEADLESS=0`** and complete Kayo in the opened Chrome; paste **`KAYO_TOKEN`** from DevTools (any `indazn.com` request) into `.env`; use a **residential AU** exit if Webshare stays blocked.

## 5. Playback API 403 vs segment 403

| Symptom | Likely cause |
|---------|----------------|
| `Playback API HTTP 403` (HTML “request could not be satisfied”) | AU IP / CloudFront / WAF — fix **VPN/Clash AU**, refresh token, browser WAF retry |
| MPD OK but N_m3u8DL **403 on segments** | CDN token, wrong CDN, or DNS blocking CDN — try **`KAYO_VOD_CDN`**, keep bridge running |
| Worked yesterday, nothing today | Proxy IP rotated, token expired, or DNS filter updated — run `kayo.cmd` login again, test proxies |

## 6. Useful commands

```powershell
# AU proxy + playback probe (all household profiles when SignIn works)
python scripts/kayo-profile-playback-test.py 47lg4yrp7l7j1p9432wz832v3

# UHD + CDM (SL2000 .prd + L1 .wvd)
node scripts/test-uhd-cdm-compare.js 47lg4yrp7l7j1p9432wz832v3
```

## 7. Clash Verge profile (fixed for Kayo)

Import **`configs/clash-verge-kayo.yaml`** (in this repo on your PC):

1. Clash Verge → **Profiles** → **Import** → select that file → **Activate**.
2. **Home** → turn on **System Proxy** and **TUN** (if you use TUN).
3. **Proxies** tab → confirm **KAYO-AU** picked an AU node (url-test).
4. **Settings** → Port Config **7897** (matches `mixed-port` in the yaml and `.env`).

Changes vs a single `mode: global` + `MATCH,GLOBAL` list:

- **`mode: rule`** — Kayo domains use **KAYO-AU** only; other sites use **GLOBAL** (default **DIRECT**).
- **DNS fallback `geoip-code: AU`** for `indazn.com` resolution.
- **Port 7897** aligned with `KAYO_PROXY_TUNNEL` / `KAYO_BROWSER_PROXY`.

If your Verge port is **7890**, either change Verge to **7897** or set `.env` tunnel to `127.0.0.1:7890`.

## 8. `.env` reminders

- `KAYO_PROXY` — AU Webshare `host:port:user:pass`
- `KAYO_PROXY_TUNNEL=127.0.0.1:7897` — Clash HTTP (Python + browser WAF)
- `KAYO_BROWSER_PROXY=127.0.0.1:7897` — Playwright through Clash
- `KAYO_BROWSER_HEADLESS=0` — visible Chrome for WAF when curl gets 403
