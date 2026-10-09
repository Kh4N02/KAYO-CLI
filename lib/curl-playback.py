#!/usr/bin/env python3
"""Widevine GET playback via curl_cffi (no browser WAF). Works for HD Kayo VOD."""

import base64
import json
import os
import sys
import re
import time
import uuid
from urllib.parse import quote, urlencode

from curl_cffi import requests

PLAYBACK_BASE = 'https://api.playback.indazn.com/v5/Playback'
APP_VERSION = '0.134.1-hotfix.f7e0d40f1'
CAPS_4K = '4k,dd,ddp,hdr,hevc,mta'
# Playback API must use system VPN/TUN — explicit HTTP_PROXY (Clash) often gets CloudFront 403.
NO_PROXY = {'http': None, 'https': None, 'all': None}


def curl_proxies():
    """Clash HTTP port from .env, else direct (system TUN)."""
    load_dotenv()
    tunnel = (os.environ.get('KAYO_PROXY_TUNNEL') or '').strip()
    if tunnel:
        url = tunnel if tunnel.startswith('http') else f'http://{tunnel}'
        return {'http': url, 'https': url, 'all': url}
    return NO_PROXY


def webshare_proxies():
    """KAYO_PROXY=host:port:user:pass (AU Webshare)."""
    load_dotenv()
    raw = (os.environ.get('KAYO_PROXY') or '').strip()
    if not raw or raw.startswith('http'):
        return None
    parts = raw.split(':')
    if len(parts) < 4:
        return None
    host, port, user = parts[0], parts[1], parts[2]
    password = ':'.join(parts[3:])
    if not all([host, port, user, password]):
        return None
    url = f'http://{quote(user, safe="")}:{quote(password, safe="")}@{host}:{port}'
    return {'http': url, 'https': url, 'all': url}


def playback_proxy_chain():
    """System TUN → Clash tunnel → Webshare (KAYO_PROXY)."""
    load_dotenv()
    chain = [NO_PROXY]
    tunnel = curl_proxies()
    if tunnel is not NO_PROXY:
        chain.append(tunnel)
    ws = webshare_proxies()
    if ws:
        chain.append(ws)
    return chain


def playback_http_get(url, headers):
    last = None
    last_err = None
    get_headers = {k: v for k, v in headers.items() if k.lower() != 'content-type'}
    for proxies in playback_proxy_chain():
        try:
            resp = requests.get(url, headers=get_headers, impersonate='chrome120', timeout=45, proxies=proxies)
            last = resp
            if resp.status_code == 200 or resp.status_code != 403:
                return resp
        except Exception as exc:
            last_err = exc
            continue
    if last is not None:
        return last
    if last_err:
        raise last_err
    raise RuntimeError('playback_http_get failed')


def playback_http_post(url, headers, body):
    last = None
    last_err = None
    for proxies in playback_proxy_chain():
        try:
            resp = requests.post(url, headers=headers, data=body, impersonate='chrome120', timeout=45, proxies=proxies)
            last = resp
            if resp.status_code == 200 or resp.status_code != 403:
                return resp
        except Exception as exc:
            last_err = exc
            continue
    if last is not None:
        return last
    if last_err:
        raise last_err
    raise RuntimeError('playback_http_post failed')

