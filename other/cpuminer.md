# 闲置Linux服务器挖矿启动教程
最近币圈火热🔥，本人平时又有几台薅出来的linux服务器，闲来无事寻找挖币机会，今日搭完后赶紧火急火燎的来写入这篇教程，巩固一下知识的同时希望对有这方面需求的小伙伴有所帮助。

## 1、拥有一个币安账户（火币或者F2pool鱼池也可以）
-  [币安注册地址](https://pool.binance.com/)
<p><img src="./image/miner1.png" alt="image completions"></p>
    <center style="font-size:12px;color:#666;text-decoration:underline;margin-bottom:10px">登录后按顺序打开页面</center><br/>

<p><img src="./image/miner2.png" alt="image completions"></p>
    <center style="font-size:12px;color:#666;text-decoration:underline;margin-bottom:10px">找到图中的地址</center>

## 2、登录Linux服务器
<pre>
# 下载脚本
wget https://raw.githubusercontent.com/XiaoTiJun/ExperienceSharing/master/other/bin/startMiner.sh

chmod +x startMiner.sh

./startMiner.sh

# 启动挖矿程序 --url是上图的pool1， --userpass是worker
nohup ./minerd --url=stratum+tcp://sha256.poolbinance.com:443 --userpass=xiaotijun97.001:xiaotijun1997. > miner.log 2>&1 &
</pre>
