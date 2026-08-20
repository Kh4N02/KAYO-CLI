#!/usr/bin/env python3
"""Deep probe for 4K paths: JWT paths, MPD analysis, PlayReady from MPD PSSH."""
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
    return token, pl


def hdr(token, pl, device_id=None):
    h = {
        "Accept": "*/*",
        "Authorization": f"Bearer {token}",
        "X-BRAND": "KAYO",
        "Origin": "https://kayosports.com.au",
        "Referer": "https://kayosports.com.au/",
        "x-daznid": pl.get("user", ""),
        "x-correlation-id": str(uuid.uuid4()),
    }
    if device_id is not None:
        h["x-dazn-device"] = device_id
    elif pl.get("deviceId"):
        h["x-dazn-device"] = pl["deviceId"]
    return h


def session_id(pl, asset):
    viewer = pl.get("viewerId", "")
    return f"{int(time.time() * 1000)}-{viewer}-{asset}-67BC9B"


def playback_get(token, pl, asset, drm="WIDEVINE", platform="webos"):
    sid = session_id(pl, asset)
    url = (
        "https://api.playback.indazn.com/v5/Playback"
        f"?AppVersion=0.134.1-hotfix.f7e0d40f1"
        f"&DrmType={drm}&Format=MPEG-DASH"
        f"&PlayerId=%40dazn%2Fpeng-html5-core%2Ftv-next%2Ftv"
        f"&Platform={platform}&Model=43UR8050PSB&Secure=true&Manufacturer=lg"
        f"&PlayReadyInitiator=false"
        f"&Capabilities=4k%2Cdd%2Cddp%2Chdr%2Chevc%2Cmta"
        f"&AssetId={asset}&MtaLanguageCode&LanguageCode=en&SessionId={sid}"
    )
    r = requests.get(url, headers=hdr(token, pl), impersonate="chrome120", timeout=30, proxies=NO_PROXY)
    return r.status_code, r


def jwt_paths(cdn_token_value):
    if not cdn_token_value or "." not in cdn_token_value:
        return None
    part = cdn_token_value.split(".")[1]
    part += "=" * (-len(part) % 4)
    payload = json.loads(base64.urlsafe_b64decode(part))
    return payload.get("paths"), payload


def build_mpd_urls(entry):
    urls = []
    base = entry.get("ManifestUrl", "")
    tok = entry.get("CdnToken") or {}
    if base and tok.get("Value"):
        sep = "&" if "?" in base else "?"
        urls.append(("manifest", base + sep + tok["Name"] + "=" + tok["Value"]))
    paths, _ = jwt_paths(tok.get("Value", ""))
    if paths and base:
        try:
            host = re.match(r"https?://([^/]+)", base).group(1)
        except Exception:
            host = None
        if host:
            for i, p in enumerate(paths):
                path = str(p).rstrip("/")
                if path.startswith("/out/v1/"):
                    urls.append((f"jwt_path_{i}", f"https://{host}{path}/index.mpd?{tok['Name']}={tok['Value']}"))
    return urls


def analyze_mpd(text):
    heights = sorted(set(int(x) for x in re.findall(r'height="(\d+)"', text)))
    codecs = sorted(set(re.findall(r'codecs="([^"]+)"', text)))
    pr_pssh = len(re.findall(r"urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", text))
    wv_pssh = len(re.findall(r"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", text))
    laurls = list(
        dict.fromkeys(
            re.findall(r'https?://[^"\'<>\s]+', text)
        )
    )
    laurls = [u for u in laurls if "license" in u.lower() or "playready" in u.lower() or "widevine" in u.lower()]
    return {
        "heights": heights,
        "max_h": max(heights) if heights else 0,
        "codecs": codecs[:8],
        "pr_pssh": pr_pssh,
        "wv_pssh": wv_pssh,
        "laurls": laurls[:5],
    }


def test_playready_devices(token, pl, asset):
    print("\n=== PlayReady device ID variants ===")
    sid = session_id(pl, asset)
    base = (
        "https://api.playback.indazn.com/v5/Playback"
        f"?AppVersion=0.134.1-hotfix.f7e0d40f1&DrmType=PLAYREADY&Format=MPEG-DASH"
        f"&PlayerId=%40dazn%2Fpeng-html5-core%2Ftv-next%2Ftv&Platform=webos"
        f"&Model=43UR8050PSB&Secure=true&Manufacturer=lg&PlayReadyInitiator=false"
        f"&Capabilities=4k%2Cdd%2Cddp%2Chdr%2Chevc%2Cmta&AssetId={asset}"
        f"&MtaLanguageCode&LanguageCode=en&SessionId={sid}"
    )
    variants = [
        ("token-device", pl.get("deviceId", "")),
        ("random-uuid", str(uuid.uuid4())),
        ("no-device-header", None),
    ]
    for label, dev in variants:
        h = hdr(token, pl)
        if dev is None:
            h.pop("x-dazn-device", None)
        elif dev:
            h["x-dazn-device"] = dev
        r = requests.get(base, headers=h, impersonate="chrome120", timeout=30, proxies=NO_PROXY)
        print(f"  {label}: HTTP {r.status_code} {r.text[:80]}")