UHD_PROFILES = [
    # Probe / playback order — verified 4K ladders on dck1-ac-vod (F1 UHD catchup).
    {'id': 'web-playready-4k-cap', 'DrmType': 'PLAYREADY', 'Platform': 'web', 'PlayerId': '@dazn/peng-html5-core/web/web', 'Model': 'Chrome', 'Manufacturer': 'google', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'webos-lg-4k', 'DrmType': 'PLAYREADY', 'Platform': 'webos', 'PlayerId': '@dazn/peng-html5-core/tv-next/tv', 'Model': '43UR8050PSB', 'Manufacturer': 'lg', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'tizen-samsung-4k', 'DrmType': 'PLAYREADY', 'Platform': 'tizen', 'PlayerId': '@dazn/peng-html5-core/tizen/tizen', 'Model': 'QN55Q80AAU', 'Manufacturer': 'samsung', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'androidtv-4k', 'DrmType': 'PLAYREADY', 'Platform': 'androidtv', 'PlayerId': '@dazn/peng-html5-core/androidtv/androidtv', 'Model': 'SHIELD Android TV', 'Manufacturer': 'NVIDIA', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'firetv-4k', 'DrmType': 'PLAYREADY', 'Platform': 'firetv', 'PlayerId': '@dazn/peng-html5-core/firetv/firetv', 'Model': 'AFTKA', 'Manufacturer': 'Amazon', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'appletv-4k', 'DrmType': 'PLAYREADY', 'Platform': 'appletv', 'PlayerId': '@dazn/peng-html5-core/appletv/appletv', 'Model': 'Apple TV 4K', 'Manufacturer': 'Apple', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'xbox-playready', 'DrmType': 'PLAYREADY', 'Platform': 'xboxone', 'PlayerId': '@dazn/peng-html5-core/xbox/xbox', 'Model': 'Xbox Series X', 'Manufacturer': 'Microsoft', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'ps5-playready', 'DrmType': 'PLAYREADY', 'Platform': 'ps5', 'PlayerId': '@dazn/peng-html5-core/ps5/ps5', 'Model': 'PlayStation 5', 'Manufacturer': 'Sony', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'hisense-vidaa-sl3000', 'DrmType': 'PLAYREADY', 'Platform': 'vidaa', 'PlayerId': '@dazn/peng-html5-core/vidaa/vidaa', 'Model': '43A6101EU', 'Manufacturer': 'Hisense', 'PlayReadyInitiator': 'true', 'Capabilities': '4k,hdr,hevc,mta'},
    {'id': 'chromecast-4k', 'DrmType': 'PLAYREADY', 'Platform': 'chromecast', 'PlayerId': '@dazn/peng-html5-core/chromecast/chromecast', 'Model': 'Chromecast with Google TV 4K', 'Manufacturer': 'Google', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
    {'id': 'sony-androidtv-4k', 'DrmType': 'PLAYREADY', 'Platform': 'androidtv', 'PlayerId': '@dazn/peng-html5-core/androidtv/androidtv', 'Model': 'BRAVIA 4K GB', 'Manufacturer': 'Sony', 'PlayReadyInitiator': 'false', 'Capabilities': CAPS_4K},
]

# First UHD attempt: webOS TV Widevine + 4k capabilities (often dck1-ac-vod 2160p before PlayReady TV IDs).
DEFAULT_UHD_PROFILE_ID = 'webos-widevine'
UHD_CURL_TRY_ORDER_ALL = ['webos-widevine', *[p['id'] for p in UHD_PROFILES]]


def uhd_profile_try_order():
    forced = (os.environ.get('KAYO_UHD_PROFILE') or '').strip()
    if forced:
        return [forced]
    if os.environ.get('KAYO_UHD_PROBE_ALL') == '1':
        return UHD_CURL_TRY_ORDER_ALL
    return [DEFAULT_UHD_PROFILE_ID]

WEB_WIDEVINE = {
    'id': 'web-widevine',
    'DrmType': 'WIDEVINE',
    'Platform': 'web',
    'PlayerId': '@dazn/peng-html5-core/web/web',
    'Model': 'Chrome',
    'Manufacturer': 'google',
    'PlayReadyInitiator': 'false',
    'Capabilities': 'hdr,hevc,mta',
}

WEBOS_WIDEVINE = {
    'id': 'webos-widevine',
    'DrmType': 'WIDEVINE',
    'Platform': 'webos',
    'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
    'Model': '43UR8050PSB',
    'Manufacturer': 'lg',
    'PlayReadyInitiator': 'false',
    'Capabilities': '4k,dd,ddp,hdr,hevc,mta',
}


def load_token_file():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    path = os.environ.get('KAYO_TOKEN_FILE') or os.path.join(root, 'kayo-token.json')
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}


