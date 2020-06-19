#!/bin/sh
# export PATH=/home/netsense/tools/jre1.8.0_171/bin:$PATH
#java -Xms128m -Xmx512m -XX:OnOutOfMemoryError="kill -9 %p" -jar ../lib/ns-workzone.jar

# 项目名称
APPLICATION="daily-system"

# 项目启动jar包名称
APPLICATION_JAR="${APPLICATION}.jar"

# 项目启动环境 test: 测试 pro:生产
ACTIVE="dev"

nohup java -Xms128m -Xmx512m -XX:OnOutOfMemoryError="kill -9 %p" -jar ../package/${APPLICATION_JAR} --spring.profiles.active=${ACTIVE} >/dev/null 2>&1 &

# 进程ID,延迟三秒输出
sleep 3
PID=$(ps -ef | grep ${APPLICATION_JAR} | grep -v grep | awk '{ print $2 }')
STARTUP_LOG="The nohup statement executed successfully pid: ${PID}"
echo ${STARTUP_LOG}

