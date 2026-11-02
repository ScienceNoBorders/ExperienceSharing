# CentOS 8 部署 WVP-PRO + ZLMediaKit 完整指南

> 适用于已有 CentOS 8 x86_64 服务器、海康/大华等 GB28181 摄像头、WVP-PRO + ZLMediaKit。
>
> **重要：CentOS Linux 8 已于 2021-12-31 EOL。** Vault 是历史快照，不提供新的安全更新。长期生产环境建议迁移到 Rocky Linux 8 / AlmaLinux 8 / RHEL 8。

## 1. 最终架构与端口

```text
海康摄像头
    │ GB28181 TCP
    │ SIP :10003
    ▼
WVP-PRO
    ├─ Web/API :10002
    └─ SIP     :10003
          │ HTTP API
          ▼
ZLMediaKit
    ├─ HTTP/API       :10005
    ├─ HTTPS          :10006
    ├─ RTMP           :10007
    ├─ WebRTC HTTP    :10008
    ├─ WebRTC HTTPS   :10009
    ├─ ICE/STUN       :10010
    ├─ WebRTC UDP     :10011
    ├─ WebRTC TCP     :10012
    ├─ RTSP           :10013
    ├─ SRT            :10014
    ├─ RTP Proxy      :10015
    ├─ RTP Pool       :10016-10080
    └─ ICE/TURN Pool  :10081-10100
```

| 端口 | 服务 | 协议 |
|---:|---|---|
| 10002 | WVP Web/API | TCP |
| 10003 | WVP GB28181 SIP | TCP/UDP |
| 10005 | ZLMediaKit HTTP/API | TCP |
| 10006 | ZLMediaKit HTTPS | TCP |
| 10007 | RTMP | TCP |
| 10008 | WebRTC HTTP | TCP |
| 10009 | WebRTC HTTPS | TCP |
| 10010 | ICE/STUN | TCP/UDP |
| 10011 | WebRTC RTP | UDP |
| 10012 | WebRTC RTP | TCP |
| 10013 | RTSP | TCP |
| 10014 | SRT | UDP |
| 10015 | RTP Proxy 主端口 | UDP |
| 10016-10080 | GB28181 RTP 动态端口池 | TCP/UDP |
| 10081-10100 | WebRTC ICE/TURN | TCP/UDP |

本方案不在服务器录像，录像由 NVR 完成。`10016-10080` 共 65 个连续端口，满足 ZLMediaKit PortManager 至少 36 个连续端口的要求。

---

# 2. 系统检查

```bash
cat /etc/redhat-release
uname -m
hostnamectl
free -h
df -h
timedatectl
```

设置时区：

```bash
timedatectl set-timezone Asia/Shanghai
timedatectl set-ntp true
```

---

# 3. CentOS 8 国内 DNF 源

CentOS Linux 8 已 EOL，正常镜像可能无法继续使用。推荐已有 CentOS 8 服务器使用国内 Vault。

## 3.1 备份原 repo

```bash
mkdir -p /etc/yum.repos.d/backup
mv /etc/yum.repos.d/CentOS-*.repo /etc/yum.repos.d/backup/ 2>/dev/null || true
```

## 3.2 阿里云 Vault

```bash
vi /etc/yum.repos.d/CentOS-Vault.repo
```

写入：

```ini
[baseos]
name=CentOS-8.5.2111 - BaseOS
baseurl=https://mirrors.aliyun.com/centos-vault/centos/8.5.2111/BaseOS/$basearch/os/
enabled=1
gpgcheck=0

[appstream]
name=CentOS-8.5.2111 - AppStream
baseurl=https://mirrors.aliyun.com/centos-vault/centos/8.5.2111/AppStream/$basearch/os/
enabled=1
gpgcheck=0

[powertools]
name=CentOS-8.5.2111 - PowerTools
baseurl=https://mirrors.aliyun.com/centos-vault/centos/8.5.2111/PowerTools/$basearch/os/
enabled=1
gpgcheck=0

[extras]
name=CentOS-8.5.2111 - Extras
baseurl=https://mirrors.aliyun.com/centos-vault/centos/8.5.2111/extras/$basearch/os/
enabled=1
gpgcheck=0
```

