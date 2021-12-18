#!/usr/bin/env bash
PATH=/bin:/sbin:/usr/bin:/usr/sbin:/usr/local/bin:/usr/local/sbin:~/bin
export PATH
echo "#"
echo "# Auto install shadowsocks-libev server"
echo "#"
echo "# Copyright (C) 2019"
echo "#"
echo "# System Required:  CentOS 7/8"
echo "#"

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'

[[ $EUID -ne 0 ]] && echo -e "[${red}Error${plain}] This script must be run as root!" && exit 1

cur_dir=$( pwd )

libtool_file="libtool-2.4.6"
libtool_url="https://down.vpsaff.net/linux/libtool-2.4.6.tar.gz"

shadowsocks_libev_config="/etc/shadowsocks-libev/config.json"
shadowsocks_libev_service="/etc/systemd/system/shadowsocks-libev.service"

libsodium_file="libsodium-1.0.18-stable"
libsodium_url="https://down.vpsaff.net/linux/libsodium-1.0.18-stable.tar.gz"

mbedtls_file="mbedtls-2.16.6"
mbedtls_url="https://down.vpsaff.net/linux/mbedtls/mbedtls-2.16.6-gpl.tgz"

localconf_file="local"
localconf_url="https://down.vpsaff.net/linux/shadowsocks/local.conf"

common_ciphers=(
chacha20-ietf-poly1305
xchacha20-ietf-poly1305
aes-256-gcm
aes-192-gcm
aes-128-gcm
)

install_main(){
	check_sys
    install_prepare
    install_dependencies
	install_libtool
	install_mbedtls
	install_libsodium
	check_bbr_status
	if [ $? -eq 0 ]; then
		check_kernel_version
		if [ $? -eq 1 ]; then
			enable_bbr
		fi
	fi
	optimization_sys_config
    install_shadowsocks_libev
	install_completed_libev
    config_firewall
    install_cleanup
}

getversion(){
	grep -oE "[0-9.]+" /etc/redhat-release
}

check_sys(){
	if [ -f /etc/redhat-release ]; then
		echo ""
	else 
		echo "Only supported CentOS 7/8."
		exit 1
	fi
	local version="$(getversion)"
    sys_main_ver=${version%%.*}
	if [ "$sys_main_ver" != '7' ] && [ "$sys_main_ver" != '8' ]; then
		echo "Only supports CentOS 7/8."
		exit 1
	fi
}

check_kernel_version(){
	kernel_version=$(uname -r | awk -F'.' '{print $1}')
	kernel_main_version=$(uname -r | awk -F'.' '{print $2}')
	if [ $kernel_version -eq 4 ] && [ $kernel_main_version -lt 9 ]; then
		echo "Google BBR only supports kernel version 4.9 or higher"
		return 0
	elif [ $kernel_version -lt 4 ]; then
		echo "Google BBR only supports kernel version 4.9 or higher"
		return 0
	fi
	return 1
}

