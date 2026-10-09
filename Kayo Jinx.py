import os
import re
import sys
import uuid
import time
import string
import random
import json
import base64
import urllib.parse
import subprocess
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from curl_cffi import requests

try:
    from prettytable import PrettyTable
    from colorama import Fore as clr, init as clr_init
    clr_init(autoreset=True)

    # Widevine
    from pywidevine.cdm import Cdm as WvCdm
    from pywidevine.device import Device as WvDevice
    from pywidevine.pssh import PSSH as WvPSSH

    # PlayReady
    from pyplayready.cdm import Cdm as PrCdm
    from pyplayready.device import Device as PrDevice
    from pyplayready.system.pssh import PSSH as PrPSSH
    from pyplayready.misc.revocation_list import RevocationList

except ImportError:
    print("Please install required packages: pip install prettytable colorama curl_cffi pywidevine pyplayready")
    sys.exit(1)

# ==============================
# CONFIGURATION & ENDPOINTS
# ==============================

DEBUG         = False  

USER_EMAIL    = os.environ.get("KAYO_EMAIL", "").strip()
USER_PASSWORD = os.environ.get("KAYO_PASSWORD", "").strip()
BRAND         = "kayo"  
HOST          = "kayosports.com.au"

DAZN_AUTH_V5    = 'https://authentication-prod.ar.indazn.com/v5/SignIn'
DAZN_PROFILE_V4 = 'https://user-profile.ar.indazn.com/v4/UserProfile'
DAZN_SWITCH_V1  = 'https://authentication-prod.ar.indazn.com/v1/SwitchProfile'

EPG_URL             = "https://epg.discovery.indazn.com/jp/v6/epgWithDatesRange"
RAIL_V10_URL        = "https://rail-router.discovery.indazn.com/jp/v10/Rail"
RAIL_V1_RULESET_URL = "https://ruleset-rail-router.discovery.indazn.com/jp/v1/Rail"
PLAYBACK_BASE_URL   = "https://api.playback.indazn.com/v5/Playback"

PLATFORM = 'webos'
WINDOWS_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

_SCRIPT_ROOT = os.path.dirname(os.path.abspath(__file__))
WVD_DEVICE_FILE = os.path.join(_SCRIPT_ROOT, 'cmds', 'xiaomi_m2103k19pi_16.1.1_006_30cd6121_21111_l1.wvd')
PRD_DEVICE_FILE = os.path.join(_SCRIPT_ROOT, 'cmds', 'hisense_smarttv_hu32e5600fhwv_sl2000.prd')
KEY_STORE_FILE  = os.path.join(_SCRIPT_ROOT, 'keys.txt')

# ==============================
# DEVICE IDENTITY INITIALIZATION
# ==============================

DEVICE_UUID = str(uuid.uuid4())
DAZN_DEVICE_ID = "00" + DEVICE_UUID.split("-")[4][2:]
PROFILING_SESSION_ID = ''.join(random.choices(string.ascii_lowercase + string.digits, k=20))

NO_PROXY = {"http": None, "https": None}


def load_dotenv():
    env_path = os.path.join(_SCRIPT_ROOT, ".env")
    if not os.path.isfile(env_path):
        return
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip())


def webshare_proxies():
    raw = (os.environ.get("KAYO_PROXY") or "").strip()
    if not raw or raw.startswith("http"):
        return None
    parts = raw.split(":")
    if len(parts) < 4:
        return None
    host, port, user = parts[0], parts[1], parts[2]
    password = ":".join(parts[3:])
    user_q = urllib.parse.quote(user, safe="")
    pass_q = urllib.parse.quote(password, safe="")
    url = f"http://{user_q}:{pass_q}@{host}:{port}"
    return {"http": url, "https": url}


def proxy_chain():
    chain = [NO_PROXY]
    tunnel = (os.environ.get("KAYO_PROXY_TUNNEL") or "").strip()
    if tunnel:
        u = tunnel if tunnel.startswith("http") else f"http://{tunnel}"
        chain.append({"http": u, "https": u})
    ws = webshare_proxies()
    if ws:
        chain.append(ws)
    return chain