如果阿里云不可用，可使用华为云：

```text
https://repo.huaweicloud.com/centos-vault/centos/8.5.2111/
```

刷新：

```bash
dnf clean all
rm -rf /var/cache/dnf
dnf makecache
dnf repolist
```

---

# 4. 基础编译环境

```bash
dnf install -y git wget curl vim unzip zip tar gzip bzip2 make gcc gcc-c++ glibc-devel openssl openssl-devel libstdc++ libstdc++-devel zlib zlib-devel libtool autoconf automake pkgconfig ncurses-devel readline-devel libuuid-devel perl which net-tools lsof psmisc procps-ng ca-certificates
```

检查：

```bash
gcc --version
g++ --version
make --version
openssl version
git --version
```

如果需要 GCC Toolset：

```bash
dnf module list gcc-toolset
dnf install -y gcc-toolset-11
scl enable gcc-toolset-11 bash
gcc --version
```

---

# 5. CMake

```bash
dnf install -y cmake
cmake --version
```

如果出现：

```text
cmake: symbol lookup error:
cmake: undefined symbol: archive_write_add_filter_zstd
```

检查：

```bash
which cmake
rpm -q cmake
rpm -q libarchive
ldd /usr/bin/cmake | grep -i archive
nm -D /usr/lib64/libarchive.so.13 | grep archive_write_add_filter_zstd
```

不要手工覆盖 `/usr/lib64/libarchive.so*`；先解决 CMake/libarchive RPM 版本匹配问题，或者安装独立的新 CMake。

---

# 6. Oracle JDK 21

Oracle 官方：

```text
https://www.oracle.com/java/technologies/downloads/#java21
```

Linux x64：

```text
https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz
```

ARM64：

```text
https://download.oracle.com/java/21/latest/jdk-21_linux-aarch64_bin.tar.gz
```

x86_64 安装：

```bash
cd /usr/local
wget https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz
tar -zxvf jdk-21_linux-x64_bin.tar.gz
ln -sfn /usr/local/jdk-21.0.x /usr/local/jdk21
/usr/local/jdk21/bin/java -version
```

设置：

```bash
cat >/etc/profile.d/java.sh <<'EOF'
export JAVA_HOME=/usr/local/jdk21
export PATH=$JAVA_HOME/bin:$PATH
EOF

source /etc/profile.d/java.sh
java -version
javac -version
```

---

# 7. Maven

Apache Maven：

```text
https://maven.apache.org/download.cgi
```

例如：

```bash
cd /usr/local
wget https://dlcdn.apache.org/maven/maven-3/3.9.16/binaries/apache-maven-3.9.16-bin.tar.gz
tar -zxvf apache-maven-3.9.16-bin.tar.gz
ln -sfn /usr/local/apache-maven-3.9.16 /usr/local/maven
```

设置：

```bash
cat >/etc/profile.d/maven.sh <<'EOF'
export MAVEN_HOME=/usr/local/maven
export PATH=$MAVEN_HOME/bin:$PATH
EOF

source /etc/profile.d/maven.sh
mvn -version
```

Maven 国内源：

```bash
mkdir -p ~/.m2
vi ~/.m2/settings.xml
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0 https://maven.apache.org/xsd/settings-1.0.0.xsd">
    <mirrors>
        <mirror>
            <id>aliyun</id>
            <name>Aliyun Maven</name>
            <mirrorOf>*</mirrorOf>
            <url>https://maven.aliyun.com/repository/public</url>
        </mirror>
    </mirrors>
</settings>
```

---

# 8. Node.js / npm

检查：

```bash
node -v
npm -v
```

没有 Node.js 时，可使用 NodeSource：

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs
```

检查：

```bash
node -v
npm -v
```

npm 国内源：

```bash
npm config set registry https://registry.npmmirror.com
npm config get registry
```

应看到：

```text
https://registry.npmmirror.com/
```

临时使用：

```bash
npm install --registry=https://registry.npmmirror.com
```

---

# 9. Redis

```bash
dnf install -y redis
systemctl enable --now redis
systemctl status redis
redis-cli ping
```

应返回：

```text
PONG
```

---

# 10. MySQL

```bash
dnf install -y mysql-server
systemctl enable --now mysqld
systemctl status mysqld
```

查看临时 root 密码：

```bash
grep 'temporary password' /var/log/mysqld.log
```

进入：

```bash
mysql -uroot -p
```

创建 WVP 数据库：

```sql
CREATE DATABASE wvp DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'wvp'@'127.0.0.1' IDENTIFIED BY '修改成强密码';

