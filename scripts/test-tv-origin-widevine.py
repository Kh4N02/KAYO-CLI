#!/usr/bin/env python3
import base64, json, re, time, uuid
from urllib.parse import urlencode
from curl_cffi import requests
NO_PROXY = {'http': None, 'https': None, 'all': None}
with open('kayo-token.json') as f:
    sess = json.load(f)
TOKEN = sess['token']
pl = json.loads(base64.urlsafe_b64decode(TOKEN.split('.')[1] + '==' * (-len(TOKEN.split('.')[1]) % 4)).decode())
aid = 'emfu5j39wp8385wo18re4vq81'
sid = f"{int(time.time()*1000)}-{pl.get('viewerId','')}-{aid}-67BC9B"
params = urlencode({
    'AppVersion': '0.134.1-hotfix.f7e0d40f1', 'DrmType': 'WIDEVINE', 'Format': 'MPEG-DASH',
    'PlayerId': '@dazn/peng-html5-core/tv-next/tv', 'Platform': 'webos', 'Model': '43UR8050PSB',
    'Secure': 'true', 'Manufacturer': 'lg', 'PlayReadyInitiator': 'false',
    'Capabilities': '4k,dd,ddp,hdr,hevc,mta', 'AssetId': aid, 'MtaLanguageCode': '', 'LanguageCode': 'en', 'SessionId': sid,
})
for origin in ['https://tv.kayosports.com.au', 'https://kayosports.com.au']:
    h = {
        'Accept': 'application/json, text/plain, */*', 'Authorization': f'Bearer {TOKEN}',
        'Origin': origin, 'Referer': origin + '/', 'x-brand': 'KAYO',
        'x-dazn-device': pl.get('deviceId'), 'x-daznid': pl.get('user'), 'x-correlation-id': str(uuid.uuid4()),
    }
    r = requests.get(f'https://api.playback.indazn.com/v5/Playback?{params}', headers=h, impersonate='chrome120', proxies=NO_PROXY, timeout=45)
    entry = next((d for d in r.json().get('PlaybackDetails', []) if 'ac-vod' in d.get('CdnName', '')), None)
    mpd = entry['ManifestUrl'] + '&' + entry['CdnToken']['Name'] + '=' + entry['CdnToken']['Value']
    mr = requests.get(mpd, headers={**h, 'Accept': '*/*'}, impersonate='chrome120', proxies=NO_PROXY, timeout=45)
    hs = [int(x) for x in re.findall(r'height="(\d+)"', mr.text)]
    pr = len(re.findall(r'9a04f079', mr.text, re.I))
    print(origin, 'playback', r.status_code, 'max', max(hs) if hs else 0, 'pr_pssh', pr)