def load_dotenv():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    path = os.path.join(root, '.env')
    if not os.path.isfile(path):
        return
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip()
            value = value.strip()
            if key and key not in os.environ:
                os.environ[key] = value


def token_payload(token):
    try:
        part = token.split('.')[1]
        part += '=' * (-len(part) % 4)
        return json.loads(base64.urlsafe_b64decode(part).decode())
    except Exception:
        return {}


def playback_headers(token, session_id=None, device_id=None):
    pl = token_payload(token)
    headers = {
        'Accept': '*/*',
        'Authorization': f'Bearer {token.replace("Bearer ", "")}',
        'X-BRAND': 'KAYO',
        'Origin': 'https://tv.kayosports.com.au',
        'Referer': 'https://tv.kayosports.com.au/',
        'Accept-Language': 'en-AU,en;q=0.9',
        'x-correlation-id': str(uuid.uuid4()),
    }
    if device_id or pl.get('deviceId'):
        headers['x-dazn-device'] = device_id or pl.get('deviceId')
    if pl.get('user'):
        headers['x-daznid'] = pl['user']
    if session_id:
        headers['x-session-id'] = session_id
    return headers


def build_profile_url(asset_id, token, profile):
    pl = token_payload(token)
    viewer_id = pl.get('viewerId') or ''
    session_id = f'{int(time.time() * 1000)}-{viewer_id}-{asset_id}-67BC9B'
    params = {
        'AppVersion': APP_VERSION,
        'Format': 'MPEG-DASH',
        'Secure': 'true',
        'AssetId': asset_id,
        'MtaLanguageCode': '',
        'LanguageCode': 'en',
        'SessionId': session_id,
        **{k: v for k, v in profile.items() if k != 'id'},
    }
    return f'{PLAYBACK_BASE}?{urlencode(params)}'