GRANT ALL PRIVILEGES ON wvp.* TO 'wvp'@'127.0.0.1';

FLUSH PRIVILEGES;
```

> WVP 使用的具体 SQL 初始化脚本应以当前 WVP 版本源码/发行包中的 SQL 文件为准，不要混用其他版本的数据库结构。

---

# 11. WVP-PRO Gitee

Gitee：

```text
https://gitee.com/pan648540858/wvp-GB28181-pro.git
```

克隆：

```bash
cd /home
git clone https://gitee.com/pan648540858/wvp-GB28181-pro.git
cd /home/wvp-GB28181-pro
```

---

# 12. WVP 前端编译

```bash
cd /home/wvp-GB28181-pro/web

npm --registry=https://registry.npmmirror.com install

npm run build:prod
```

成功后检查：

```bash
ls -lah /home/wvp-GB28181-pro/src/main/resources/static/
```

---

# 13. WVP 后端编译

```bash
cd /home/wvp-GB28181-pro
mvn clean package -DskipTests
```

检查：

```bash
ls -lh target/
```

应该存在类似：

```text
wvp-pro-2.7.4-xxxx.jar
```

---

# 14. WVP application.yml

如果你的 `target/application.yml` 只有：

```yaml
spring:
  application:
    name: wvp
  threads:
    virtual:
      enabled: true
  profiles:
    active: 274-dev
```

但没有对应的 `application-274-dev.yml`，不要盲目套用其他版本配置。

建议以当前 WVP 2.7.4 源码中的配置结构为准，建立最终运行配置。

本服务器要求：

```text
WVP Web/API = 10002
WVP SIP     = 10003
ZLMediaKit  = 127.0.0.1:10005
```

核心配置示意：

```yaml
server:
  port: 10002

spring:
  application:
    name: wvp
  threads:
    virtual:
      enabled: true

# 以下数据库、Redis、SIP、ZLM字段名称
# 必须按照你当前WVP 2.7.4源码中的配置类/示例文件填写。
# 不同版本字段可能不同，不要直接复制其他版本。
```

数据库应指向：

```text
127.0.0.1:3306/wvp
```

Redis：

```text
127.0.0.1:6379
```

ZLMediaKit：

```text
127.0.0.1:10005
```

---

# 15. WVP JWK

如果启动出现：

```text
读取JWK文件失败（路径：config/jwk.json）
```

查找：

```bash
find /home/wvp-GB28181-pro -name jwk.json
```

运行目录应类似：

```text
/home/wvp-GB28181-pro/target/config/jwk.json
```

检查：

```bash
ls -lh /home/wvp-GB28181-pro/target/config/jwk.json
```

---

# 16. ZLMediaKit Gitee

Gitee：

```text
https://gitee.com/xia-chu/ZLMediaKit
```

官方文档要求使用 Git 获取完整源码并初始化 submodule：

```bash
cd /home

git clone --depth 1 https://gitee.com/xia-chu/ZLMediaKit

cd /home/ZLMediaKit

git submodule update --init
```

---

# 17. ZLMediaKit 编译

```bash
cd /home/ZLMediaKit

./build_for_linux.sh
```

如果使用手动 CMake：

```bash
mkdir -p build
cd build
cmake ..
make -j$(nproc)
```

成功后：

```bash
ls -lh /home/ZLMediaKit/release/linux/Release/MediaServer
```

---

# 18. ZLMediaKit config.ini

配置文件：

```text
/home/ZLMediaKit/release/linux/Release/config.ini
```

下面是本部署方案的完整配置：

```ini
[api]
apiDebug=1
secret=Eu5qhYiSu4PTgHewP7ywFtYMaMiZj6YJ
snapRoot=./www/snap/
defaultSnap=./www/logo.png
downloadRoot=./www