def kayo_request(method, url, **kwargs):
    kwargs.setdefault("timeout", 45)
    kwargs.setdefault("impersonate", "chrome120")
    last_resp = None
    last_err = None
    for proxies in proxy_chain():
        try:
            if method.upper() == "GET":
                last_resp = requests.get(url, proxies=proxies, **kwargs)
            else:
                last_resp = requests.post(url, proxies=proxies, **kwargs)
            if last_resp.status_code == 200 or last_resp.status_code != 403:
                return last_resp
        except Exception as exc:
            last_err = exc
            continue
    if last_resp is not None:
        return last_resp
    if last_err:
        raise last_err
    raise RuntimeError("kayo_request failed")


def expect_json(resp, step):
    body = resp.text or ""
    if resp.status_code != 200:
        snippet = body[:220].replace("\n", " ")
        if "10075" in body or "via VPN" in body:
            raise RuntimeError(
                f"{step}: HTTP {resp.status_code} — DAZN blocks this exit as VPN (10075). "
                "Rotate KAYO-AU in Clash or paste KAYO_TOKEN from Chrome into .env."
            )
        if snippet.lstrip().startswith("<"):
            raise RuntimeError(
                f"{step}: HTTP {resp.status_code} — CloudFront/WAF HTML (not JSON). "
                "Turn on Clash (127.0.0.1:7897) and KAYO-AU."
            )
        raise RuntimeError(f"{step}: HTTP {resp.status_code} — {snippet}")
    try:
        return resp.json()
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{step}: invalid JSON — {body[:120]!r}") from exc


def token_user_id(token):
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        data = json.loads(base64.urlsafe_b64decode(part).decode())
        return data.get("user") or ""
    except Exception:
        return ""


def authenticate_kayo():
    email = (os.environ.get("KAYO_EMAIL") or USER_EMAIL or "").strip()
    password = (os.environ.get("KAYO_PASSWORD") or USER_PASSWORD or "").strip()
    if not email or not password:
        raise RuntimeError("Set KAYO_EMAIL and KAYO_PASSWORD in .env (same folder as this script).")

    auth_payload = {
        "Email": email,
        "Password": password,
        "Platform": PLATFORM,
        "DeviceId": DAZN_DEVICE_ID,
        "ProfilingSessionId": PROFILING_SESSION_ID,
        "Brand": BRAND.upper(),
    }
    resp1 = kayo_request("POST", DAZN_AUTH_V5, json=auth_payload, headers=get_headers())
    data1 = expect_json(resp1, "SignIn")
    initial_token = data1["AuthToken"]["Token"]

    session_id = str(uuid.uuid4())
    prof_headers = get_headers(token=initial_token)
    prof_headers.update({"x-daznid": token_user_id(initial_token), "x-session-id": session_id})

    resp2 = kayo_request("GET", DAZN_PROFILE_V4, headers=prof_headers)
    data2 = expect_json(resp2, "UserProfile")
    profile_id = data2.get("ViewerId")
    if not profile_id:
        raise RuntimeError("UserProfile: no ViewerId in response")

    switch_payload = {"brand": BRAND, "profileId": profile_id}
    resp3 = kayo_request("POST", DAZN_SWITCH_V1, headers=prof_headers, json=switch_payload)
    data3 = expect_json(resp3, "SwitchProfile")
    return data3["AuthToken"]["Token"]


def print_debug(title, data):
    if not DEBUG: return
    print(f"\n{clr.MAGENTA}[DEBUG] --- {title} ---{clr.RESET}")
    if isinstance(data, (dict, list)):
        try:
            print(json.dumps(data, indent=2, default=str))
        except TypeError:
            print(data)
    else:
        print(data)

def get_headers(token=None):
    headers = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-AU,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
        'Connection': 'keep-alive',
        'Origin': f'https://tv.{HOST}',
        'Referer': f'https://tv.{HOST}/',
        'User-Agent': WINDOWS_CHROME_UA,
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        'x-brand': BRAND.upper(),
    }
    if token:
        headers['authorization'] = f'Bearer {token}'
    return headers

def extract_base_url(mpd_url: str) -> str:
    parsed = urllib.parse.urlparse(mpd_url)
    path = parsed.path
    if path.endswith(('/index.mpd', '/manifest.mpd', '.mpd')):
        base_path = path[:path.rfind('/') + 1]
    else:
        base_path = path
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, base_path, '', '', ''))

