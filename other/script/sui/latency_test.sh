#!/usr/bin/env bash

# ==========================================
# VLESS 域名优选测速脚本
# 功能:
# 1. 内置域名池
# 2. 每次随机抽20-30个
# 3. TLS握手测速
# 4. 输出最快域名
# ==========================================


# 随机测试数量
COUNT=$((RANDOM % 11 + 20))


# ==========================
# 域名池
# ==========================

DOMAINS_POOL=(
    amd.com aws.com c.6sc.co j.6sc.co b.6sc.co intel.com r.bing.com th.bing.com www.amd.com www.aws.com www.xbox.com www.sony.com rum.hlx.page www.bing.com www.wowt.com www.intel.com www.tesla.com www.xilinx.com www.oracle.com c.marsflag.com www.nvidia.com snap.licdn.com aws.amazon.com drivers.amd.com cdn.bizibly.com s.go-mpulse.net tags.tiqcdn.com cdn.bizible.com cdn.userway.org download.amd.com d1.awsstatic.com s0.awsstatic.com mscom.demdex.net a0.awsstatic.com apps.mzstatic.com sisu.xboxlive.com s.mp.marsflag.com images.nvidia.com vs.aws.amazon.com c.s-microsoft.com beacon.gtv-pub.com ts4.tc.mm.bing.net ts3.tc.mm.bing.net d2c.aws.amazon.com ts1.tc.mm.bing.net ce.mf.marsflag.com d0.m.awsstatic.com t0.m.awsstatic.com ts2.tc.mm.bing.net"  "tag.demandbase.com assets-www.xbox.com logx.optimizely.com azure.microsoft.com aadcdn.msftauth.net d.oracleinfinity.io assets.adobedtm.com lpcdn.lpsnmedia.net res-1.cdn.office.net is1-ssl.mzstatic.com electronics.sony.com acctcdn.msftauth.net cdnssl.clicktale.net catalog.gamepass.com consent.trustarc.com gsp-ssl.ls.apple.com munchkin.marketo.net s.company-target.com cdn77.api.userway.org cua-chat-ui.tesla.com assets-xbxweb.xbox.com ds-aksb-a.akamaihd.net static.cloud.coveo.com api.company-target.com devblogs.microsoft.com s7mbrstream.scene7.com fpinit.itunes.apple.com digitalassets.tesla.com d.impactradius-event.com downloadmirror.intel.com iosapps.itunes.apple.com se-edge.itunes.apple.com publisher.liveperson.net tag-logger.demandbase.com services.digitaleast.mobi configuration.ls.apple.com gray-wowt-prod.gtv-cdn.com visualstudio.microsoft.com prod.log.shortbread.aws.dev amp-api-edge.apps.apple.com store-images.s-microsoft.com cdn-dynmedia-1.microsoft.com github.gallerycdn.vsassets.io prod.pa.cdn.uis.awsstatic.com a.b.cdn.console.awsstatic.com d3agakyjgjv5i8.cloudfront.net vscjava.gallerycdn.vsassets.io location-services-prd.tesla.com ms-vscode.gallerycdn.vsassets.io ms-python.gallerycdn.vsassets.io gray-config-prod.api.arc-cdn.net i7158c100-ds-aksb-a.akamaihd.net downloaddispatch.itunes.apple.com res.public.onecdn.static.microsoft gray.video-player.arcpublishing.com gray-config-prod.api.cdn.arcpublishing.com img-prod-cms-rt-microsoft-com.akamaized.net prod.us-east-1.ui.gcr-chat.marketing.aws.dev
)


echo "随机测试数量: $COUNT"


RESULT=$(mktemp)


echo
echo "=============================="
echo "随机域名列表"
echo "=============================="


DOMAINS=$(printf "%s\n" "${DOMAIN_POOL[@]}" | sort -R | head -n "$COUNT")


echo "$DOMAINS"


echo
echo "=============================="
echo "开始测速"
echo "=============================="


while read -r d
do

    [ -z "$d" ] && continue


    t1=$(date +%s%3N)


    timeout 1 openssl s_client \
        -connect "$d:443" \
        -servername "$d" \
        </dev/null &>/dev/null


    if [ $? -eq 0 ]; then

        t2=$(date +%s%3N)

        ms=$((t2-t1))


        echo "$ms $d" >> "$RESULT"


        echo "OK   $d : ${ms} ms"

    else

        echo "FAIL $d"

    fi


done <<< "$DOMAINS"



echo
echo "=============================="
echo "测速结果数量"
echo "=============================="

wc -l "$RESULT"


echo
echo "=============================="
echo "延迟最低 TOP 3"
echo "=============================="


sort -n "$RESULT" | head -3


echo
echo "=============================="
echo "最快域名"
echo "=============================="


sort -n "$RESULT" | head -1 | awk '{print $2}'


rm -f "$RESULT"