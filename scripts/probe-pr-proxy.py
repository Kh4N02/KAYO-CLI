#!/usr/bin/env python3
"""Test PlayReady GET via Clash tunnel (formatted proxy URL)."""
import base64
import json
import os
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor"))

from curl_cffi import requests

# load .env
env_path = ROOT / ".env"
if env_path.is_file():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            if k.strip() not in os.environ:
                os.environ[k.strip()] = v.strip()

try:
    from proxy_parse import parse_custom_proxy
except ImportError:
    def parse_custom_proxy(spec):
        spec = (spec or "").strip()
        if not spec:
            return None
        parts = spec.split(":")
        if len(parts) >= 4:
            host, port, user, pwd = parts[0], parts[1], parts[2], ":".join(parts[3:])
            return f"http://{user}:{pwd}@{host}:{port}"
        if spec.startswith("http"):
            return spec
        return f"http://{spec}"

TUNNEL = os.environ.get("KAYO_PROXY_TUNNEL", "127.0.0.1:7897")
WEBSHARE = os.environ.get("KAYO_PROXY", "")
ASSET = "emfu5j39wp8385wo18re4vq81"

sess = json.loads((ROOT / "kayo-token.json").read_text(encoding="utf-8"))
TOKEN = sess["token"]
part = TOKEN.split(".")[1]
part += "=" * (-len(part) % 4)
PL = json.loads(base64.urlsafe_b64decode(part))


def hdr():
    return {
        "Accept": "*/*",
        "Authorization": f"Bearer {TOKEN}",
        "X-BRAND": "KAYO",
        "Origin": "https://tv.kayosports.com.au",
        "Referer": "https://tv.kayosports.com.au/",
        "x-dazn-device": PL.get("deviceId", str(uuid.uuid4())),
        "x-daznid": PL.get("user", ""),
        "x-correlation-id": str(uuid.uuid4()),
    }


def pr_url():
    sid = f"{int(time.time()*1000)}-{PL.get('viewerId','')}-{ASSET}-67BC9B"
    return (
        "https://api.playback.indazn.com/v5/Playback?"
        + urlencode({
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
    )


def test(label, proxy_url):
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else {"http": None, "https": None, "all": None}
    try:
        r = requests.get(pr_url(), headers=hdr(), impersonate="chrome120", timeout=45, proxies=proxies)
        print(f"{label}: HTTP {r.status_code} {r.text[:80].replace(chr(10),' ')}")
    except Exception as e:
        print(f"{label}: ERR {str(e)[:100]}")


print("=== PlayReady via proxy routes ===")
test("NO_PROXY (system VPN)", None)
test("Clash tunnel", parse_custom_proxy(TUNNEL) or f"http://{TUNNEL}")
test("Webshare AU", parse_custom_proxy(WEBSHARE))
