#!/bin/bash

file_name="config.json"

cd ~/shadowsocks

read -p "Please Enter Shadowsocks port: " port

rm -rf $file_name

echo "
{
	\"server\": \"0.0.0.0\",
	\"server_port\": ${port},
	\"local_address\": \"127.0.0.1\",
	\"local_port\": 1080,
	\"password\": \"xiaotijun1997.\",
	\"timeout\": 500,
	\"method\": \"aes-256-cfb\",
	\"fast_open\": false,
	\"workers\": 1
}
" > $file_name

ssserver -c ./config.json -d stop
ssserver -c ./config.json -d start

firewall-cmd --add-port=$port/tcp --permanent
firewall-cmd --reload

netstat -tunlp | grep $port
