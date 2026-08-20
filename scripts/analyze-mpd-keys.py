#!/usr/bin/env python3
import base64, json, re, time, uuid
from pathlib import Path
from curl_cffi import requests

ROOT = Path(__file__).resolve().parents[1]
NO_PROXY = {"http": None, "https": None, "all": None}
PR_UUID = b"\x9a\x04\xf0\x79\x98\x40\x42\x86\xab\x92\xe6\x5b\xe0\x88\x5f\x95"
WV_UUID = b"\xed\xef\x8b\xa9\x79\xd6\x4a\xce\xa3\xc8\x27\xdc\xd5\x1d\x21\xed"

sess = json.loads((ROOT / "kayo-token.json").read_text(encoding="utf-8"))
token = sess["token"]
part = token.split(".")[1]
part += "=" * (-len(part) % 4)
pl = json.loads(base64.urlsafe_b64decode(part))
asset = "emfu5j39wp8385wo18re4vq81"
sid = f"{int(time.time()*1000)}-{pl.get('viewerId','')}-{asset}-67BC9B"

h = {
    "Accept": "*/*",
    "Authorization": f"Bearer {token}",
    "X-BRAND": "KAYO",
    "Origin": "https://kayosports.com.au",
    "Referer": "https://kayosports.com.au/",
    "x-dazn-device": pl.get("deviceId", ""),
    "x-daznid": pl.get("user", ""),
    "x-correlation-id": str(uuid.uuid4()),
}

url = (
    "https://api.playback.indazn.com/v5/Playback"
    f"?AppVersion=0.134.1-hotfix.f7e0d40f1&DrmType=WIDEVINE&Format=MPEG-DASH"
    f"&PlayerId=%40dazn%2Fpeng-html5-core%2Ftv-next%2Ftv&Platform=webos"
    f"&Model=43UR8050PSB&Secure=true&Manufacturer=lg&PlayReadyInitiator=false"
    f"&Capabilities=4k%2Cdd%2Cddp%2Chdr%2Chevc%2Cmta&AssetId={asset}"
    f"&MtaLanguageCode&LanguageCode=en&SessionId={sid}"
)
pb = requests.get(url, headers=h, impersonate="chrome120", timeout=30, proxies=NO_PROXY).json()
entry = next(d for d in pb["PlaybackDetails"] if d["CdnName"] == "dck1-fs-vod")
mpd_url = entry["ManifestUrl"] + "&" + entry["CdnToken"]["Name"] + "=" + entry["CdnToken"]["Value"]
la_wv = entry.get("LaUrl") or pb.get("LaUrl")
text = requests.get(mpd_url, headers=h, impersonate="chrome120", timeout=30, proxies=NO_PROXY).text
(ROOT / "tmp_mpd.xml").write_text(text, encoding="utf-8")

heights = sorted(set(int(x) for x in re.findall(r'height="(\d+)"', text)))
print("heights", heights)
print("LaUrl (widevine)", la_wv[:120], "...")

pr_pssh, wv_pssh = [], []
for p in re.findall(r"<cenc:pssh[^>]*>([^<]+)</cenc:pssh>", text):
    try:
        raw = base64.b64decode(p)
    except Exception:
        continue
    if PR_UUID in raw and p not in pr_pssh:
        pr_pssh.append(p)
    if WV_UUID in raw and p not in wv_pssh:
        wv_pssh.append(p)
print("pr_pssh", len(pr_pssh), "wv_pssh", len(wv_pssh))

if pr_pssh and la_wv:
    la_pr = la_wv.replace("/widevine/", "/playready/")
    print("try PlayReady license:", la_pr[:100], "...")
    try:
        from pyplayready.cdm import Cdm
        from pyplayready.device import Device
        from pyplayready.system.pssh import PSSH
        from pyplayready.misc.revocation_list import RevocationList

        prd = ROOT / "cmds" / "hisense_smarttv_43a6101eu_sl3000.prd"
        device = Device.load(str(prd))
        cdm = Cdm.from_device(device)
        sid2 = cdm.open()
        req = cdm.get_license_challenge(sid2, PSSH(pr_pssh[0]).wrm_headers[0], rev_lists=RevocationList.SupportedListIds)
        lh = dict(h)
        lh["Content-Type"] = "text/xml; charset=utf-8"
        lh["Origin"] = "https://tv.kayosports.com.au"
        lh["Referer"] = "https://tv.kayosports.com.au/"
        r = requests.post(la_pr, headers=lh, data=req, impersonate="chrome120", timeout=30, proxies=NO_PROXY)
        print("PR license HTTP", r.status_code, r.text[:200])
        if r.status_code == 200:
            cdm.parse_license(sid2, r.text)
            keys = [f"{k.key_id.hex}:{k.key.hex()}" for k in cdm.get_keys(sid2)]
            print("keys", len(keys), keys[:4])
        cdm.close(sid2)
    except Exception as e:
        print("PR key error:", e)