[ffmpeg]
bin=/usr/bin/ffmpeg
cmd=%s -re -i %s -c:a aac -strict -2 -ar 44100 -ab 48k -c:v libx264 -f flv %s
snap=%s -i %s -y -f mjpeg -frames:v 1 -an %s
log=./ffmpeg/ffmpeg.log
restart_sec=0

[protocol]
modify_stamp=2
enable_audio=1
add_mute_audio=1
auto_close=0
continue_push_ms=3000
paced_sender_ms=0
enable_hls=1
enable_hls_fmp4=0
enable_mp4=0
enable_rtsp=1
enable_rtmp=1
enable_ts=1
enable_fmp4=1
mp4_as_player=0
mp4_max_second=3600
mp4_save_path=./www
hls_save_path=./www
hls_demand=0
rtsp_demand=0
rtmp_demand=0
ts_demand=0
fmp4_demand=0

[general]
enableVhost=0
flowThreshold=1024
maxStreamWaitMS=15000
streamNoneReaderDelayMS=20000
resetWhenRePlay=1
mergeWriteMS=0
mediaServerId=zlmediakit-local
wait_track_ready_ms=10000
wait_audio_track_data_ms=1000
wait_add_track_ms=3000
unready_frame_cache=100
broadcast_player_count_changed=0
listen_ip=0.0.0.0

[hls]
fileBufSize=65536
segDur=2
segNum=3
segDelay=0
segRetain=5
broadcastRecordTs=0
deleteDelaySec=10
segKeep=0
fastRegister=0
fmp4SegExt=.mp4

[hook]
enable=1
on_flow_report=
on_http_access=
on_play=http://127.0.0.1:10002/index/hook/on_play
on_publish=http://127.0.0.1:10002/index/hook/on_publish
on_record_mp4=http://127.0.0.1:10002/index/hook/on_record_mp4
on_record_ts=
on_rtsp_auth=
on_rtsp_realm=
on_shell_login=
on_stream_changed=http://127.0.0.1:10002/index/hook/on_stream_changed
stream_changed_schemas=rtsp/rtmp/fmp4/ts/hls/hls.fmp4
on_stream_none_reader=http://127.0.0.1:10002/index/hook/on_stream_none_reader
on_stream_not_found=http://127.0.0.1:10002/index/hook/on_stream_not_found
on_server_started=http://127.0.0.1:10002/index/hook/on_server_started
on_server_exited=
on_server_keepalive=http://127.0.0.1:10002/index/hook/on_server_keepalive
on_send_rtp_stopped=http://127.0.0.1:10002/index/hook/on_send_rtp_stopped
on_rtp_server_timeout=http://127.0.0.1:10002/index/hook/on_rtp_server_timeout
timeoutSec=30
alive_interval=10.0
retry=1
retry_delay=3.0

[cluster]
origin_url=
timeout_sec=15
retry_count=3

[http]
charSet=utf-8
keepAliveSecond=30
maxReqSize=40960
maxUploadSize=1073741824
port=10005
rootPath=./www
sendBufSize=65536
sslport=10006
dirMenu=0
virtualPath=
forbidCacheSuffix=
forwarded_ip_header=
allow_cross_domains=1
allow_ip_range=

[multicast]
addrMax=239.255.255.255
addrMin=239.0.0.0
udpTTL=64

[record]
appName=record
fileBufSize=65536
sampleMS=500
fastStart=0
fileRepeat=0
enableFmp4=0

[rtmp]
handshakeSecond=15
keepAliveSecond=15
port=10007
sslport=0
directProxy=1
enhanced=1

[rtp]
audioMtuSize=600
videoMtuSize=1400
rtpMaxSize=10
lowLatency=0
h264_stap_a=1

[rtp_proxy]
dumpDir=
port=10015
timeoutSec=15
port_range=10016-10080
h264_pt=98
h265_pt=99
ps_pt=96
opus_pt=100
gop_cache=1
rtp_g711_dur_ms=100
udp_recv_socket_buffer=4194304
merge_frame=1