def mpd_max_height(mpd_url, headers):
    resp = requests.get(mpd_url, headers={**headers, 'Accept': '*/*'}, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
    if resp.status_code != 200:
        return 0, resp.status_code
    heights = [int(x) for x in re.findall(r'height="(\d+)"', resp.text)]
    return (max(heights) if heights else 0), 200


def pick_cdn_entry(details):
    for name in ('dck1-ac-vod', 'dck1-fs-vod', 'dck1-ac-live', 'dck1-fs-live'):
        entry = next((d for d in details if d.get('CdnName') == name), None)
        if entry and entry.get('ManifestUrl'):
            return entry
    return next((d for d in details if d.get('ManifestUrl')), None)


def jinx_playback_headers(token, device_uuid):
    pl = token_payload(token)
    return {
        'Accept': 'application/json, text/plain, */*',
        'Authorization': f'Bearer {token.replace("Bearer ", "")}',
        'Origin': 'https://tv.kayosports.com.au',
        'Referer': 'https://tv.kayosports.com.au/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'x-brand': 'KAYO',
        'x-correlation-id': str(uuid.uuid4()),
        'x-dazn-device': device_uuid,
        'x-daznid': pl.get('user') or '',
    }


def playback_post_hisense_url(asset_id):
    params = {
        'AppVersion': APP_VERSION,
        'DrmType': 'PLAYREADY',
        'Format': 'MPEG-DASH',
        'PlayerId': '@dazn/peng-html5-core/vidaa/vidaa',
        'Platform': 'vidaa',
        'Model': '43A6101EU',
        'Secure': 'true',
        'Manufacturer': 'Hisense',
        'PlayReadyInitiator': 'true',
        'Capabilities': '4k,hdr,hevc,mta',
        'AssetId': asset_id,
        'MtaLanguageCode': '',
        'LanguageCode': 'en',
    }
    return f'{PLAYBACK_BASE}?{urlencode(params)}'


def playback_post_hisense_body():
    return json.dumps({
        'adParams': {
            'useMT': False,
            'isLat': '0',
            'deviceOs': 'vidaa',
            'optout': '0',
            'deviceBrand': 'HISENSE',
            'idType': '',
            'startPos': -1,
            'deviceType': 'Tv',
            'playerName': '@dazn/peng-html5-core/vidaa/vidaa',
            'playerVersion': APP_VERSION,
            'vpmute': '0',
            'wta': '0',
            'requestPausedAdsUrl': False,
        },
    })


def kayo_site_headers(token, session_id=None):
    headers = playback_headers(token, session_id)
    headers['Content-Type'] = 'application/json; charset=UTF-8'
    headers['Origin'] = 'https://kayosports.com.au'
    headers['Referer'] = 'https://kayosports.com.au/'
    return headers


def probe_playback_row(asset_id, token, profile, headers, auth_mode='jwt', method='GET'):
    name = profile['id'] if isinstance(profile, dict) else profile
    label = f'{name}+{auth_mode}' if method == 'GET' else f'{name}+post'
    try:
        if method == 'POST':
            url = playback_post_hisense_url(asset_id)
            body = playback_post_hisense_body()
            resp = playback_http_post(url, headers, body)
        else:
            url = build_profile_url(asset_id, token, profile)
            resp = playback_http_get(url, headers)
        if resp.status_code != 200:
            return {'profile': name, 'auth': auth_mode, 'method': method, 'status': resp.status_code, 'max_h': 0}
        pb = resp.json()
        entry = pick_cdn_entry(pb.get('PlaybackDetails') or [])
        if not entry:
            return {'profile': name, 'auth': auth_mode, 'method': method, 'status': 200, 'max_h': 0, 'note': 'no CDN'}
        mpd = entry.get('ManifestUrl') or ''
        if entry.get('CdnToken'):
            tok = entry['CdnToken']
            sep = '&' if '?' in mpd else '?'
            mpd += f'{sep}{tok["Name"]}={tok["Value"]}'
        seg_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://kayosports.com.au/',
            'Origin': 'https://tv.kayosports.com.au',
            'Accept': '*/*',
        }
        max_h, mpd_status = mpd_max_height(mpd, seg_headers)
        row = {
            'profile': name,
            'auth': auth_mode,
            'method': method,
            'status': 200,
            'cdn': entry.get('CdnName'),
            'max_h': max_h,
            'mpd_status': mpd_status,
        }
        if max_h >= 2160:
            row['playback'] = pb
        return row
    except Exception as exc:
        return {'profile': name, 'auth': auth_mode, 'method': method, 'error': str(exc), 'max_h': 0}


def profile_by_id(profile_id):
    if profile_id == 'webos-widevine':
        return WEBOS_WIDEVINE
    if profile_id == 'web-widevine':
        return WEB_WIDEVINE
    return next((p for p in UHD_PROFILES if p['id'] == profile_id), None)


def _note_best_from_row(row, best, best_any):
    if row.get('status') == 200 and row.get('max_h', 0) >= 2160:
        if best is None or row.get('max_h', 0) > best.get('max_h', 0):
            best = row
    if row.get('status') == 200 and (best_any is None or row.get('max_h', 0) > best_any.get('max_h', 0)):
        best_any = row
    return best, best_any


