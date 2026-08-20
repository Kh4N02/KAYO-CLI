#!/usr/bin/env python3
"""Test PlayReady via Webshare AU proxy + hunt UHD contentId."""
import base64
import json
import os
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

from curl_cffi import requests

ROOT = Path(__file__).resolve().parents[1]


def load_dotenv():
    path = ROOT / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if k.strip() and k.strip() not in os.environ:
            os.environ[k.strip()] = v.strip()


load_dotenv()
NO_PROXY = {"http": None, "https": None, "all": None}
PROXY_URL = os.environ.get("KAYO_PROXY", "")
TUNNEL = os.environ.get("KAYO_PROXY_TUNNEL", "127.0.0.1:7897")
PROXIES_AU = {"http": PROXY_URL, "https": PROXY_URL} if PROXY_URL else None
PROXIES_TUN = {"http": f"http://{TUNNEL}", "https": f"http://{TUNNEL}"}

sess = json.loads((ROOT / "kayo-token.json").read_text(encoding="utf-8"))
TOKEN = sess["token"]
part = TOKEN.split(".")[1]
part += "=" * (-len(part) % 4)
PL = json.loads(base64.urlsafe_b64decode(part))
ASSET = "emfu5j39wp8385wo18re4vq81"


def hdr(origin="https://tv.kayosports.com.au"):
    return {
        "Accept": "*/*",
        "Authorization": f"Bearer {TOKEN}",
        "X-BRAND": "KAYO",
        "Origin": origin,
        "Referer": origin + "/",
        "x-dazn-device": PL.get("deviceId", str(uuid.uuid4())),
        "x-daznid": PL.get("user", ""),
        "x-correlation-id": str(uuid.uuid4()),
    }


def pr_get(proxies, label):
    sid = f"{int(time.time()*1000)}-{PL.get('viewerId','')}-{ASSET}-67BC9B"
    params = urlencode({
        "AppVersion": "0.134.1-hotfix.f7e0d40f1",
        "DrmType": "PLAYREADY",
        "Format": "MPEG-DASH",
        "PlayerId": "@dazn/peng-html5-core/tv-next/tv",
        "Platform": "webos",
        "Model": "43UR8050PSB",
        "Secure": "true",
        "Manufacturer": "lg",
        "PlayReadyInitiator": "false",
        "Capabilities": "4k,dd,ddp,hdr,hevc,mta",
        "AssetId": ASSET,
        "MtaLanguageCode": "",
        "LanguageCode": "en",
        "SessionId": sid,
    })
    url = f"https://api.playback.indazn.com/v5/Playback?{params}"
    r = requests.get(url, headers=hdr(), impersonate="chrome120", timeout=45, proxies=proxies)
    print(f"  PR GET [{label}]: HTTP {r.status_code}", r.text[:80].replace("\n", " "))
    if r.status_code == 200:
        pb = r.json()
        entry = (pb.get("PlaybackDetails") or [{}])[0]
        la = entry.get("LaUrl", "")
        print("    LaUrl contentId snippet:", re.search(r"contentId=([^&]+)", la or "") and la[la.find("contentId="):la.find("contentId=")+80])
        mpd = entry.get("ManifestUrl", "")
        if entry.get("CdnToken"):
            sep = "&" if "?" in mpd else "?"
            mpd += sep + entry["CdnToken"]["Name"] + "=" + entry["CdnToken"]["Value"]
        mr = requests.get(mpd, headers=hdr(), impersonate="chrome120", timeout=30, proxies=proxies)
        if mr.status_code == 200:
            h = [int(x) for x in re.findall(r'height="(\d+)"', mr.text)]
            print("    MPD max height:", max(h) if h else 0)


print("=== PlayReady via proxy variants ===")
pr_get(NO_PROXY, "NO_PROXY/system VPN")
if PROXIES_AU:
    pr_get(PROXIES_AU, "KAYO_PROXY Webshare")
pr_get(PROXIES_TUN, "Clash tunnel")

print("\n=== Widevine with quality hints ===")
sid = f"{int(time.time()*1000)}-{PL.get('viewerId','')}-{ASSET}-67BC9B"
extra_params = [
    ("baseline", {}),
    ("VideoQuality-UHD", {"VideoQuality": "UHD"}),
    ("MaxHeight-2160", {"MaxHeight": "2160"}),
    ("Quality-UHD", {"Quality": "UHD"}),
    ("RequestedFormat-4k", {"RequestedFormat": "4k"}),
]
for name, extra in extra_params:
    base = {
        "AppVersion": "0.134.1-hotfix.f7e0d40f1",
        "DrmType": "WIDEVINE",
        "Format": "MPEG-DASH",
        "PlayerId": "@dazn/peng-html5-core/tv-next/tv",
        "Platform": "webos",
        "Model": "43UR8050PSB",
        "Secure": "true",
        "Manufacturer": "lg",
        "PlayReadyInitiator": "false",
        "Capabilities": "4k,dd,ddp,hdr,hevc,mta",
        "AssetId": ASSET,
        "MtaLanguageCode": "",
        "LanguageCode": "en",
        "SessionId": sid,
        **extra,
    }
    url = f"https://api.playback.indazn.com/v5/Playback?{urlencode(base)}"
    r = requests.get(url, headers=hdr("https://kayosports.com.au"), impersonate="chrome120", timeout=30, proxies=NO_PROXY)
    if r.status_code != 200:
        print(f"  {name}: HTTP {r.status_code}")
        continue
    la = (r.json().get("PlaybackDetails") or [{}])[0].get("LaUrl", "")
    cid = re.search(r"contentId=([^&]+)", la)
    print(f"  {name}: {cid.group(1)[:70] if cid else 'no la'}")

print("\n=== Asset discovery tile ===")
for ep in [
    f"https://rail-router.discovery.indazn.com/eu/v10/Rail?id=Livetvschedule&country=au&languageCode=en&platform=web&brand=kayo",
]:
    r = requests.get(ep, headers=hdr(), impersonate="chrome120", timeout=30, proxies=NO_PROXY)
    if r.status_code != 200:
        continue
    text = r.text
    if ASSET in text:
        idx = text.find(ASSET)
        print(text[max(0, idx - 400):idx + 400])