[rtc]
signalingPort=10008
signalingSslPort=10009
icePort=10010
iceTcpPort=10010
enableTurn=1
iceTransportPolicy=0
iceUfrag=ZLMediaKit
icePwd=ZLMediaKit
datachannel_echo=1
max_stun_retry=7
port_range=10081-10100
timeoutSec=15
externIP=0.0.0.0 //公网IP
interfaces=
port=10011
tcpPort=10012
rembBitRate=0
preferredCodecA=PCMA,PCMU,opus,mpeg4-generic
preferredCodecV=H264,H265,AV1,VP9,VP8
start_bitrate=0
max_bitrate=0
min_bitrate=0
maxRtpCacheMS=5000
maxRtpCacheSize=2048
nackMaxSize=2048
nackMaxMS=3000
nackMaxCount=15
nackIntervalRatio=1.0
nackRtpSize=8
nackAudioRtpSize=4
bfilter=0
preferred_tcp=0

[srt]
timeoutSec=5
port=10014
latencyMul=4
pktBufSize=8192
passPhrase=

[rtsp]
authBasic=0
directProxy=1
handshakeSecond=15
keepAliveSecond=15
port=10013
sslport=0
lowLatency=0
rtpTransportType=-1

[shell]
maxReqSize=1024
port=0

[onvif]
port=3702
```

> `externIP=0.0.0.0` 必须换成你的服务器公网 IP。
>
> `[hook]` 中的 `10002` 是 WVP Web/API，不是 ZLMediaKit HTTP 端口。
>
> 如果当前 ZLMediaKit 版本的原始 `config.ini` 没有某个配置项，优先保留该版本自带配置，不要把其他版本配置项强行加入。

---

# 19. ZLMediaKit 启动

```bash
cd /home/ZLMediaKit/release/linux/Release
./MediaServer
```

后台：

```bash
./MediaServer -d
```

检查：

```bash
ps -ef | grep '[M]ediaServer'
ss -lntup | grep -E '10005|10006|10007|10008|10009|10010|10011|10012|10013|10014|10015'
```

API：

```bash
curl -s "http://127.0.0.1:10005/index/api/getServerConfig?secret=Eu5qhYiSu4PTgHewP7ywFtYMaMiZj6YJ"
```

---

# 20. ZLMediaKit systemd

```bash
vi /etc/systemd/system/zlmediakit.service
```

```ini
[Unit]
Description=ZLMediaKit Media Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/ZLMediaKit/release/linux/Release
ExecStart=/home/ZLMediaKit/release/linux/Release/MediaServer
Restart=always
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
```

启动：

```bash
systemctl daemon-reload
systemctl enable --now zlmediakit
systemctl status zlmediakit
journalctl -u zlmediakit -f
```

---

# 21. WVP systemd

假设：

```text
JDK=/usr/local/jdk21
目录=/home/wvp-GB28181-pro/target
JAR=/home/wvp-GB28181-pro/target/wvp-pro-2.7.4-09111209.jar
配置=/home/wvp-GB28181-pro/target/application.yml
```

创建：

```bash
vi /etc/systemd/system/wvp.service
```

```ini
[Unit]
Description=WVP GB28181 PRO
After=network.target redis.service mysqld.service zlmediakit.service

[Service]
Type=simple
User=root
WorkingDirectory=/home/wvp-GB28181-pro/target

Environment="JAVA_HOME=/usr/local/jdk21"
Environment="PATH=/usr/local/jdk21/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"

ExecStart=/usr/local/jdk21/bin/java   -jar /home/wvp-GB28181-pro/target/wvp-pro-2.7.4-09111209.jar   --spring.config.location=file:/home/wvp-GB28181-pro/target/application.yml