get_libev_ver(){
    libev_ver=$(wget --no-check-certificate -qO- https://api.github.com/repos/shadowsocks/shadowsocks-libev/releases/latest | grep 'tag_name' | cut -d\" -f4)
    [ -z ${libev_ver} ] && echo -e "[${red}Error${plain}] Get shadowsocks-libev latest version failed" && exit 1
}

download_shadowsocks_libev(){
    cd ${cur_dir}

    get_libev_ver
    shadowsocks_libev_file="shadowsocks-libev-$(echo ${libev_ver} | sed -e 's/^[a-zA-Z]//g')"
    local shadowsocks_libev_url="https://github.com/shadowsocks/shadowsocks-libev/releases/download/${libev_ver}/${shadowsocks_libev_file}.tar.gz"

    download "${shadowsocks_libev_file}.tar.gz" "${shadowsocks_libev_url}"
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
install_libtool(){
    if [ ! -f /usr/bin/libtool ] && [ ! -f /usr/local/bin/libtool ]; then
        cd ${cur_dir}
        download "${libtool_file}.tar.gz" "${libtool_url}"
        tar -zxf ${libtool_file}.tar.gz
        cd ${libtool_file}
        ./configure --prefix=/usr && make && make install && ldconfig
        if [ $? -ne 0 ]; then
            echo -e "[${red}Error${plain}] ${libtool_file} install failed."
            install_cleanup
            exit 1
        fi
    else
        echo -e "[${green}Info${plain}] libtool already installed."
    fi
}
install_libsodium(){
    if [ ! -f /usr/lib/libsodium.a ]; then
        cd ${cur_dir}
        download "${libsodium_file}.tar.gz" "${libsodium_url}"
        tar -zxf ${libsodium_file}.tar.gz
        cd libsodium-stable
        ./configure --prefix=/usr && make && make install && ldconfig
        if [ $? -ne 0 ]; then
            echo -e "[${red}Error${plain}] ${libsodium_file} install failed."
            install_cleanup
            exit 1
        fi
    else
        echo -e "[${green}Info${plain}] libsodium already installed."
    fi
}

install_mbedtls(){
    if [ ! -f /usr/lib/libmbedtls.a ] && [ ! -f /usr/bin/mbedtls_hello ] && [ ! -f /usr/local/bin/mbedtls_hello ]; then
        cd ${cur_dir}
        download "${mbedtls_file}-gpl.tgz" "${mbedtls_url}"
        tar -xf ${mbedtls_file}-gpl.tgz
        cd ${mbedtls_file}
        make && make DESTDIR=/usr install && ldconfig
        if [ $? -ne 0 ]; then
            echo -e "[${red}Error${plain}] ${mbedtls_file} install failed."
            install_cleanup
            exit 1
        fi
    else
        echo -e "[${green}Info${plain}] mbedtls already installed."
    fi
}

install_shadowsocks_libev(){
	download_shadowsocks_libev
    cd ${cur_dir}
    tar -zxf ${shadowsocks_libev_file}.tar.gz
    cd ${shadowsocks_libev_file}
    ./configure --disable-documentation && make && make install
    if [ $? -eq 0 ]; then
		config_shadowsocks_libev
        systemctl start shadowsocks-libev
		systemctl enable shadowsocks-libev
    else
        echo
        echo -e "[${red}Error${plain}] shadowsocks-libev install failed."
        install_cleanup
        exit 1
    fi
}

install_completed_libev(){
    clear
    echo
    echo -e "Congratulations, shadowsocks-libev server install completed!"
    echo -e "Your Server IP        : ${red} $(get_ip) ${plain}"
    echo -e "Your Server Port      : ${red} ${shadowsocksport} ${plain}"
    echo -e "Your Password         : ${red} ${shadowsockspwd} ${plain}"
    echo -e "Your Encryption Method: ${red} ${shadowsockscipher} ${plain}"
}

install_cleanup(){
    cd ${cur_dir}
    rm -rf libsodium-stable ${libsodium_file}.tar.gz
    rm -rf ${mbedtls_file} ${mbedtls_file}-gpl.tgz
    rm -rf ${libtool_file} ${libtool_file}.tar.gz
    rm -rf ${shadowsocks_libev_file} ${shadowsocks_libev_file}.tar.gz
}

check_kernel_headers(){
    if rpm -qa | grep -q headers-$(uname -r); then
		return 0
	else
		return 1
	fi
}


config_shadowsocks_libev(){	
	if [ ! -d "$(dirname ${shadowsocks_libev_config})" ]; then
		mkdir -p $(dirname ${shadowsocks_libev_config})
	fi

	cat > ${shadowsocks_libev_config}<<-EOF
	{
		"server":"0.0.0.0",
		"server_port":${shadowsocksport},
		"password":"${shadowsockspwd}",
		"timeout":600,
		"method":"${shadowsockscipher}",
		"fast_open":true,
		"mode":"tcp_only"
	}
	EOF
	
	cat > ${shadowsocks_libev_service}<<-EOF
	[Unit]
	Description=shadowsocks-libev server
	After=network.target

	[Service]
	Type=simple
	ExecStartPre=/bin/sh -c 'ulimit -n 51200'
	ExecStart=/usr/local/bin/ss-server -c /etc/shadowsocks-libev/config.json
	Restart=on-abort

	[Install]
	WantedBy=multi-user.target
	EOF
}


error_detect_depends(){
    local command=$1
    local depend=`echo "${command}" | awk '{print $4}'`
    echo -e "[${green}Info${plain}] Starting to install package ${depend}"
    ${command} > /dev/null 2>&1
    if [ $? -ne 0 ]; then
        echo -e "[${red}Error${plain}] Failed to install ${red}${depend}${plain}"
        exit 1
    fi
}

install_dependencies(){
	local gcc_path=$(command -v gcc)
    if [ "${gcc_path}" == "" ]; then
		error_detect_depends "yum -y install gcc"
	fi
    yum_depends=(
		gettext autoconf automake make pcre-devel asciidoc xmlto c-ares-devel libev-devel wget tar m4 perl
	)
	for depend in ${yum_depends[@]}; do
		error_detect_depends "yum -y install ${depend}"
	done
	
	if [ "$sys_main_ver" == '8' ]; then
		install_python2
	fi
}

install_python2(){
	if [ ! -f /usr/lib64/libpython2.7.so.1.0 ]; then
		error_detect_depends "yum -y install python2"
	fi
}

config_firewall(){
    systemctl status firewalld > /dev/null 2>&1
	if [ $? -eq 0 ]; then
		default_zone=$(firewall-cmd --get-default-zone)
		firewall-cmd --permanent --zone=${default_zone} --add-port=${shadowsocksport}/tcp
		firewall-cmd --permanent --zone=${default_zone} --add-port=${shadowsocksport}/udp
		firewall-cmd --reload
	else
		echo -e "[${yellow}Warning${plain}] firewalld looks like not running or not installed, please enable port ${shadowsocksport} manually if necessary."
	fi
}

install_prepare_port() {
    while true
    do
    dport=$(shuf -i 9000-19999 -n 1)
    echo -e "Please enter a port for shadowsocks-libev [1-65535]"
    read -p "(Default port: ${dport}):" shadowsocksport
    [ -z "${shadowsocksport}" ] && shadowsocksport=${dport}
    expr ${shadowsocksport} + 1 &>/dev/null
    if [ $? -eq 0 ]; then
        if [ ${shadowsocksport} -ge 1 ] && [ ${shadowsocksport} -le 65535 ] && [ ${shadowsocksport:0:1} != 0 ]; then
            echo
            echo "port = ${shadowsocksport}"
            echo
            break
        fi
    fi
    echo -e "[${red}Error${plain}] Please enter a correct number [1-65535]"
    done
}

install_prepare_password(){
	local mkpasswd_path=$(command -v mkpasswd)
    if [ "${mkpasswd_path}" == "" ]; then
		error_detect_depends "yum -y install expect"
	fi
	radompassword=$(mkpasswd -l 18 -d 2 -s 0)

    echo "Please enter password for shadowsocks-libev"
    read -p "(Default password: ${radompassword}):" shadowsockspwd
    [ -z "${shadowsockspwd}" ] && shadowsockspwd=${radompassword}
    echo
    echo "password = ${shadowsockspwd}"
    echo
}

install_prepare_cipher(){
    while true
    do
    echo -e "Please select stream cipher for shadowsocks-libev:"

	for ((i=1;i<=${#common_ciphers[@]};i++ )); do
		hint="${common_ciphers[$i-1]}"
		echo -e "${green}${i}${plain}) ${hint}"
	done
	read -p "Which cipher you'd select(Default: ${common_ciphers[0]}):" pick
	[ -z "$pick" ] && pick=1
	expr ${pick} + 1 &>/dev/null
	if [ $? -ne 0 ]; then
		echo -e "[${red}Error${plain}] Please enter a number"
		continue
	fi
	if [[ "$pick" -lt 1 || "$pick" -gt ${#common_ciphers[@]} ]]; then
		echo -e "[${red}Error${plain}] Please enter a number between 1 and ${#common_ciphers[@]}"
		continue
	fi
	shadowsockscipher=${common_ciphers[$pick-1]}
    
   

    echo
    echo "cipher = ${shadowsockscipher}"
    echo
    break
    done
}

check_bbr_status() {
    local param=$(lsmod | grep bbr | awk '{print $1}')
    if [[ "${param}" == "tcp_bbr" ]]; then
		echo "[${green}Info${plain}] Your Google BBR enabled"
        return 1
    else
        return 0
    fi
}

enable_bbr() {
	modprobe tcp_bbr
    echo "tcp_bbr" >> /etc/modules-load.d/modules.conf
    echo "net.core.default_qdisc = fq" >> /etc/sysctl.conf
    echo "net.ipv4.tcp_congestion_control = bbr" >> /etc/sysctl.conf
    sysctl -p
	echo "[${green}Info${plain}] Google BBR enabled"
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

get_ip(){
    local IP=$( ip addr | egrep -o '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' | egrep -v "^192\.168|^172\.1[6-9]\.|^172\.2[0-9]\.|^172\.3[0-2]\.|^10\.|^127\.|^255\.|^0\." | head -n 1 )
    [ -z ${IP} ] && IP=$( wget -qO- -t1 -T2 api.24kplus.com/myip )
    echo ${IP}
}

get_char(){
    SAVEDSTTY=$(stty -g)
    stty -echo
    stty cbreak
    dd if=/dev/tty bs=1 count=1 2> /dev/null
    stty -raw
    stty echo
    stty $SAVEDSTTY
}

install_prepare(){

    install_prepare_password
    install_prepare_port
    install_prepare_cipher

    echo
    echo "Press any key to start...or Press Ctrl+C to cancel"
    char=`get_char`

}

install_main