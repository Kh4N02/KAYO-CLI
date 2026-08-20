#!/usr/bin/env python3
"""Try UHD contentId variants on PlayReady license URL."""
import base64, json, re, time, uuid
from curl_cffi import requests
NO_PROXY={"http":None,"https":None,"all":None}
sess=json.load(open('kayo-token.json'))
token=sess['token']
p=token.split('.')[1]+'='*(-len(p)%4)
pl=json.loads(base64.urlsafe_b64decode(p))
asset='emfu5j39wp8385wo18re4vq81'
sid=f"{int(time.time()*1000)}-{pl.get('viewerId','')}-{asset}-67BC9B"
h={'Accept':'*/*','Authorization':'Bearer '+token,'X-BRAND':'KAYO','Origin':'https://kayosports.com.au','Referer':'https://kayosports.com.au/','x-dazn-device':pl.get('deviceId',''),'x-daznid':pl.get('user',''),'x-session-id':sess.get('sessionId',''),'x-correlation-id':str(uuid.uuid4())}
pb=requests.get(f'https://api.playback.indazn.com/v5/Playback?AppVersion=0.134.1-hotfix.f7e0d40f1&DrmType=WIDEVINE&Format=MPEG-DASH&PlayerId=%40dazn%2Fpeng-html5-core%2Ftv-next%2Ftv&Platform=webos&Model=43UR8050PSB&Secure=true&Manufacturer=lg&PlayReadyInitiator=false&Capabilities=4k%2Cdd%2Cddp%2Chdr%2Chevc%2Cmta&AssetId={asset}&MtaLanguageCode&LanguageCode=en&SessionId={sid}',headers=h,impersonate='chrome120',timeout=30,proxies=NO_PROXY).json()
la=next(d['LaUrl'] for d in pb['PlaybackDetails'] if d['CdnName']=='dck1-fs-vod')
base_cid=re.search(r'contentId=([^&]+)', la).group(1)
print('base', base_cid)
variants=[
 base_cid.replace('_HD_','_UHD_'),
 base_cid.replace('SE-HD-AVC','SE-UHD-HEVC'),
 base_cid.replace('HD_SE-HD','UHD_SE-UHD'),
 base_cid.replace('-HD-','-UHD-'),
 re.sub(r'_HD_', '_UHD_', base_cid),
 re.sub(r'HD_SE', 'UHD_SE', base_cid),
]
from pyplayready.cdm import Cdm
from pyplayready.device import Device
from pyplayready.system.pssh import PSSH
from pyplayready.misc.revocation_list import RevocationList
entry=next(d for d in pb['PlaybackDetails'] if d['CdnName']=='dck1-fs-vod')
mpd=entry['ManifestUrl']+('?' if '?' not in entry['ManifestUrl'] else '&')+entry['CdnToken']['Name']+'='+entry['CdnToken']['Value']
text=requests.get(mpd,headers=h,impersonate='chrome120',timeout=30,proxies=NO_PROXY).text
pssh=[p for p in re.findall(r'<cenc:pssh[^>]*>([^<]+)</cenc:pssh>', text) if b'\x9a\x04\xf0\x79' in base64.b64decode(p)][0]
prd='cmds/hisense_smarttv_43a6101eu_sl3000.prd'
for v in dict.fromkeys(variants):
    la2=re.sub(r'contentId=[^&]+', f'contentId={v}', la.replace('/widevine/','/playready/'))
    la2=re.sub(r'mediaId=[^&]+', f'mediaId={v}', la2)
    device=Device.load(prd); cdm=Cdm.from_device(device); s=cdm.open()
    req=cdm.get_license_challenge(s, PSSH(pssh).wrm_headers[0], rev_lists=RevocationList.SupportedListIds)
    lh={**h,'Content-Type':'text/xml; charset=UTF-8'}
    r=requests.post(la2,headers=lh,data=req,impersonate='chrome120',timeout=30,proxies=NO_PROXY)
    print(v[:60], '->', r.status_code, r.text[:60].replace('\n',' '))
    cdm.close(s)