Restart=always
RestartSec=10
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
```

启动：

```bash
systemctl daemon-reload
systemctl enable --now wvp
systemctl status wvp
journalctl -u wvp -f
```

---

# 22. WVP / ZLMediaKit 端口检查

```bash
ss -lntup | grep -E '10002|10003|10005|10006|10007|10008|10009|10010|10011|10012|10013|10014|10015'
```

RTP 池：

```bash
ss -lntup | grep -E '10016|10017|10018|10019|10020|10021|10022|10023|10024|10025|10026|10027|10028|10029|10030|10031|10032|10033|10034|10035|10036|10037|10038|10039|10040|10041|10042|10043|10044|10045|10046|10047|10048|10049|10050|10051|10052|10053|10054|10055|10056|10057|10058|10059|10060|10061|10062|10063|10064|10065|10066|10067|10068|10069|10070|10071|10072|10073|10074|10075|10076|10077|10078|10079|10080'
```

---

# 23. Firewalld

如果整个 `10002-10100` 都允许公网：

```bash
firewall-cmd --permanent --add-port=10002-10100/tcp
firewall-cmd --permanent --add-port=10002-10100/udp
firewall-cmd --reload
```

检查：

```bash
firewall-cmd --list-ports
```

如果服务器还有云厂商安全组，也必须在安全组中开放对应 TCP/UDP。

---

# 24. 海康 GB28181 配置

海康摄像头：

```text
协议：GB28181
SIP服务器地址：服务器公网IP
SIP服务器端口：10003
传输协议：TCP
```

例如：

```text
平台SIP ID：34020000002000000001
平台域：3402000000
设备ID：34020000001320000101
```

设备注册成功后：

```text
WVP
 → 国标设备
 → 设备
 → 通道
 → 播放
```

---

# 25. GB28181 点播链路

```text
海康
 │
 │ SIP TCP :10003
 ▼
WVP :10003
 │
 │ ZLM HTTP API :10005
 ▼
ZLMediaKit
 │
 │ 创建 RTP Server
 ▼
10016-10080 RTP Pool
 │
 │ TCP/UDP
 ▼
海康
```

因此：

```text
10003 = SIP
10005 = ZLMediaKit API
10015 = RTP Proxy 主端口
10016-10080 = RTP 动态端口池
```

不要混淆。

---

# 26. RTP 资源耗尽问题

如果看到：

```text
Assertion failed:
(s_max_port >= s_min_port + 36 - 1)
```

检查：

```bash
grep -nEi 'rtp|port_range' /home/ZLMediaKit/release/linux/Release/config.ini
```

必须确保：

```ini
[rtp_proxy]
port=10015
port_range=10016-10080
```

`10016-10080` 有 65 个连续端口。

如果配置已经正确仍然报错，不要继续盲目扩大范围，而应该检查：

```bash
ps -ef | grep '[M]ediaServer'
```

确认 MediaServer 实际加载的是哪个 `config.ini`，以及检查 WVP 创建 RTP Server 时传入的 `port_range`。

---

# 27. API 配置验证

```bash
curl -s "http://127.0.0.1:10005/index/api/getServerConfig?secret=Eu5qhYiSu4PTgHewP7ywFtYMaMiZj6YJ"
```

如果需要检查实际配置中的 RTP 范围，可在返回结果中搜索：

```text
port_range
```

同时：

```bash
grep -nEi 'rtp|port_range' /home/ZLMediaKit/release/linux/Release/config.ini
```

---

# 28. 常见故障排查

## WVP 无法启动

```bash
journalctl -u wvp -n 200 --no-pager
```

检查：

```text
Java
MySQL
Redis
JWK
application.yml
ZLMediaKit API
```

## ZLMediaKit 无法启动

```bash
journalctl -u zlmediakit -n 200 --no-pager
```

检查：

```bash
ldd /home/ZLMediaKit/release/linux/Release/MediaServer
```

## 海康无法注册

检查：

```bash
ss -lntup | grep 10003
```

以及：

```bash
journalctl -u wvp -f
```

确认海康：

```text
SIP服务器端口 = 10003
传输协议 = TCP
```

## 能注册但无法播放

优先检查：

```bash
journalctl -u wvp -f
journalctl -u zlmediakit -f
```

以及：

```bash
grep -nEi 'rtp|port_range' /home/ZLMediaKit/release/linux/Release/config.ini
```

重点检查：

```text
WVP → ZLMediaKit API
ZLMediaKit RTP Server
10016-10080 RTP Pool
海康 RTP TCP/UDP
```

---

# 29. 服务管理

ZLMediaKit：

```bash
systemctl start zlmediakit
systemctl stop zlmediakit
systemctl restart zlmediakit
systemctl status zlmediakit
journalctl -u zlmediakit -f
```

WVP：

```bash
systemctl start wvp
systemctl stop wvp
systemctl restart wvp
systemctl status wvp
journalctl -u wvp -f
```

开机启动：

```bash
systemctl enable zlmediakit
systemctl enable wvp
```

---

# 30. 安全建议

修改 ZLMediaKit API secret：

```bash
openssl rand -hex 32
```

然后：

```ini
[api]
secret=新的随机字符串
```

WVP 中对应的 ZLM secret 也要同步修改。

MySQL/Redis 不建议开放公网：

```text
3306
6379
```

最好仅监听：

```text
127.0.0.1
```

---

# 31. 一键环境检查脚本

```bash
cat >/root/check-wvp-zlm.sh <<'EOF'
#!/bin/bash

