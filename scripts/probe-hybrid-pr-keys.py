#!/usr/bin/env python3
"""
Hybrid UHD path: Widevine playback API (200) + PlayReady keys from MPD PSSH.
Skips blocked PlayReady playback API entirely.
"""
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
PR_UUID = b"\x9a\x04\xf0\x79\x98\x40\x42\x86\xab\x92\xe6\x5b\xe0\x88\x5f\x95"
ASSET = sys.argv[1] if len(sys.argv) > 1 else "emfu5j39wp8385wo18re4vq81"


def load():
    sess = json.loads((ROOT / "kayo-token.json").read_text(encoding="utf-8"))
    token = sess["token"]
    part = token.split(".")[1]
    part += "=" * (-len(part) % 4)
    pl = json.loads(base64.urlsafe_b64decode(part))
    return token, pl, sess.get("sessionId")


def headers(token, pl, session_id=None, origin="https://kayosports.com.au"):
    h = {
        "Accept": "*/*",
        "Authorization": f"Bearer {token}",
        "X-BRAND": "KAYO",
        "Origin": origin,
        "Referer": origin + "/",
        "x-dazn-device": pl.get("deviceId", ""),
        "x-daznid": pl.get("user", ""),
        "x-correlation-id": str(uuid.uuid4()),
    }
    if session_id:
        h["x-session-id"] = session_id
    return h


def widevine_playback(token, pl, asset, session_id):
    sid = f"{int(time.time()*1000)}-{pl.get('viewerId','')}-{asset}-67BC9B"
    url = (
        "https://api.playback.indazn.com/v5/Playback"
        f"?AppVersion=0.134.1-hotfix.f7e0d40f1&DrmType=WIDEVINE&Format=MPEG-DASH"
        f"&PlayerId=%40dazn%2Fpeng-html5-core%2Ftv-next%2Ftv&Platform=webos"
        f"&Model=43UR8050PSB&Secure=true&Manufacturer=lg&PlayReadyInitiator=false"
        f"&Capabilities=4k%2Cdd%2Cddp%2Chdr%2Chevc%2Cmta&AssetId={asset}"
        f"&MtaLanguageCode&LanguageCode=en&SessionId={sid}"
    )
    r = requests.get(url, headers=headers(token, pl, session_id), impersonate="chrome120", timeout=45, proxies=NO_PROXY)
    return r.status_code, r.json() if r.status_code == 200 else r.text[:200]


def extract_pr_pssh(mpd):
    out = []
    for p in re.findall(r"<cenc:pssh[^>]*>([^<]+)</cenc:pssh>", mpd):
        try:
            if PR_UUID in base64.b64decode(p) and p not in out:
                out.append(p)
        except Exception:
            pass
    return out


def parse_reps(mpd):
    reps = re.findall(
        r'<Representation[^>]*height="(\d+)"[^>]*bandwidth="(\d+)"[^>]*codecs="([^"]+)"',
        mpd,
    )
    if not reps:
        reps = re.findall(
            r'<Representation[^>]*bandwidth="(\d+)"[^>]*height="(\d+)"[^>]*codecs="([^"]+)"',
            mpd,
        )
        reps = [(h, bw, c) for bw, h, c in reps]
    else:
        reps = [(h, bw, c) for h, bw, c in reps]
    return reps


def pr_license_candidates(la_wv):
    out = []
    if la_wv:
        out.append(la_wv.replace("/widevine/", "/playready/"))
        out.append(re.sub(r"platform=webos", "platform=vidaa", la_wv.replace("/widevine/", "/playready/")))
    return list(dict.fromkeys(out))


def fetch_pr_keys(pssh_b64, lic_url, token, pl, session_id=None):
    from pyplayready.cdm import Cdm
    from pyplayready.device import Device
    from pyplayready.system.pssh import PSSH
    from pyplayready.misc.revocation_list import RevocationList

    prd = ROOT / "cmds" / "hisense_smarttv_43a6101eu_sl3000.prd"
    if not prd.is_file():
        prd = next(ROOT.glob("**/*.prd"), None)
    device = Device.load(str(prd))
    cdm = Cdm.from_device(device)
    sid = cdm.open()
    try:
        req = cdm.get_license_challenge(sid, PSSH(pssh_b64).wrm_headers[0], rev_lists=RevocationList.SupportedListIds)
        h = headers(token, pl, session_id)
        h["Content-Type"] = "text/xml; charset=UTF-8"
        r = requests.post(lic_url, headers=h, data=req, impersonate="chrome120", timeout=45, proxies=NO_PROXY)
        if r.status_code != 200:
            return None, f"HTTP {r.status_code}: {r.text[:120]}"
        cdm.parse_license(sid, r.text)
        keys = [f"{k.key_id.hex}:{k.key.hex()}" for k in cdm.get_keys(sid)]
        return keys, None
    finally:
        cdm.close(sid)


def main():
    token, pl, session_id = load()
    print(f"Asset: {ASSET}")
    code, pb = widevine_playback(token, pl, ASSET, session_id)
    print("Widevine playback:", code)
    if code != 200:
        print(pb)
        return

    title = pb.get("Asset", {}).get("Title") or pb.get("Title")
    print("Title:", title)

    for entry in pb.get("PlaybackDetails", []):
        cdn = entry.get("CdnName")
        if cdn not in ("dck1-fs-vod", "dck1-ac-vod"):
            continue
        mpd_url = entry["ManifestUrl"]
        if entry.get("CdnToken"):
            tok = entry["CdnToken"]
            sep = "&" if "?" in mpd_url else "?"
            mpd_url += sep + tok["Name"] + "=" + tok["Value"]
        la_wv = entry.get("LaUrl") or pb.get("LaUrl") or ""
        cid = re.search(r"contentId=([^&]+)", la_wv)
        print(f"\nCDN {cdn}")
        print("  contentId:", (cid.group(1)[:80] if cid else "?"))

        mr = requests.get(mpd_url, headers=headers(token, pl, session_id), impersonate="chrome120", timeout=45, proxies=NO_PROXY)
        print("  MPD HTTP", mr.status_code, "bytes", len(mr.text))
        if mr.status_code != 200:
            continue

        reps = parse_reps(mr.text)
        heights = sorted(set(int(h) for h, _, _ in reps))
        max_bw = max((int(bw) for _, bw, _ in reps), default=0)
        pr_pssh = extract_pr_pssh(mr.text)
        print("  heights", heights, "max_bw", max_bw, "pr_pssh", len(pr_pssh))

        if not pr_pssh:
            continue

        for lic in pr_license_candidates(la_wv):
            print(f"  PlayReady license try: {lic[:90]}...")
            keys, err = fetch_pr_keys(pr_pssh[0], lic, token, pl, session_id)
            if keys:
                print(f"  SUCCESS PSSH 1/{len(pr_pssh)}: {len(keys)} keys")
                for k in keys[:4]:
                    print("   ", k)
                # try all pssh
                all_keys = set(keys)
                for i, pssh in enumerate(pr_pssh[1:], 2):
                    k2, e2 = fetch_pr_keys(pssh, lic, token, pl, session_id)
                    if k2:
                        all_keys.update(k2)
                        print(f"  PSSH {i}: +{len(k2)} keys (total unique {len(all_keys)})")
                print(f"  TOTAL UNIQUE KEYS: {len(all_keys)}")
                return
            print("  failed:", err)


if __name__ == "__main__":
    main()
