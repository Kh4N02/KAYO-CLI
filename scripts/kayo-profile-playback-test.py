#!/usr/bin/env python3
"""Sign in, list Kayo household profiles, SwitchProfile, test Playback (webOS 4K Widevine)."""
import base64
import json
import os
import sys
import uuid
import time
from urllib.parse import urlencode

from curl_cffi import requests

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PLAYBACK_BASE = 'https://api.playback.indazn.com/v5/Playback'
APP_VERSION = '0.134.1-hotfix.f7e0d40f1'
NO_PROXY = {'http': None, 'https': None, 'all': None}

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

AUTH_V5 = 'https://authentication-prod.ar.indazn.com/v5/SignIn'
PROFILE_V4 = 'https://user-profile.ar.indazn.com/v4/UserProfile'
SWITCH_V1 = 'https://authentication-prod.ar.indazn.com/v1/SwitchProfile'
ASSET = sys.argv[1] if len(sys.argv) > 1 else '47lg4yrp7l7j1p9432wz832v3'


def load_dotenv():
    path = os.path.join(ROOT, '.env')
    if os.path.isfile(path):
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())


def webshare_proxies():
    raw = (os.environ.get('KAYO_PROXY') or '').strip()
    if not raw or raw.startswith('http'):
        return None
    parts = raw.split(':')
    if len(parts) < 4:
        return None
    host, port, user = parts[0], parts[1], parts[2]
    password = ':'.join(parts[3:])
    from urllib.parse import quote
    url = f'http://{quote(user, safe="")}:{quote(password, safe="")}@{host}:{port}'
    return {'http': url, 'https': url, 'all': url}


def curl_proxies():
    load_dotenv()
    tunnel = (os.environ.get('KAYO_PROXY_TUNNEL') or '').strip()
    if tunnel:
        url = tunnel if tunnel.startswith('http') else f'http://{tunnel}'
        return {'http': url, 'https': url, 'all': url}
    return NO_PROXY


def playback_proxy_chain():
    load_dotenv()
    chain = [NO_PROXY]
    tunnel = curl_proxies()
    if tunnel is not NO_PROXY:
        chain.append(tunnel)
    ws = webshare_proxies()
    if ws:
        chain.append(ws)
    return chain


def token_payload(token):
    part = token.split('.')[1]
    part += '=' * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part))


def playback_headers(token, session_id=None):
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
    if pl.get('deviceId'):
        headers['x-dazn-device'] = pl['deviceId']
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


def pick_cdn_entry(details):
    for name in ('dck1-ac-vod', 'dck1-fs-vod', 'dck1-ac-live', 'dck1-fs-live'):
        entry = next((d for d in details if d.get('CdnName') == name), None)
        if entry and entry.get('ManifestUrl'):
            return entry
    return next((d for d in details if d.get('ManifestUrl')), None)


def mpd_max_height(mpd_url, headers):
    import re
    resp = requests.get(mpd_url, headers={**headers, 'Accept': '*/*'}, impersonate='chrome120', timeout=45, proxies=NO_PROXY)
    if resp.status_code != 200:
        return 0, resp.status_code
    heights = [int(x) for x in re.findall(r'height="(\d+)"', resp.text)]
    return (max(heights) if heights else 0), 200


def jinx_headers(token=None):
    h = {
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://tv.kayosports.com.au',
        'Referer': 'https://tv.kayosports.com.au/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'x-brand': 'KAYO',
        'x-correlation-id': str(uuid.uuid4()),
    }
    if token:
        h['Authorization'] = f'Bearer {token.replace("Bearer ", "")}'
    return h


def http_json(method, url, headers, body=None, proxies=None):
    if proxies is None:
        proxies = NO_PROXY
    kw = dict(headers=headers, impersonate='chrome120', timeout=45, proxies=proxies)
    if method == 'GET':
        resp = requests.get(url, **kw)
    else:
        resp = requests.post(url, json=body, **kw)
    return resp.status_code, resp.text


def try_proxies(method, url, headers, body=None):
    last = (0, '')
    for proxies in playback_proxy_chain():
        try:
            status, text = http_json(method, url, headers, body, proxies)
            last = (status, text)
            if status == 200:
                return status, text, proxies
            if status != 403:
                return status, text, proxies
        except Exception as exc:
            last = (0, str(exc))
            continue
    return last[0], last[1], None


