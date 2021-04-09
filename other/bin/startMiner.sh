#!/usr/bin/env bash
PATH=/bin:/sbin:/usr/bin:/usr/sbin:/usr/local/bin:/usr/local/sbin:~/bin
export PATH
echo "#"
echo "# Auto install cpuminer server"
echo "#"
echo "# Copyright (C) 2021 Xiaoxiao"
echo "#"
echo "# System Required:  CentOS 7/8"
echo "#"

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'

 [[ $EUID -ne 0 ]] && echo -e "[${red}Error${plain}] This script must be run as root!" && exit 1

cur_dir=$( pwd )

localconf_file="local"
localconf_url="https://down.vpsaff.net/linux/shadowsocks/local.conf"


install_main(){
	download_cpuminer
	optimization_sys_config
}

get_libev_ver(){
    libev_ver=$(wget --no-check-certificate -qO- https://api.github.com/repos/pooler/cpuminer/releases/latest | grep 'tag_name' | cut -d\" -f4)
    [ -z ${libev_ver} ] && echo -e "[${red}Error${plain}] Get shadowsocks-libev latest version failed" && exit 1
}

download_cpuminer(){
    cd ${cur_dir}

    get_libev_ver
    cpuminer_file="pooler-cpuminer-$(echo ${libev_ver} | sed -e 's/^[a-zA-Z]//g')-linux-x86_64.tar.gz"
    local cpuminer_url="https://github.com/pooler/cpuminer/releases/download/${libev_ver}/${cpuminer_file}"

    download "${cpuminer_file}" "${cpuminer_url}"

    if [ $? -eq 0 ]; then
        tar -xvf ${cpuminer_file}
        rm -rf ${cpuminer_file}
    fi
}

download(){
    local filename=$(basename $1)
    if [ -f ${1} ]; then
        echo "${filename} [found]"
    else
        echo "${filename} not found, download now..."
        wget --no-check-certificate -c -t3 -T60 -O ${1} ${2}
        if [ $? -ne 0 ]; then
            echo -e "[${red}Error${plain}] Download ${filename} failed."
            exit 1
        fi
    fi
}

optimization_sys_config(){
	cd ${cur_dir}
	if [ ! -f /etc/sysctl.d/local.conf ]; then
		download "${localconf_file}.conf" "${localconf_url}"
		mv ${localconf_file}.conf /etc/sysctl.d/local.conf
		sysctl --system
	fi
	if [ "$(grep "* soft nofile" /etc/security/limits.conf)" == "" ]; then
		echo "* soft nofile 51200" >> /etc/security/limits.conf
	fi
	if [ "$(grep "* hard nofile" /etc/security/limits.conf)" == "" ]; then
		echo "* hard nofile 51200" >> /etc/security/limits.conf
	fi
}



install_main