def remove_ad_periods_from_mpd(mpd_content: str) -> str | None:
    try:
        root = ET.fromstring(mpd_content)
        ns = {'d': 'urn:mpeg:dash:schema:mpd:2011', 's': 'urn:scte:scte35:2013:xml'}
        ET.register_namespace('', ns['d'])
        ET.register_namespace('scte35', ns['s'])

        periods = root.findall('d:Period', ns)
        ad_periods = [p for p in periods if p.find('.//s:SpliceInfoSection', ns) is not None]

        if not ad_periods: return None
        for p in ad_periods: root.remove(p)

        remaining = root.findall('d:Period', ns)
        def parse_duration(dur_str: str) -> float:
            if not dur_str: return 0.0
            match = re.search(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?', dur_str)
            h = float(match.group(1) or 0)
            m = float(match.group(2) or 0)
            s = float(match.group(3) or 0)
            return h * 3600 + m * 60 + s

        current_start = 0.0
        for p in remaining:
            p.set('start', f'PT{current_start:.3f}S')
            dur = p.get('duration')
            if dur: current_start += parse_duration(dur)

        root.set('mediaPresentationDuration', f'PT{current_start:.3f}S')
        return ET.tostring(root, encoding='utf-8', xml_declaration=True).decode('utf-8')
    except Exception as e:
        print(f"{clr.RED}[!] Error while trimming MPD: {e}{clr.RESET}")
        return None

# ==============================
# KEY & PLAYBACK LOGIC
# ==============================

def get_widevine_pssh(mpd_url):
    pssh_list = []
    try:
        resp = requests.get(mpd_url, impersonate="chrome120")
        if resp.status_code == 200:
            matches = re.findall(r'<cenc:pssh[^>]*>([^<]+)</cenc:pssh>', resp.text)
            for p in matches:
                if b'\xed\xef\x8b\xa9\x79\xd6\x4a\xce\xa3\xc8\x27\xdc\xd5\x1d\x21\xed' in base64.b64decode(p):
                    if p not in pssh_list: pssh_list.append(p)
    except: pass
    return pssh_list

def fetch_wv_keys(pssh_b64, license_url, token):
    keys = []
    try:
        device = WvDevice.load(WVD_DEVICE_FILE)
        cdm = WvCdm.from_device(device)
        session_id = cdm.open()
        challenge = cdm.get_license_challenge(session_id, WvPSSH(pssh_b64))
        resp = requests.post(license_url, headers=get_headers(token=token), data=challenge, impersonate="chrome120")
        if resp.status_code == 200:
            cdm.parse_license(session_id, resp.content)
            for key in cdm.get_keys(session_id):
                if key.type == 'CONTENT': keys.append(f"--key {key.kid.hex}:{key.key.hex()}")
        cdm.close(session_id)
    except: pass
    return keys

def get_playready_pssh(mpd_url):
    pssh_list = []
    try:
        resp = requests.get(mpd_url, impersonate="chrome120")
        if resp.status_code == 200:
            matches = re.findall(r'<cenc:pssh[^>]*>([^<]+)</cenc:pssh>', resp.text)
            for p in matches:
                if b'\x9a\x04\xf0\x79\x98\x40\x42\x86\xab\x92\xe6\x5b\xe0\x88\x5f\x95' in base64.b64decode(p):
                    if p not in pssh_list: pssh_list.append(p)
    except: pass
    return pssh_list

def fetch_pr_keys(pssh_b64, license_url, token):
    keys = []
    try:
        device = PrDevice.load(PRD_DEVICE_FILE)
        cdm = PrCdm.from_device(device)
        session_id = cdm.open()
        request = cdm.get_license_challenge(session_id, PrPSSH(pssh_b64).wrm_headers[0], rev_lists=RevocationList.SupportedListIds)
        headers = get_headers(token=token)
        headers['Content-Type'] = 'text/xml; charset=utf-8'
        resp = requests.post(license_url, headers=headers, data=request, impersonate="chrome120")
        if resp.status_code == 200:
            cdm.parse_license(session_id, resp.text)
            for key in cdm.get_keys(session_id): keys.append(f"--key {key.key_id.hex}:{key.key.hex()}")
        cdm.close(session_id)
    except: pass
    return keys

def fetch_discovery(group_cfg, token):
    headers = get_headers(token=token)
    headers['x-daznid'] = 'auth0|9f3a7c21d8b4e605a12c9e4f'
    source = group_cfg.get("source", "rail_v10")
    
    if source == "epg": endpoint = EPG_URL
    elif source == "rail_v1": endpoint = RAIL_V1_RULESET_URL
    else: endpoint = RAIL_V10_URL

    params = {'brand': BRAND, 'country': 'au', 'languageCode': 'en', 'platform': PLATFORM}

    if source == "epg":
        params.update({'startDate': datetime.now().strftime('%Y-%m-%d'), 'endDate': (datetime.now() + timedelta(days=3)).strftime('%Y-%m-%d')})
    else:
        params['id'] = group_cfg["id"]
        if source == "rail_v1" and group_cfg.get("params"): params['params'] = group_cfg["params"]

    resp = kayo_request("GET", endpoint, headers=headers, params=params)
    if resp.status_code != 200: return []

    data = resp.json()
    raw_tiles = []
    if 'Tiles' in data: raw_tiles = data['Tiles']
    elif 'Rails' in data and data['Rails']: raw_tiles = data['Rails'][0].get('Tiles', [])
    elif 'Modules' in data:
        for mod in data['Modules']:
            raw_tiles.extend(mod.get('Tiles', []))
            for rail in mod.get('Rails', []): raw_tiles.extend(rail.get('Tiles', []))

    tiles = []
    for t in raw_tiles:
        aid = t.get('AssetId')
        if not aid: continue
        channel_name = t.get('LinearProvider') or t.get('LinearChannel', {}).get('Title') or "Kayo"
        he_config = t.get('HeEventTypeConfig') or {}
        video_quality = t.get('VideoQuality', '')
        is_4k = any([he_config.get('is4k'), he_config.get('is4kUpscaled'), video_quality == 'UHD', "4k" in t.get('Title', '').lower()])
        q_color = clr.GREEN + "UHD" if is_4k else clr.YELLOW + "HD"

        st_label = "LIVE"
        raw_start = t.get('Start') or t.get('transmissionTime')
        if raw_start:
            try: st_label = datetime.fromisoformat(raw_start.replace("Z", "+00:00")).strftime('%b %d, %I:%M %p')
            except: st_label = "TBD"

        tiles.append({'assetId': aid, 'title': t.get('Title') or t.get('Label') or "No Title", 'channel': channel_name, 'quality': q_color, 'start': st_label, 'is_4k': is_4k})

    return tiles

def get_playback_v5(asset_id, token, device_uuid, is_4k):
    def get_dazn_info(t):
        try:
            p = t.split('.')[1]
            p += '=' * (-len(p) % 4)
            data = json.loads(base64.urlsafe_b64decode(p).decode())
            return data.get('user'), data.get('viewerId')
        except: return 'auth0|6831827e7c61c817127eb287', ''

    daznid, viewer_id = get_dazn_info(token)
    session_id = f"{int(time.time()*1000)}-{viewer_id}-{asset_id}-67BC9B"
    drm_type = "PLAYREADY" if is_4k else "WIDEVINE"
    url = f"{PLAYBACK_BASE_URL}?AppVersion=0.134.1-hotfix.f7e0d40f1&DrmType={drm_type}&Format=MPEG-DASH&PlayerId=%40dazn%2Fpeng-html5-core%2Ftv-next%2Ftv&Platform={PLATFORM}&Model=43UR8050PSB&Secure=true&Manufacturer=lg&PlayReadyInitiator=false&Capabilities=4k%2Cdd%2Cddp%2Chdr%2Chevc%2Cmta&AssetId={asset_id}&MtaLanguageCode&LanguageCode=en&SessionId={session_id}"

    headers = get_headers(token=token)
    headers.update({'x-correlation-id': str(uuid.uuid4()), 'x-dazn-device': device_uuid, 'x-daznid': daznid})

    resp = kayo_request("GET", url, headers=headers)
    if resp.status_code != 200: return []

    streams = []
    for item in resp.json().get("PlaybackDetails", []):
        raw_mpd = item['ManifestUrl']
        if 'CdnToken' in item:
            sep = "&" if "?" in raw_mpd else "?"
            raw_mpd += f"{sep}{item['CdnToken']['Name']}={urllib.parse.quote(item['CdnToken']['Value'])}"
        streams.append({"cdn": item.get("CdnName", "Unknown"), "mpd": raw_mpd, "lic": item.get("LaUrl")})
    return streams

# ==============================
# MAIN EXECUTION
# ==============================

if __name__ == "__main__":
    load_dotenv()
    if not os.path.exists(WVD_DEVICE_FILE) or not os.path.exists(PRD_DEVICE_FILE):
        print(f"{clr.RED}[!] Make sure both WVD and PRD device files exist in their specified paths.{clr.RESET}")
        sys.exit(1)

    print(f"{clr.CYAN}[*] Authenticating with Kayo Servers...{clr.RESET}")
    try:
        token_str = authenticate_kayo()
        print(f"{clr.GREEN}[+] Successfully Authenticated!{clr.RESET}")
    except Exception as e:
        print(f"{clr.RED}[!] Auth failed: {e}{clr.RESET}")
        sys.exit(1)

    while True:
        print(f"\n{clr.CYAN}=== Main Menu: Operation Mode ==={clr.RESET}")
        print(f"{clr.GREEN}1. Catchup from Live Channels (Timestamp Method){clr.RESET}")
        print(f"{clr.GREEN}2. Download Live Stream{clr.RESET}")
        print(f"{clr.GREEN}3. Download from Event ID{clr.RESET}")
        print(f"{clr.GREEN}4. AFL Replays{clr.RESET}")
        print(f"{clr.GREEN}5. NRL Replays{clr.RESET}")
        print(f"{clr.GREEN}6. Quit{clr.RESET}")
        
        op_choice = input(f"{clr.YELLOW}Select Mode: {clr.RESET}").strip()
        if op_choice == '6' or op_choice.lower() == 'q': sys.exit()
        if op_choice not in ['1', '2', '3', '4', '5']: continue

        # Map choices to fetching logic
        sel_group = None
        if op_choice in ['1', '2']:
            sel_group = {"id": "Livetvschedule", "label": "Live TV Channels", "source": "rail_v10"}
        elif op_choice == '4':
            sel_group = {"id": "1a4fabf0-c7d6-4f31-8f88-468c482037a6", "label": "AFL Replays", "source": "rail_v1", "params": "PageType:Sport;ContentType:Sport;ContentId:pxf4y47kwth2g64m7wzo209y"}
        elif op_choice == '5':
            sel_group = {"id": "fc11b688-e7bf-40ad-a331-f76ced1091f0", "label": "NRL Replays", "source": "rail_v1", "params": "PageType:Competition;ContentType:Competition;ContentId:z3ztbksn5xbno5wcd4jzguhy"}

        # Handle Mode 3 (Manual ID)
        if op_choice == '3':
            asset_id = input(f"{clr.YELLOW}Enter event ID (e.g., d3btejs4vriagh5skq4jo071j): {clr.RESET}").strip()
            if not asset_id: continue
            is_4k_input = input(f"{clr.YELLOW}Is this a 4K/UHD event? (y/n): {clr.RESET}").strip().lower()
            is_4k_event = is_4k_input == 'y'
            asset = {
                'assetId': asset_id,
                'title': f"Event_{asset_id}",
                'channel': "Custom",
                'quality': clr.GREEN + "UHD" if is_4k_event else clr.YELLOW + "HD",
                'start': "N/A",
                'is_4k': is_4k_event
            }
        else:
            print(f"\n{clr.CYAN}[*] Fetching {sel_group['label']}...{clr.RESET}")
            tiles = fetch_discovery(sel_group, token_str)
            
            if not tiles:
                print(f"{clr.RED}[!] No events found.{clr.RESET}")
                continue

            table = PrettyTable(["Idx", "Quality", "Channel", "Title", "Local Time", "Asset ID"])
            table.align["Title"] = "l"
            for i, t in enumerate(tiles):
                table.add_row([i + 1, t['quality'], clr.CYAN + t['channel'], t['title'], clr.YELLOW + t['start'], t['assetId']])

            print(f"\n{table}")

            idx_input = input(f"\n{clr.YELLOW}Select Event Index (e.g., 1 or 'b' for back): {clr.RESET}").strip().lower()
            if idx_input == 'b' or not idx_input.isdigit(): continue

            s_idx = int(idx_input) - 1
            if s_idx < 0 or s_idx >= len(tiles): 
                print(f"{clr.RED}Invalid Selection.{clr.RESET}")
                continue

            asset = tiles[s_idx]
            is_4k_event = asset['is_4k']

        clean_title = re.sub(r'[^\w\-]', '_', asset['title']).strip('_')
        
        cat_names = {'1': 'Catchup', '2': 'Live', '3': 'Manual', '4': 'AFL_Replay', '5': 'NRL_Replay'}
        save_prefix = cat_names.get(op_choice, 'Video')
        final_save_name = f"{save_prefix}_{clean_title}_trimmed"
        
        # --- FOLDER NAMING LOGIC ---
        if op_choice == '1':
            folder_name = f"{clean_title}_catchup"
        elif op_choice == '2':
            folder_name = f"{clean_title}_live"
        else:
            folder_name = clean_title
            
        save_dir = f"D:\\Tools\\{folder_name}"
        os.makedirs(save_dir, exist_ok=True)
        
        start_ts, end_ts = None, None
        if op_choice == '1':
            print(f"\n{clr.CYAN}[*] Catchup Mode Activated.{clr.RESET}")
            start_ts = input(f"{clr.YELLOW}Enter Start Time (e.g., 2026-06-04T14:50:00+05:30): {clr.RESET}").strip()
            end_ts = input(f"{clr.YELLOW}Enter End Time (e.g., 2026-06-04T15:50:00+05:30): {clr.RESET}").strip()

        print(f"\n{clr.CYAN}--- Getting Manifest for: {asset['title']} ({'PlayReady 4K' if is_4k_event else 'Widevine 1080p'}) ---{clr.RESET}")

        streams = get_playback_v5(asset['assetId'], token_str, DEVICE_UUID, is_4k_event)
        if not streams: 
            print(f"{clr.RED}[!] Could not retrieve streams.{clr.RESET}")
            continue

        master_keys = set()
        for i, s in enumerate(streams):
            print(f"\n{clr.GREEN}[ Stream {i+1} - CDN: {s['cdn']} ]{clr.RESET}")
            print(f"{clr.YELLOW}Manifest URL:{clr.RESET}\n{s['mpd']}")
            print(f"{clr.YELLOW}License URL:{clr.RESET}\n{s['lic']}")
            
            print(f"\n{clr.CYAN}[*] Fetching Keys...{clr.RESET}")
            if is_4k_event:
                pr_pssh_list = get_playready_pssh(s['mpd'])
                if pr_pssh_list:
                    for pssh_val in pr_pssh_list: master_keys.update(fetch_pr_keys(pssh_val, s['lic'], token_str))
            else:
                wv_pssh_list = get_widevine_pssh(s['mpd'])
                if wv_pssh_list:
                    for pssh_val in wv_pssh_list: master_keys.update(fetch_wv_keys(pssh_val, s['lic'], token_str))

        if master_keys:
            existing_keys = set()
            if os.path.exists(KEY_STORE_FILE):
                with open(KEY_STORE_FILE, "r", encoding="utf-8") as f:
                    for line in f:
                        if line.startswith("--key "): existing_keys.add(line.strip())

            unique_new_keys = [k for k in master_keys if k not in existing_keys]
            if unique_new_keys:
                with open(KEY_STORE_FILE, "a", encoding="utf-8") as f:
                    f.write(f"\n\n===== Kayo Keys ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')}) =====\n")
                    for k in unique_new_keys: f.write(k + "\n")
                print(f"{clr.GREEN}[+] Saved new keys to {KEY_STORE_FILE}{clr.RESET}")

            print(f"\n{clr.CYAN}[*] Fetching final token refresh before launch...{clr.RESET}")
            fresh_streams = get_playback_v5(asset['assetId'], token_str, DEVICE_UUID, is_4k_event)
            fresh_target_mpd = next((s['mpd'] for s in fresh_streams if "dck1-fs-" in s['mpd']), fresh_streams[0]['mpd'])

            target_fetch_url = fresh_target_mpd
            is_live = "live" in target_fetch_url
            
            # --- MPD PROCESSING: LOCAL INJECTION & AD REMOVAL (MODE 1 ONLY) ---
            if op_choice == '1' and start_ts and end_ts:
                print(f"\n{clr.CYAN}[*] Downloading MPD for injection & ad removal...{clr.RESET}")
                
                sep = "&" if "?" in target_fetch_url else "?"
                target_fetch_url += f"{sep}start={urllib.parse.quote(start_ts)}&end={urllib.parse.quote(end_ts)}"
                
                mpd_resp = requests.get(target_fetch_url, headers=get_headers(token=token_str), impersonate="chrome120")
                if mpd_resp.status_code == 200:
                    mpd_text = mpd_resp.text
                    
                    token_match = re.search(r'dazn-token=([^&]+)', fresh_target_mpd)
                    if token_match:
                        token_val = token_match.group(1)
                        def inject_token_safely(match):
                            val = match.group(1)
                            sep = "&amp;" if "?" in val else "?"
                            return f'{val}{sep}dazn-token={token_val}"'

                        mpd_text = re.sub(r'(initialization="[^"]+)"', inject_token_safely, mpd_text)
                        mpd_text = re.sub(r'(media="[^"]+)"', inject_token_safely, mpd_text)
                        print(f"{clr.GREEN}[+] Injected CDN tokens locally to authorize Fastly segments...{clr.RESET}")
                    
                    trimmed_content = remove_ad_periods_from_mpd(mpd_text)
                    if trimmed_content:
                        mpd_text = trimmed_content
                        print(f"{clr.GREEN}[+] Removed SCTE-35 ad periods.{clr.RESET}")
                    
                    local_mpd_path = os.path.join(save_dir, "manifest.mpd")
                    with open(local_mpd_path, "w", encoding="utf-8") as f: f.write(mpd_text)
                    
                    mpd_arg = f'"{local_mpd_path}"'
                    base_url = extract_base_url(fresh_target_mpd)
                    extra_args = f'--base-url "{base_url}" '
                    append_flag = "" 
                else:
                    print(f"{clr.RED}[!] Failed to download MPD locally. Defaulting to raw URL.{clr.RESET}")
                    mpd_arg = f'"{target_fetch_url}"'
                    extra_args = ""
                    append_flag = "--append-url-params "

            # --- ALL OTHER MODES: USE RAW URL ---
            else:
                mpd_arg = f'"{target_fetch_url}"'
                extra_args = ""
                append_flag = "--append-url-params "


            # --- BUILD DOWNLOAD COMMAND ---
            if op_choice == "1":
                print(f"\n{clr.YELLOW}[*] Configuring command for Timestamp Catchup...{clr.RESET}")
                live_flags = "--live-perform-as-vod "
            elif op_choice == "2":
                print(f"\n{clr.YELLOW}[*] Configuring command to track Live Window...{clr.RESET}")
                live_flags = "--use-shaka-packager --live-real-time-merge "
            else:
                print(f"\n{clr.YELLOW}[*] Configuring command for VOD/Replay...{clr.RESET}")
                live_flags = "--use-shaka-packager --live-real-time-merge " if is_live else ""

            key_args = " ".join(master_keys)

            download_command = f'N_m3u8DL-RE {mpd_arg} --header "User-Agent: {WINDOWS_CHROME_UA}" --header "Referer: https://kayosports.com.au/" --header "Origin: https://tv.kayosports.com.au" {key_args} -mt {live_flags}{extra_args}{append_flag}-sv best -sa all -ds all -M format=mkv:muxer=mkvmerge --save-dir "{save_dir}" --tmp-dir "{save_dir}" --save-name "{final_save_name}" --del-after-done false'

            print(f"\n{clr.CYAN}[*] Ready-to-use Download Command:{clr.RESET}")
            print(download_command)

            print(f"\n{clr.GREEN}[*] Launching D:\\Tools\\cmd.exe to start the download...{clr.RESET}")
            try: subprocess.Popen(f'start "" "D:\\Tools\\cmd.exe" /k {download_command}', shell=True)
            except Exception as e: print(f"{clr.RED}[!] Failed to launch cmd.exe: {e}{clr.RESET}")

        else:
            print(f"\n{clr.RED}[!] Key extraction failed across all streams. Check auth token or DRM restrictions.{clr.RESET}")