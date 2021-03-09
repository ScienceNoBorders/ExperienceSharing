#!/bin/bash

file_name="config.json"

cd ~/shadowsocks

read -p "Please Enter Shadowsocks port: " port
read -p "Please Enter Shadowsocks password: " password

rm -rf $file_name

echo "
{
	\"server\": \"0.0.0.0\",
	\"server_port\": ${port},
	\"local_address\": \"127.0.0.1\",
	\"local_port\": 1080,
	\"password\": ${password},
	\"timeout\": 500,
	\"method\": \"aes-256-cfb\",
	\"fast_open\": false,
	\"workers\": 1,
	\"protocol_param\": "",
}
" > $file_name

ssserver -c ./config.json -d stop
ssserver -c ./config.json -d start

sleep 2

if netstat -tunlp | grep -q $port
then
  echo "firewall open port($port) status: " $(firewall-cmd --add-port=$port/tcp --permanent)
  echo "firewall reload status: " $(firewall-cmd --reload)
  netstat -tunlp | grep $port
else
  echo "shadowsocks open fail, please try again!"
fi





