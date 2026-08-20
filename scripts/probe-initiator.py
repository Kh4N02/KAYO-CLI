#!/usr/bin/env python3
"""Probe PlayReadyInitiator + Download API + lite-playback for 4K."""
import base64
import json
import re
import time
import uuid
from pathlib import Path

from curl_cffi import requests

ROOT = Path(__file__).resolve().parents[1]
NO_PROXY = {"http": None, "https": None, "all": None}
ASSET = "emfu5j39wp8385wo18re4vq81"

sess = json.loads((ROOT / "kayo-token.json").read_text(encoding="utf-8"))
TOKEN = sess["token"]
part = TOKEN.split(".")[1]
part += "=" * (-len(part) % 4)
PL = json.loads(base64.urlsafe_b64decode(part))


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


def mpd_max(pb):
    entry = next((d for d in pb.get("PlaybackDetails", []) if d.get("ManifestUrl")), None)
    if not entry:
        return "no entry"
    mpd = entry["ManifestUrl"]
    if entry.get("CdnToken"):
        sep = "&" if "?" in mpd else "?"
        mpd += sep + entry["CdnToken"]["Name"] + "=" + entry["CdnToken"]["Value"]
    r = requests.get(mpd, headers=hdr(), impersonate="chrome120", timeout=30, proxies=NO_PROXY)
    if r.status_code != 200:
        return f"mpd {r.status_code}"
    h = [int(x) for x in re.findall(r'height="(\d+)"', r.text)]
    return f"max={max(h) if h else 0} la={entry.get('LaUrl','')[:60]}"


sid = f"{int(time.time()*1000)}-{PL.get('viewerId','')}-{ASSET}-67BC9B"

# 1. PlayReadyInitiator
print("=== PlayReadyInitiator ===")
for url in [
    "https://pr.playback.indazn.com/v2/PlayreadyInitiator",
    f"https://pr.playback.indazn.com/v2/PlayreadyInitiator?AssetId={ASSET}&SessionId={sid}",
]:
    for method in ["GET", "POST"]:
        r = requests.request(method, url, headers={**hdr(), "Content-Type": "application/json"},
                             json={"AssetId": ASSET, "SessionId": sid} if method == "POST" else None,
                             impersonate="chrome120", timeout=30, proxies=NO_PROXY)
        print(f"  {method} {url.split('.com')[1][:40]} -> {r.status_code} {r.text[:100]}")

# 2. Download API
print("\n=== Download API ===")
for base in [
    "https://api.playback.indazn.com/v2/Download",
    "https://api.playback.indazn.com/v1/Download",
]:
    params = {
        "AppVersion": "0.134.1-hotfix.f7e0d40f1",
        "AssetId": ASSET,
        "DrmType": "PLAYREADY",
        "Format": "MPEG-DASH",
        "Platform": "vidaa",
        "SessionId": sid,
    }
    r = requests.get(f"{base}?{__import__('urllib.parse').parse.urlencode(params)}", headers=hdr(), impersonate="chrome120", timeout=30, proxies=NO_PROXY)
    print(f"  GET {base.split('/')[-2]} -> {r.status_code} {r.text[:120]}")

# 3. Lite playback
print("\n=== Lite Playback ===")
r = requests.get(
    f"https://lite-playback.dtcdn.dazn.com/v1/Lite?AssetId={ASSET}&DrmType=PLAYREADY&Platform=webos",
    headers=hdr(), impersonate="chrome120", timeout=30, proxies=NO_PROXY,
)
print(f"  lite -> {r.status_code} {r.text[:150]}")

# 4. PlayReady GET after initiator cookie simulation with tv origin + random device
print("\n=== PlayReady GET tv origin random device ===")
dev = "00" + str(uuid.uuid4()).split("-")[4][2:]
h = hdr("https://tv.kayosports.com.au")
h["x-dazn-device"] = dev
url = (
    "https://api.playback.indazn.com/v5/Playback"
    f"?AppVersion=0.134.1-hotfix.f7e0d40f1&DrmType=PLAYREADY&Format=MPEG-DASH"
    f"&PlayerId=%40dazn%2Fpeng-html5-core%2Ftv-next%2Ftv&Platform=webos"
    f"&Model=43UR8050PSB&Secure=true&Manufacturer=lg&PlayReadyInitiator=true"
    f"&Capabilities=4k%2Cdd%2Cddp%2Chdr%2Chevc%2Cmta&AssetId={ASSET}"
    f"&MtaLanguageCode&LanguageCode=en&SessionId={sid}"
)
r = requests.get(url, headers=h, impersonate="chrome120", timeout=30, proxies=NO_PROXY)
print(f"  PR initiator=true -> {r.status_code}")
if r.status_code == 200:
    print(" ", mpd_max(r.json()))

# 5. DPP playback data
print("\n=== DPP ===")
r = requests.get(f"https://dpp.playback.indazn.com/v1/data?AssetId={ASSET}", headers=hdr(), impersonate="chrome120", timeout=30, proxies=NO_PROXY)
print(f"  dpp -> {r.status_code} {r.text[:200]}")
