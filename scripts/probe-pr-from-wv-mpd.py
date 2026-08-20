#!/usr/bin/env python3
"""Test PlayReady keys from Widevine-playback MPD (11 PR PSSH, 0 WV)."""
import base64
import json
import re
import sys
import time
import uuid
from pathlib import Path

from curl_cffi import requests

ROOT = Path(__file__).resolve().parents[1]
NO_PROXY = {"http": None, "https": None, "all": None}
ASSET = sys.argv[1] if len(sys.argv) > 1 else "emfu5j39wp8385wo18re4vq81"


def load_token():
    sess = json.loads((ROOT / "kayo-token.json").read_text(encoding="utf-8"))
    token = sess["token"]
    part = token.split(".")[1]
    part += "=" * (-len(part) % 4)
    pl = json.loads(base64.urlsafe_b64decode(part))
    return token, pl, sess.get("sessionId")


def headers(token, pl, origin="https://kayosports.com.au", device=None):
    h = {
        "Accept": "*/*",
        "Authorization": f"Bearer {token}",
        "X-BRAND": "KAYO",
        "Origin": origin,
        "Referer": origin + "/",
        "x-daznid": pl.get("user", ""),
        "x-correlation-id": str(uuid.uuid4()),
    }
    if device or pl.get("deviceId"):
        h["x-dazn-device"] = device or pl["deviceId"]
    return h


def widevine_playback(token, pl, asset, origin="https://kayosports.com.au"):
    sid = f"{int(time.time()*1000)}-{pl.get('viewerId','')}-{asset}-67BC9B"
    url = (
        "https://api.playback.indazn.com/v5/Playback"
        f"?AppVersion=0.134.1-hotfix.f7e0d40f1&DrmType=WIDEVINE&Format=MPEG-DASH"
        f"&PlayerId=%40dazn%2Fpeng-html5-core%2Ftv-next%2Ftv&Platform=webos"
        f"&Model=43UR8050PSB&Secure=true&Manufacturer=lg&PlayReadyInitiator=false"
        f"&Capabilities=4k%2Cdd%2Cddp%2Chdr%2Chevc%2Cmta&AssetId={asset}"
        f"&MtaLanguageCode&LanguageCode=en&SessionId={sid}"
    )
    r = requests.get(url, headers=headers(token, pl, origin), impersonate="chrome120", timeout=30, proxies=NO_PROXY)
    return r.status_code, r.json() if r.status_code == 200 else r.text[:200]


def extract_pr_pssh(mpd):
    boxes = []
    for m in re.finditer(
        r'<ContentProtection[^>]*schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"[^>]*>'
        r'[\s\S]*?<cenc:pssh>([^<]+)</cenc:pssh>',
        mpd,
        re.I,
    ):
        boxes.append(m.group(1).strip())
    return list(dict.fromkeys(boxes))


def extract_wv_pssh(mpd):
    boxes = []
    for m in re.finditer(
        r'<ContentProtection[^>]*schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^>]*>'
        r'[\s\S]*?<cenc:pssh>([^<]+)</cenc:pssh>',
        mpd,
        re.I,
    ):
        boxes.append(m.group(1).strip())
    return list(dict.fromkeys(boxes))


def pr_license_urls(la_url):
    """Derive PlayReady license URL candidates from playback LaUrl."""
    urls = []
    if la_url:
        urls.append(la_url)
        urls.append(la_url.replace("/widevine/", "/playready/"))
        urls.append(la_url.replace("widevine", "playready"))
        urls.append(re.sub(r"Widevine", "PlayReady", la_url))
    urls.append("https://license.drm.indazn.com/playready/v1/license")
    urls.append("https://license.drm.indazn.com/v1/playready/license")
    return list(dict.fromkeys(urls))


def try_pr_keys(pssh_b64, lic_url, token, pl):
    try:
        from pyplayready import Device, Cdm, PSSH
    except ImportError:
        return "pyplayready not installed"
    prd = ROOT / "hisense_smarttv_43a6101eu_sl3000.prd"
    if not prd.is_file():
        prd = next(ROOT.glob("**/*.prd"), None)
    if not prd:
        return "no .prd file"
    device = Device.load(str(prd))
    cdm = Cdm.from_device(device)
    sid = cdm.open()
    try:
        ch = cdm.get_license_challenge(sid, PSSH(pssh_b64))
        h = headers(token, pl)
        h["Content-Type"] = "text/xml; charset=UTF-8"
        h["SOAPAction"] = '"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"'
        r = requests.post(lic_url, headers=h, data=ch, impersonate="chrome120", timeout=30, proxies=NO_PROXY)
        if r.status_code != 200:
            return f"HTTP {r.status_code}"
        cdm.parse_license(sid, r.text)
        keys = [f"{k.key_id.hex}:{k.key.hex()}" for k in cdm.get_keys(sid)]
        return keys
    except Exception as e:
        return str(e)[:120]
    finally:
        cdm.close(sid)


def main():
    token, pl, _ = load_token()
    for origin in ["https://kayosports.com.au", "https://tv.kayosports.com.au"]:
        print(f"\n=== Widevine playback origin={origin} ===")
        code, pb = widevine_playback(token, pl, ASSET, origin)
        print("playback HTTP", code)
        if code != 200:
            continue
        for d in pb.get("PlaybackDetails", []):
            print("CDN", d.get("CdnName"))
            for k in sorted(d.keys()):
                if "url" in k.lower() or "la" in k.lower() or "drm" in k.lower() or "token" in k.lower():
                    v = d[k]
                    if isinstance(v, str) and len(v) > 200:
                        print(f"  {k}: {v[:200]}...")
                    elif k != "CdnToken":
                        print(f"  {k}: {v}")
        entry = next((d for d in pb.get("PlaybackDetails", []) if d.get("CdnName") == "dck1-fs-vod"), pb["PlaybackDetails"][0])
        mpd = entry["ManifestUrl"]
        if entry.get("CdnToken"):
            sep = "&" if "?" in mpd else "?"
            mpd += sep + entry["CdnToken"]["Name"] + "=" + entry["CdnToken"]["Value"]
        mr = requests.get(mpd, headers=headers(token, pl, origin), impersonate="chrome120", timeout=30, proxies=NO_PROXY)
        print("MPD HTTP", mr.status_code, "len", len(mr.text))
        pr = extract_pr_pssh(mr.text)
        wv = extract_wv_pssh(mr.text)
        heights = sorted(set(int(x) for x in re.findall(r'height="(\d+)"', mr.text)))
        print("heights", heights, "pr_pssh", len(pr), "wv_pssh", len(wv))
        la = entry.get("LaUrl") or pb.get("LaUrl") or entry.get("PlayReadyLaUrl") or pb.get("PlayReadyLaUrl")
        print("LaUrl", la)
        if pr and la:
            for lic in pr_license_urls(la)[:4]:
                print(f"  try PR license {lic[:80]}...")
                res = try_pr_keys(pr[0], lic, token, pl)
                print("   ->", res if isinstance(res, str) else f"{len(res)} keys: {res[:2]}")


if __name__ == "__main__":
    main()