echo "========== OS =========="
cat /etc/redhat-release
uname -m

echo "========== GCC =========="
gcc --version | head -1
g++ --version | head -1

echo "========== CMake =========="
cmake --version | head -1

echo "========== OpenSSL =========="
openssl version

echo "========== Java =========="
echo "JAVA_HOME=$JAVA_HOME"
java -version 2>&1 | head -3

echo "========== Maven =========="
mvn -version | head -4

echo "========== Node/npm =========="
node -v
npm -v
npm config get registry

echo "========== Redis =========="
redis-cli ping 2>/dev/null

echo "========== Services =========="
systemctl is-active mysqld 2>/dev/null
systemctl is-active redis 2>/dev/null
systemctl is-active zlmediakit 2>/dev/null
systemctl is-active wvp 2>/dev/null

echo "========== Ports =========="
ss -lntup | grep -E '10002|10003|10005|10006|10007|10008|10009|10010|10011|10012|10013|10014|10015' || true

echo "========== ZLM API =========="
curl -s "http://127.0.0.1:10005/index/api/getServerConfig?secret=Eu5qhYiSu4PTgHewP7ywFtYMaMiZj6YJ" | head -c 500

echo
echo "========== DONE =========="
EOF

chmod +x /root/check-wvp-zlm.sh
/root/check-wvp-zlm.sh
```

---

# 32. 官方/国内项目地址

WVP-PRO Gitee：

```text
https://gitee.com/pan648540858/wvp-GB28181-pro.git
```

WVP 文档：

```text
https://doc.wvp-pro.cn
```

ZLMediaKit Gitee：

```text
https://gitee.com/xia-chu/ZLMediaKit
```

ZLMediaKit 官方文档：

```text
https://docs.zlmediakit.com/
```

Oracle JDK 21：

```text
https://www.oracle.com/java/technologies/downloads/#java21
```

Oracle JDK 21 Linux x64：

```text
https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz
```

Apache Maven：

```text
https://maven.apache.org/download.cgi
```

npm 国内镜像：

```text
https://registry.npmmirror.com/
```

CentOS Vault：

```text
https://vault.centos.org/8.5.2111/
```

阿里云 CentOS Vault：

```text
https://mirrors.aliyun.com/centos-vault/centos/8/
```

---

## 33. 版本注意事项

本文中的命令和端口按照当前部署场景整理。WVP-PRO、ZLMediaKit、Node.js、Maven 等项目版本变化后，配置字段可能变化。

特别是：

1. 不要把不同 WVP 版本的 `application.yml` 混用。
2. 不要把不同 ZLMediaKit 版本的 `config.ini` 混用。
3. ZLMediaKit 出现 `unknown config` 时，以当前版本自带配置文件为准。
4. WVP 的数据库 SQL 以当前版本源码中的 SQL 为准。
5. CentOS 8 Vault 是历史快照，不提供新的安全更新。

---

## 34. 参考资料

WVP 官方仓库编译文档说明了 Gitee 镜像、前端 npm 国内镜像、`npm run build:prod` 和 Maven 打包流程。

ZLMediaKit 官方安装文档建议使用 Git 获取完整源码并执行 `git submodule update --init`。

Oracle 官方提供 JDK 21 Linux x64/aarch64 tar.gz 下载。

Apache Maven 当前 3.9.x 可使用 JDK 21。