def test_playback(token, session_id, asset_id):
    device_uuid = str(uuid.uuid4())
    url = build_profile_url(asset_id, token, WEBOS_WIDEVINE)
    headers = playback_headers(token, session_id)
    headers.update({
        'x-dazn-device': device_uuid,
        'Origin': 'https://tv.kayosports.com.au',
        'Referer': 'https://tv.kayosports.com.au/',
    })
    for proxies in playback_proxy_chain():
        try:
            resp = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=proxies)
            if resp.status_code != 200:
                continue
            pb = resp.json()
            entry = pick_cdn_entry(pb.get('PlaybackDetails') or [])
            if not entry:
                return 200, 0, '?'
            mpd = entry.get('ManifestUrl') or ''
            if entry.get('CdnToken'):
                sep = '&' if '?' in mpd else '?'
                mpd += f"{sep}{entry['CdnToken']['Name']}={entry['CdnToken']['Value']}"
            max_h, _ = mpd_max_height(mpd, {'Accept': '*/*'})
            return 200, max_h, entry.get('CdnName')
        except Exception:
            continue
    return 403, 0, None


def main():
    load_dotenv()
    email = os.environ.get('KAYO_EMAIL', '').strip()
    password = os.environ.get('KAYO_PASSWORD', '').strip()
    if not email or not password:
        print(json.dumps({'error': 'KAYO_EMAIL/KAYO_PASSWORD required'}))
        sys.exit(2)

    device_id = '00' + uuid.uuid4().hex[:10]
    auth_body = {
        'Email': email,
        'Password': password,
        'Platform': 'webos',
        'DeviceId': device_id,
        'ProfilingSessionId': uuid.uuid4().hex[:20],
        'Brand': 'KAYO',
    }
    status, text, _ = try_proxies('POST', AUTH_V5, jinx_headers(), auth_body)
    if status != 200:
        snippet = text[:200]
        if '10075' in text or 'via VPN' in text:
            print(f'SignIn failed HTTP {status}: DAZN blocks this exit as VPN (10075). Rotate KAYO-AU in Clash or use browser login / KAYO_TOKEN.')
        else:
            print(f'SignIn failed HTTP {status}: {snippet}')
        sys.exit(2)
    initial = json.loads(text)['AuthToken']['Token']
    pl = token_payload(initial)

    status, text, _ = try_proxies('GET', PROFILE_V4, jinx_headers(initial))
    if status != 200:
        print(f'UserProfile failed HTTP {status}: {text[:200]}')
        sys.exit(2)
    prof_data = json.loads(text)
    profiles = prof_data.get('Profiles') or prof_data.get('profiles') or []
    if not profiles and prof_data.get('ViewerId'):
        profiles = [{'Id': prof_data['ViewerId'], 'Name': 'Default', 'ViewerId': prof_data['ViewerId']}]

    print(f'Household profiles: {len(profiles)}')
    session_id = str(uuid.uuid4())
    best = None
    for p in profiles:
        pid = p.get('Id') or p.get('id') or p.get('ViewerId')
        name = p.get('Name') or p.get('name') or pid
        if not pid:
            continue
        sw_headers = jinx_headers(initial)
        sw_headers['x-daznid'] = pl.get('user') or ''
        sw_headers['x-session-id'] = session_id
        status, text, _ = try_proxies('POST', SWITCH_V1, sw_headers, {'brand': 'kayo', 'profileId': pid})
        if status != 200:
            print(f'  {name}: SwitchProfile HTTP {status}')
            continue
        switched = json.loads(text)['AuthToken']['Token']
        spl = token_payload(switched)
        allow4k = False
        for es in (spl.get('entitlements') or {}).get('entitlementSets') or []:
            if es.get('allow4k'):
                allow4k = True
        pb_status, max_h, cdn = test_playback(switched, session_id, ASSET)
        tier = 'unknown'
        for es in (spl.get('entitlements') or {}).get('entitlementSets') or []:
            tier = es.get('id') or tier
        line = f'  {name}: tier={tier} allow4k={allow4k} playback={pb_status} max_h={max_h} cdn={cdn}'
        print(line)
        if pb_status == 200 and (best is None or max_h > best[0]):
            best = (max_h, name, pid, switched)

    if best:
        print(f'BEST: {best[1]} ({best[0]}p) profileId={best[2]}')
        out = os.path.join(ROOT, 'kayo-token.json')
        prev = {}
        if os.path.isfile(out):
            try:
                prev = json.load(open(out, encoding='utf-8'))
            except Exception:
                pass
        prev.update({'token': best[3], 'sessionId': session_id, 'profileId': best[2], 'updated': time.strftime('%Y-%m-%dT%H:%M:%SZ')})
        json.dump(prev, open(out, 'w', encoding='utf-8'), indent=2)
        print(f'Token saved → {out}')
    else:
        print('No profile returned Playback 200 for this asset.')
        sys.exit(1)


if __name__ == '__main__':
    main()
