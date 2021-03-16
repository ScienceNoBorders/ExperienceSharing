#!/bin/bash

yum -y groupinstall development

yum install -y zlib-devel bzip2-devel openssl-devel ncurses-devel sqlite-devel readline-devel tk-devel

yum install -y git

mkdir python
cd python

wget https://www.python.org/ftp/python/3.6.4/Python-3.6.4.tgz

tar -xvf Python-3.6.4.tgz

cd Python-3.6.4

./configure --prefix=/usr/local/python3

make && make install

export PATH=$PATH:/usr/local/python3/bin/

curl "https://bootstrap.pypa.io/get-pip.py" -o "get-pip.py"

python3 get-pip.py

pip install git+https://github.com/shadowsocks/shadowsocks.git@master

cd ~/
mkdir libsodium
cd libsodium

wget https://download.libsodium.org/libsodium/releases/LATEST.tar.gz

tar -xzvf LATEST.tar.gz

cd libsodium*

./configure --prefix=/usr/local/libsodium

make -j8 && make install

echo "/lib
/usr/lib64
/usr/local/lib
/usr/local/libsodium/lib" >> /etc/ld.so.conf

ldconfig

cd ~/
mkdir shadowsocks