def probe_uhd_profiles(asset_id, token, session_id):
    load_dotenv()
    if os.environ.get('KAYO_UHD_PROBE_ALL') != '1':
        webos_row = probe_playback_row(
            asset_id, token, WEBOS_WIDEVINE, playback_headers(token, session_id), auth_mode='jwt', method='GET',
        )
        best = webos_row if webos_row.get('status') == 200 and webos_row.get('max_h', 0) >= 2160 else None
        best_any = webos_row if webos_row.get('status') == 200 else None
        all_blocked = webos_row.get('status') == 403
        return {'results': [webos_row], 'best': best, 'best_any': best_any, 'all_blocked': all_blocked}

    results = []
    best = None
    best_any = None
    device_uuid = str(uuid.uuid4())

    webos_row = probe_playback_row(
        asset_id, token, WEBOS_WIDEVINE, playback_headers(token, session_id), auth_mode='jwt', method='GET',
    )
    results.append(webos_row)
    best, best_any = _note_best_from_row(webos_row, best, best_any)

    post_row = probe_playback_row(
        asset_id, token, {'id': 'hisense-vidaa-post'}, kayo_site_headers(token, session_id), auth_mode='post', method='POST',
    )
    results.append(post_row)
    best, best_any = _note_best_from_row(post_row, best, best_any)

    for profile in UHD_PROFILES:
        attempts = [
            ('jwt', playback_headers(token, session_id)),
            ('tv-uuid', jinx_playback_headers(token, device_uuid)),
        ]
        profile_best = None
        for auth_mode, headers in attempts:
            row = probe_playback_row(asset_id, token, profile, headers, auth_mode=auth_mode, method='GET')
            results.append(row)
            if row.get('status') != 200:
                continue
            if profile_best is None or row.get('max_h', 0) > profile_best.get('max_h', 0):
                profile_best = row
        if not profile_best:
            continue
        best, best_any = _note_best_from_row(profile_best, best, best_any)

    playready_blocked = all(
        r.get('status') == 403
        for r in results
        if r.get('method') in ('GET', 'POST')
    )
    return {'results': results, 'best': best, 'best_any': best_any, 'all_blocked': playready_blocked}


def web_widevine_ad_body():
    return json.dumps({
        'adParams': {
            'useMT': False,
            'isLat': '0',
            'deviceOs': 'web',
            'optout': '0',
            'deviceBrand': '',
            'idType': '',
            'startPos': -1,
            'deviceType': 'Web',
            'playerName': '@dazn/peng-html5-core/web/web',
            'playerVersion': APP_VERSION,
            'vpmute': '0',
            'wta': '0',
            'requestPausedAdsUrl': False,
        },
    })


def build_widevine_url(asset_id, token):
    """Default HD profile — web Widevine (matches browser JWT)."""
    return build_profile_url(asset_id, token, WEB_WIDEVINE)


def _apply_cookie(headers, cookie_header):
    if not cookie_header:
        return headers
    out = dict(headers)
    out['Cookie'] = cookie_header
    return out


def fetch_playback_widevine(asset_id, token, session_id, cookie_header=None):
    """UHD-first webOS 4K Widevine, then web Widevine (HD default)."""
    attempts = [
        ('webos-get', 'GET', build_profile_url(asset_id, token, WEBOS_WIDEVINE), playback_headers(token, session_id), None),
        ('web-get', 'GET', build_profile_url(asset_id, token, WEB_WIDEVINE), kayo_site_headers(token, session_id), None),
        ('web-post', 'POST', build_profile_url(asset_id, token, WEB_WIDEVINE), kayo_site_headers(token, session_id), web_widevine_ad_body()),
    ]
    last_status = 0
    last_body = ''
    for _name, method, url, headers, body in attempts:
        headers = _apply_cookie(headers, cookie_header)
        if method == 'POST':
            resp = playback_http_post(url, headers, body)
        else:
            resp = playback_http_get(url, headers)
        if resp.status_code == 200:
            return resp.json()
        last_status = resp.status_code
        last_body = resp.text[:300]
    return {'error': f'Playback API HTTP {last_status}', 'body': last_body}


def fetch_playback_vidaa_post(asset_id, token, session_id, cookie_header=None):
    url = playback_post_hisense_url(asset_id)
    headers = _apply_cookie(kayo_site_headers(token, session_id), cookie_header)
    resp = playback_http_post(url, headers, playback_post_hisense_body())
    if resp.status_code != 200:
        return {'error': f'Playback API HTTP {resp.status_code}', 'body': resp.text[:300]}
    return resp.json()


