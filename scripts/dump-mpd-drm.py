#!/usr/bin/env python3
import base64, json, re, time, uuid
from curl_cffi import requests
NO_PROXY={"http":None,"https":None,"all":None}
sess=json.load(open('kayo-token.json'))
token=sess['token']
p=token.split('.')[1]+'='*(-len(token.split('.')[1])%4)
pl=json.loads(base64.urlsafe_b64decode(p))
asset='emfu5j39wp8385wo18re4vq81'
sid=f"{int(time.time()*1000)}-{pl.get('viewerId','')}-{asset}-67BC9B"
h={'Accept':'*/*','Authorization':'Bearer '+token,'X-BRAND':'KAYO','Origin':'https://kayosports.com.au','Referer':'https://kayosports.com.au/','x-dazn-device':pl.get('deviceId',''),'x-daznid':pl.get('user',''),'x-session-id':sess.get('sessionId',''),'x-correlation-id':str(uuid.uuid4())}
url=f'https://api.playback.indazn.com/v5/Playback?AppVersion=0.134.1-hotfix.f7e0d40f1&DrmType=WIDEVINE&Format=MPEG-DASH&PlayerId=%40dazn%2Fpeng-html5-core%2Ftv-next%2Ftv&Platform=webos&Model=43UR8050PSB&Secure=true&Manufacturer=lg&PlayReadyInitiator=false&Capabilities=4k%2Cdd%2Cddp%2Chdr%2Chevc%2Cmta&AssetId={asset}&MtaLanguageCode&LanguageCode=en&SessionId={sid}'
pb=requests.get(url,headers=h,impersonate='chrome120',timeout=30,proxies=NO_PROXY).json()
entry=next(d for d in pb['PlaybackDetails'] if d['CdnName']=='dck1-fs-vod')
mpd=entry['ManifestUrl']+('?' if '?' not in entry['ManifestUrl'] else '&')+entry['CdnToken']['Name']+'='+entry['CdnToken']['Value']
text=requests.get(mpd,headers=h,impersonate='chrome120',timeout=30,proxies=NO_PROXY).text
open('tmp_bangladesh.mpd','w',encoding='utf-8').write(text)
print('LaUrl API', entry.get('LaUrl','')[:100])
for pat in [r'<Laurl[^>]*>([^<]+)', r'mspr:pro[^>]*>([^<]+)', r'LA_URL>([^<]+)', r'9a04f079', r'edef8ba9', r'2160', r'hvc1', r'hev1', r'UHD']:
    m=re.findall(pat, text, re.I)
    print(pat, len(m), (m[0][:80] if m and len(str(m[0]))>10 else m[:3]))
# all pssh
for i,p in enumerate(re.findall(r'<cenc:pssh[^>]*>([^<]+)</cenc:pssh>', text)):
    raw=base64.b64decode(p)
    kind='PR' if b'\x9a\x04\xf0\x79' in raw else ('WV' if b'\xed\xef\x8b\xa9' in raw else '?')
    print('pssh', i, kind, len(set(re.findall(r'<cenc:pssh', text))), 'unique', len(set(re.findall(r'<cenc:pssh[^>]*>([^<]+)', text))))