def test_platforms(token, pl, asset):
    print("\n=== Widevine platform variants ===")
    for platform in ["webos", "web", "chromecast", "androidtv", "tizen", "firetv", "hubbl"]:
        code, r = playback_get(token, pl, asset, drm="WIDEVINE", platform=platform)
        if code != 200:
            print(f"  {platform}: HTTP {code}")
            continue
        pb = r.json()
        for d in pb.get("PlaybackDetails", []):
            cdn = d.get("CdnName")
            urls = build_mpd_urls(d)
            for label, mpd_url in urls[:2]:
                mr = requests.get(mpd_url, headers=hdr(token, pl), impersonate="chrome120", timeout=30, proxies=NO_PROXY)
                info = analyze_mpd(mr.text) if mr.status_code == 200 else {}
                print(f"  {platform}/{cdn}/{label}: HTTP {mr.status_code} max={info.get('max_h',0)} pr={info.get('pr_pssh',0)}")


def test_jwt_all_paths(token, pl, asset):
    print("\n=== JWT path enumeration ===")
    code, r = playback_get(token, pl, asset)
    if code != 200:
        print(f"  playback failed {code}")
        return
    pb = r.json()
    for d in pb.get("PlaybackDetails", []):
        cdn = d.get("CdnName")
        tok_val = (d.get("CdnToken") or {}).get("Value", "")
        paths, payload = jwt_paths(tok_val) or ([], {})
        print(f"  CDN {cdn}: {len(paths or [])} jwt paths, payload keys={list(payload.keys())}")
        for label, url in build_mpd_urls(d):
            mr = requests.get(url, headers=hdr(token, pl), impersonate="chrome120", timeout=30, proxies=NO_PROXY)
            info = analyze_mpd(mr.text) if mr.status_code == 200 else {}
            print(f"    {label}: HTTP {mr.status_code} max_h={info.get('max_h')} heights={info.get('heights')} la={info.get('laurls')}")


def test_playready_post(token, pl, asset):
    print("\n=== PlayReady POST body variants ===")
    sid = session_id(pl, asset)
    url = "https://api.playback.indazn.com/v5/Playback"
    bodies = [
        {"AssetId": asset, "DrmType": "PLAYREADY", "Format": "MPEG-DASH", "Platform": "webos", "SessionId": sid},
        {"AssetId": asset, "DrmType": "PLAYREADY", "Format": "MPEG-DASH", "Platform": "web", "PlayerId": "@dazn/peng-html5-core/web/production/web", "SessionId": sid},
    ]
    for i, body in enumerate(bodies):
        h = hdr(token, pl)
        h["Content-Type"] = "application/json"
        r = requests.post(url, headers=h, json=body, impersonate="chrome120", timeout=30, proxies=NO_PROXY)
        print(f"  body{i}: HTTP {r.status_code} {r.text[:100]}")


def test_startup_playback(token):
    print("\n=== Startup config playback hints ===")
    u = "https://startup.core.indazn.com/v1/main/web?Platform=web&LandingPageKey=generic&Brand=kayo"
    r = requests.get(u, headers={"Authorization": f"Bearer {token}", "X-BRAND": "KAYO"}, impersonate="chrome120", timeout=30, proxies=NO_PROXY)
    if r.status_code != 200:
        print(f"  startup HTTP {r.status_code}")
        return
    data = r.json()
    text = json.dumps(data)
    for pat in ["playback", "PlayReady", "playready", "2160", "4k", "UHD", "DrmType"]:
        if pat.lower() in text.lower():
            print(f"  found '{pat}' in startup JSON")
    # dig for service URLs
    def walk(obj, prefix=""):
        if isinstance(obj, dict):
            for k, v in obj.items():
                p = f"{prefix}.{k}" if prefix else k
                if isinstance(v, str) and ("playback" in v.lower() or "license" in v.lower()):
                    print(f"  {p}: {v[:120]}")
                elif isinstance(v, (dict, list)):
                    walk(v, p)
        elif isinstance(obj, list):
            for i, v in enumerate(obj[:20]):
                walk(v, f"{prefix}[{i}]")
    walk(data)


def main():
    token, pl = load_token()
    print(f"Asset: {ASSET}")
    test_playready_devices(token, pl, ASSET)
    test_playready_post(token, pl, ASSET)
    test_platforms(token, pl, ASSET)
    test_jwt_all_paths(token, pl, ASSET)
    test_startup_playback(token)


if __name__ == "__main__":
    main()