def fetch_playback_profile_by_id(asset_id, token, session_id, profile_id, cookie_header=None):
    profile = profile_by_id(profile_id)
    if not profile:
        return {'error': f'unknown profile {profile_id}'}
    url = build_profile_url(asset_id, token, profile)
    headers = playback_headers(token, session_id)
    if profile.get('DrmType') == 'WIDEVINE' and profile.get('Platform') == 'web':
        headers = kayo_site_headers(token, session_id)
    headers = _apply_cookie(headers, cookie_header)
    resp = playback_http_get(url, headers)
    if resp.status_code != 200:
        return {'error': f'Playback API HTTP {resp.status_code}', 'body': resp.text[:300]}
    return resp.json()


fetch_playback_uhd_profile = fetch_playback_profile_by_id


def fetch_playready_jinx(asset_id, token, device_uuid):
    url = build_widevine_url(asset_id, token).replace('DrmType=WIDEVINE', 'DrmType=PLAYREADY')
    headers = jinx_playback_headers(token, device_uuid)
    resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
    if resp.status_code != 200:
        return {'ok': False, 'status': resp.status_code, 'body': resp.text[:300]}
    return {'ok': True, 'playback': resp.json()}


def probe_live_cdn(manifest_url):
    import re
    from urllib.parse import unquote

    # MPD + init: no Referer/Origin/UA — Kayo CDN tokens 401 when browser headers are sent.
    resp = requests.get(manifest_url, impersonate='chrome120', timeout=25, proxies=NO_PROXY)
    if resp.status_code != 200:
        return {'ok': False, 'mpd_status': resp.status_code, 'init_status': 0}

    base = manifest_url.split('index.mpd')[0]
    match = re.search(r'initialization="([^"]+)"', resp.text)
    if not match:
        return {'ok': False, 'mpd_status': 200, 'init_status': 0, 'error': 'no init template'}

    seg = match.group(1).replace('&amp;', '&')
    if 'dazn-token' not in seg:
        tok = re.search(r'dazn-token=([^&]+)', manifest_url)
        if tok:
            sep = '&' if '?' in seg else '?'
            seg += f"{sep}dazn-token={unquote(tok.group(1))}"

    init_url = base + seg
    init_resp = requests.get(init_url, impersonate='chrome120', timeout=25, proxies=NO_PROXY)
    return {
        'ok': init_resp.status_code == 200,
        'mpd_status': 200,
        'init_status': init_resp.status_code,
    }


