# Friend setup — everything in the repo (temporary)

Use this when `.env` and `cmds/` are included in the clone. **Delete them from GitHub after your friend has downloaded** (see bottom).

## 1. Install once (cannot be bundled in git)

| Install | Link / command |
|---------|----------------|
| **Node.js 20+** | https://nodejs.org — LTS, default options |
| **Python 3.10+** | https://www.python.org/downloads — tick **Add python.exe to PATH** |
| **Google Chrome** | https://www.google.com/chrome/ |
| **N_m3u8DL-RE** | On PATH, **or** set `KAYO_NM3U8DL=D:\path\N_m3u8DL-RE.exe` in `.env` |
| **mp4decrypt + mkvmerge** | On PATH (N_m3u8DL uses them for decrypt/mux) |
| **Clash / VPN** | AU exit, HTTP port in `.env` (`KAYO_PROXY_TUNNEL`) |

Quick install (Windows, if `winget` works):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Python.Python.3.12
```

Open a **new** PowerShell after installing.

## 2. Clone and run

```powershell
git clone https://github.com/Kh4N02/KAYO-CLI.git
cd KAYO-CLI
```

Double-click **`kayo.cmd`** (or `node kayo_cmd.js`).

First launch installs npm packages, Playwright Chrome, and Python libs (`pyplayready`, `pywidevine`, `curl_cffi`).

**Downloads:** kayo_cmd auto-launches **N_m3u8DL-RE** in a new cmd window. A tiny local **CDN bridge** (Python) starts automatically — no extra setup. Keep Clash/VPN on (AU).

**Optional `.env` paths** (only if defaults fail on your PC):

```env
KAYO_NM3U8DL=D:\Tools\N_m3u8DL-RE.exe
KAYO_DOWNLOAD_DIR=D:\Downloads\Kayo
KAYO_PYTHON=python
KAYO_DOWNLOADER=python
```

`KAYO_DOWNLOADER=python` skips N_m3u8DL and uses the built-in Python downloader instead.

## 3. Before first use

1. Start Clash/VPN (Australian exit).
2. Set Clash HTTP port in `.env` if not `7897` → `KAYO_PROXY_TUNNEL=127.0.0.1:YOUR_PORT`
3. If login fails, delete `kayo-token.json` and run again.

## 4. After your friend has the folder — remove secrets from GitHub

**Important:** Git history keeps old commits. Make the repo **private** before pushing secrets, and rotate Kayo password + proxy password after cleanup.

On your PC:

```powershell
cd KAYO-CLI

# Stop tracking secrets (keeps local copies)
git rm --cached .env
git rm -r --cached cmds/

# Restore gitignore (see repo .gitignore)
git commit -m "Remove shared credentials and device files from repo"
git push origin main
```

Friend keeps their local `.env` and `cmds/` — they do not need to pull that commit for daily use.

Optional: change Kayo password and Webshare proxy password after removal.
