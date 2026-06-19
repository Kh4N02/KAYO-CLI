# Kayo CLI — setup (friends)

Private repo: [github.com/Kh4N02/KAYO-CLI](https://github.com/Kh4N02/KAYO-CLI)

## Clone

```powershell
git clone https://github.com/Kh4N02/KAYO-CLI.git
cd KAYO-CLI
```

## First run on a new PC (do this before anything else)

If you copied files from another machine, or the app fails to start / auth / WAF:

1. **Delete** the folder `.kayo-browser-profile` (if it exists).
2. **Delete** the file `kayo-token.json` (if it exists).

Those are tied to one PC/session. Kayo will create fresh ones on the next run using your `.env` login.

```powershell
Remove-Item -Recurse -Force .kayo-browser-profile -ErrorAction SilentlyContinue
Remove-Item -Force kayo-token.json -ErrorAction SilentlyContinue
```

## What is in the repo vs what you add locally

| Included in git | You add on each PC |
|-----------------|-------------------|
| Source code, `vendor/`, `kayo.cmd` | `node_modules/` → `npm install` |
| `.env` (shared proxy + login) | `cmds/` — `.prd` + `.wvd` (4K PlayReady keys) |
| `requirements.txt` | `py -3.12 -m pip install -r requirements.txt` |
| `.env.example` (reference only) | Playwright Chrome → `npx playwright install chrome` |
| | N_m3u8DL-RE (separate download) |

**Not in git (ignored):** `kayo-token.json`, `.kayo-browser-profile/`, `cmds/`, `keys.txt`, `node_modules/`, `data/live-tv-rail.json` (runtime cache).

If Clash port differs on a friend’s PC, edit `KAYO_PROXY_TUNNEL` in `.env` only.

## 1. Prerequisites

| Tool | Notes |
|------|--------|
| **Git** | To clone the repo |
| **Node.js 20+** | [nodejs.org](https://nodejs.org) |
| **Python 3.12** | `py -3.12` on Windows |
| **Google Chrome** | Playwright uses it for Kayo WAF |
| **N_m3u8DL-RE** | Paste printed commands into your install |
| **AU VPN / Clash** | Webshare proxy in `.env`; tunnel on `KAYO_PROXY_TUNNEL` |

## 2. One-time install

```powershell
npm install
npx playwright install chrome
py -3.12 -m pip install -r requirements.txt
```

`.env` is already in the repo — no copy step. Edit `KAYO_PROXY_TUNNEL` if your Clash port is not `7897`.

Or double-click **`kayo.cmd`** (runs npm + Playwright + Python deps on first launch).

Put PlayReady/Widevine device files in **`cmds/`** (see friend who shared the folder).

## 3. Proxy / VPN

1. Start Clash (or similar) with an **Australian** exit matching your Webshare IP.
2. Set `KAYO_PROXY_TUNNEL` in `.env` to your local HTTP port (e.g. `127.0.0.1:7897`).

If playback fails with WAF errors:

```powershell
$env:KAYO_BROWSER_HEADLESS="0"
node kayo_cmd.js
```

Log into Kayo in the Chrome window if prompted, then close and run normally again.

## 4. Run

```powershell
node kayo_cmd.js
```

or double-click **`kayo.cmd`**.

**4K UHD Events** — first open scans all Kayo rails (~2 minutes). Expect **~130** UHD items when the scan completes.

**Search Kayo** — same search as the Kayo website (type a query, e.g. `Pakistan Australia`).

**Cricket replays** — **All Cricket Replays** loads ~2 years of cricket from rails + EPG. Some older T20 UHD replays (e.g. Nov 2024 Aus v Pak) are tagged via `data/cricket-uhd-supplement.json` when Kayo’s rails do not show a 4K badge.

## 5. Using the menu

1. Pick a category (Live TV, EPG, **4K UHD Events**, **Search Kayo**, sport replays, **All Cricket Replays**, **4K UHD Cricket**, etc.).
2. Pick an event — **UHD** badge (magenta) = 4K; **HD** (cyan) = 1080p. Dates include the year.
3. Wait for MPD + keys (headless Chrome + local Python CDM).
4. Copy the **N_m3u8DL-RE** command.
5. **VOD:** pick video/audio in N_m3u8DL (e.g. 2160p).
6. **Live:** command pins 1080p; use printed start/end on the URL if needed.

### 4K test

**4K UHD Events → Monaco Race** — asset `b9ngas16fad1o4st5jji5d113`  
Expect **2160p**, **4 PlayReady keys**.

## 6. Troubleshooting

| Problem | Fix |
|---------|-----|
| Won’t start / weird auth / WAF | Delete `.kayo-browser-profile` and `kayo-token.json`, re-run |
| `No module named pyplayready` | `py -3.12 -m pip install -r requirements.txt` |
| Device files missing | Add `.prd` and `.wvd` to `cmds/` |
| Token expired | Delete `kayo-token.json`, re-run (uses `.env` login) |
| MPD 401 / WAF | VPN on, Clash tunnel up, maybe headless=0 login |
| UHD mux fails | Use all `--key` lines (4 for 4K) |
| 4K list looks short | Wait for full rail scan (~2 min) or restart `kayo.cmd` |

## 7. N_m3u8DL path

Prefix your install path, e.g.:

`D:\Downloads\N_m3u8DL-RE_Beta_win-x64\N_m3u8DL-RE.exe` + rest of printed command.