def main():
    load_dotenv()
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'usage: curl-playback.py <command> ...'}))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == 'probe-uhd':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        session_id = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
        print(json.dumps(probe_uhd_profiles(asset_id, token, session_id)))
        return

    if cmd == 'playback-profile':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        profile_id = sys.argv[4]
        session_id = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None
        result = fetch_playback_profile_by_id(asset_id, token, session_id, profile_id)
        if result.get('error'):
            print(json.dumps(result))
            sys.exit(2)
        print(json.dumps(result))
        return

    if cmd == 'playback':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        session_id = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
        result = fetch_playback_widevine(asset_id, token, session_id)
        if result.get('error'):
            print(json.dumps(result))
            sys.exit(2)
        print(json.dumps(result))
        return

    if cmd == 'playback-cookie':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        cookie_b64 = sys.argv[4]
        session_id = sys.argv[5] if len(sys.argv) > 5 else None
        cookie = base64.b64decode(cookie_b64).decode('utf-8', errors='replace')
        result = fetch_playback_widevine(asset_id, token, session_id, cookie)
        if result.get('error'):
            print(json.dumps(result))
            sys.exit(2)
        print(json.dumps(result))
        return

    if cmd == 'playback-vidaa-cookie':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        cookie_b64 = sys.argv[4]
        session_id = sys.argv[5] if len(sys.argv) > 5 else None
        cookie = base64.b64decode(cookie_b64).decode('utf-8', errors='replace')
        result = fetch_playback_vidaa_post(asset_id, token, session_id, cookie)
        if result.get('error'):
            print(json.dumps(result))
            sys.exit(2)
        print(json.dumps(result))
        return

    if cmd == 'playback-profile-cookie':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        profile_id = sys.argv[4]
        cookie_b64 = sys.argv[5]
        session_id = sys.argv[6] if len(sys.argv) > 6 else None
        cookie = base64.b64decode(cookie_b64).decode('utf-8', errors='replace')
        result = fetch_playback_uhd_profile(asset_id, token, session_id, profile_id, cookie)
        if result.get('error'):
            print(json.dumps(result))
            sys.exit(2)
        print(json.dumps(result))
        return

    if cmd == 'playback-playready-jinx':
        asset_id = sys.argv[2]
        token = sys.argv[3]
        device_uuid = sys.argv[4]
        print(json.dumps(fetch_playready_jinx(asset_id, token, device_uuid)))
        return

    if cmd == 'probe-live-cdn':
        url = sys.argv[2]
        print(json.dumps(probe_live_cdn(url)))
        return

    if cmd == 'get-mpd-auth':
        url = sys.argv[2]
        token = sys.argv[3]
        headers = playback_headers(token)
        headers.update({
            'Accept': '*/*',
            'Origin': 'https://tv.kayosports.com.au',
            'Referer': 'https://tv.kayosports.com.au/',
        })
        resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code < 200 or resp.status_code >= 300:
            print(json.dumps({
                'error': f'HTTP {resp.status_code}',
                'body': resp.text[:300],
            }))
            sys.exit(2)
        print(json.dumps({'text': resp.text}))
        return

    if cmd == 'get-mpd':
        url = sys.argv[2]
        resp = requests.get(url, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code < 200 or resp.status_code >= 300:
            print(json.dumps({
                'error': f'HTTP {resp.status_code}',
                'body': resp.text[:300],
            }))
            sys.exit(2)
        print(json.dumps({'text': resp.text}))
        return

    if cmd == 'get':
        url = sys.argv[2]
        token = sys.argv[3]
        headers = playback_headers(token)
        headers['Accept'] = '*/*'
        resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
        if resp.status_code < 200 or resp.status_code >= 300:
            print(json.dumps({
                'error': f'HTTP {resp.status_code}',
                'body': resp.text[:300],
            }))
            sys.exit(2)
        print(json.dumps({'text': resp.text}))
        return

    if cmd == 'post':
        url = sys.argv[2]
        token = sys.argv[3]
        body_b64 = sys.argv[4]
        content_type = sys.argv[5] if len(sys.argv) > 5 else 'application/octet-stream'
        session_id = None
        tok_meta = load_token_file()
        if tok_meta.get('sessionId'):
            session_id = tok_meta.get('sessionId')
        headers = playback_headers(token, session_id)
        headers['Content-Type'] = content_type
        if len(sys.argv) > 6 and sys.argv[6]:
            try:
                headers.update(json.loads(sys.argv[6]))
            except json.JSONDecodeError:
                pass
        body = base64.b64decode(body_b64)
        resp = requests.post(
            url,
            headers=headers,
            data=body,
            impersonate='chrome120',
            timeout=45,
            proxies=curl_proxies(),
        )
        if resp.status_code != 200:
            print(json.dumps({
                'error': f'HTTP {resp.status_code}',
                'body': resp.text[:300],
            }))
            sys.exit(2)
        print(json.dumps({'b64': base64.b64encode(resp.content).decode()}))
        return

    print(json.dumps({'error': f'unknown command {cmd}'}))
    sys.exit(1)


if __name__ == '__main__':
    main()
