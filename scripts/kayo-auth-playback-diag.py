#!/usr/bin/env python3
"""SignIn + HD vs 4K Playback GET per proxy path (curl_cffi). Used by kayo-connectivity-check.js."""
import json
import os
import sys
import time
import uuid
from urllib.parse import quote, urlencode

from curl_cffi import requests

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PLAYBACK = 'https://api.playback.indazn.com/v5/Playback'
AUTH = 'https://authentication-prod.ar.indazn.com/v5/SignIn'
APP = '0.134.1-hotfix.f7e0d40f1'
ASSET = os.environ.get('KAYO_DIAG_ASSET') or (sys.argv[1] if len(sys.argv) > 1 else '47lg4yrp7l7j1p9432wz832v3')

WEB_WV = {
    'DrmType': 'WIDEVINE', 'Platform': 'web', 'PlayerId': '@dazn/peng-html5-core/web/web',
    'Model': 'Chrome', 'Manufacturer': 'google', 'PlayReadyInitiator': 'false', 'Capabilities': 'hd,hevc',
}
WEBOS_4K_WV = {
    'DrmType': 'WIDEVINE', 'Platform': 'webos', 'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
    'Model': '43UR8050PSB', 'Manufacturer': 'lg', 'PlayReadyInitiator': 'false',
    'Capabilities': '4k,dd,ddp,hdr,hevc,mta',
}
WEBOS_4K_PR = {
    'DrmType': 'PLAYREADY', 'Platform': 'webos', 'PlayerId': '@dazn/peng-html5-core/tv-next/tv',
    'Model': '43UR8050PSB', 'Manufacturer': 'lg', 'PlayReadyInitiator': 'false',
    'Capabilities': '4k,dd,ddp,hdr,hevc,mta',
}


def load_dotenv():
    path = os.path.join(ROOT, '.env')
    if os.path.isfile(path):
        for line in open(path, encoding='utf-8'):
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())


def webshare_url(host, port, user, password):
    return f'http://{quote(user, safe="")}:{quote(password, safe="")}@{host}:{port}'


def proxy_paths():
    paths = [('system/TUN (no HTTP proxy)', {'http': None, 'https': None})]
    tunnel = (os.environ.get('KAYO_PROXY_TUNNEL') or '').strip()
    if tunnel:
        u = tunnel if tunnel.startswith('http') else f'http://{tunnel}'
        paths.append((f'Clash HTTP {tunnel}', {'http': u, 'https': u}))
    return paths


def token_payload(token):
    import base64
    part = token.split('.')[1]
    part += '=' * (-len(part) % 4)
    return json.loads(base64.urlsafe_b64decode(part))


def sign_in(proxies):
    email = os.environ.get('KAYO_EMAIL', '').strip()
    password = os.environ.get('KAYO_PASSWORD', '').strip()
    if not email or not password:
        return None, 0, 'KAYO_EMAIL/KAYO_PASSWORD not set'
    body = {
        'Email': email, 'Password': password, 'Platform': 'webos',
        'DeviceId': '00' + uuid.uuid4().hex[:10],
        'ProfilingSessionId': uuid.uuid4().hex[:20], 'Brand': 'KAYO',
    }
    headers = {
        'Accept': 'application/json', 'Origin': 'https://tv.kayosports.com.au',
        'Referer': 'https://tv.kayosports.com.au/', 'x-brand': 'KAYO',
    }
    try:
        r = requests.post(AUTH, json=body, headers=headers, impersonate='chrome120', timeout=45, proxies=proxies)
    except Exception as exc:
        return None, -1, str(exc)[:160]
    if r.status_code != 200:
        return None, r.status_code, r.text[:220]
    return json.loads(r.text)['AuthToken']['Token'], 200, ''


def playback_url(asset_id, token, profile):
    pl = token_payload(token)
    viewer_id = pl.get('viewerId') or ''
    session_id = f'{int(time.time() * 1000)}-{viewer_id}-{asset_id}-67BC9B'
    params = {
        'AppVersion': APP, 'Format': 'MPEG-DASH', 'Secure': 'true', 'AssetId': asset_id,
        'MtaLanguageCode': '', 'LanguageCode': 'en', 'SessionId': session_id, **profile,
    }
    return f'{PLAYBACK}?{urlencode(params)}', session_id, pl


def playback_get(url, token, pl, session_id, proxies):
    headers = {
        'Accept': '*/*', 'Authorization': f'Bearer {token}', 'X-BRAND': 'KAYO',
        'Origin': 'https://tv.kayosports.com.au', 'Referer': 'https://tv.kayosports.com.au/',
        'Accept-Language': 'en-AU,en;q=0.9', 'x-correlation-id': str(uuid.uuid4()),
    }
    if pl.get('deviceId'):
        headers['x-dazn-device'] = pl['deviceId']
    if pl.get('user'):
        headers['x-daznid'] = pl['user']
    headers['x-session-id'] = session_id
    try:
        r = requests.get(url, headers=headers, impersonate='chrome120', timeout=45, proxies=proxies)
    except Exception as exc:
        return -1, str(exc)[:120]
    if r.status_code != 200:
        return r.status_code, r.text[:120].replace('\n', ' ')
    pb = r.json()
    cdns = [d.get('CdnName') for d in (pb.get('PlaybackDetails') or []) if d.get('ManifestUrl')]
    return 200, ','.join(cdns) or 'no cdn'


def explain_signin(status, body):
    if status == 200:
        return 'OK'
    if '10075' in body or 'via VPN' in body:
        return 'BLOCKED AS VPN (10075) — Webshare/datacenter AU IP; 4K API login fails here'
    if status == 403 and '<HTML>' in body.upper():
        return 'CloudFront/WAF 403 — need curl_cffi/Chrome TLS (HEAD/curl.exe often lies)'
    if status == -1:
        return f'connect error: {body}'
    return body[:100]


def main():
    load_dotenv()
    print(f'Asset: {ASSET}')
    any_ok = False
    for pname, proxies in proxy_paths():
        print(f'\n[{pname}]')
        token, st, err = sign_in(proxies)
        print(f'  SignIn: {explain_signin(st, err)}')
        if not token:
            continue
        any_ok = True
        pl = token_payload(token)
        allow4k = any(es.get('allow4k') for es in (pl.get('entitlements') or {}).get('entitlementSets') or [])
        print(f'  JWT allow4k={allow4k}')
        for label, prof in [
            ('1080p web-widevine', WEB_WV),
            ('4K webos-widevine', WEBOS_4K_WV),
            ('4K webos-playready', WEBOS_4K_PR),
        ]:
            url, sid, _ = playback_url(ASSET, token, prof)
            pst, detail = playback_get(url, token, pl, sid, proxies)
            print(f'  {label}: HTTP {pst} {detail}')

    if not any_ok:
        print('\n--- Why 1080p can work but 4K does not ---')
        print('  • 1080p often uses browser login (Playwright) + cached kayo-token.json + web Widevine.')
        print('  • 4K probes SignIn/Playback via curl with webOS 4K caps — blocked when exit IP = VPN.')
        print('  • Fix: browser login (KAYO_BROWSER_HEADLESS=0), rotate AU node in Clash KAYO-AU,')
        print('    or paste a fresh JWT as KAYO_TOKEN from Chrome while logged in on Kayo.')
        print('  • Raw Webshare from Python fails CONNECT on Windows — always use Clash port 7897.')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
