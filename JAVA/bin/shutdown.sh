#!/bin/sh
#ps -ef|grep statistical-0.0.1.jar |grep -v grep | awk '{print $2}' | xargs -i kill {} > /dev/null 2>&1
#exit 0

# 项目名称
APPLICATION="daily-system"

# 项目启动jar包名称
APPLICATION_JAR="${APPLICATION}.jar"

PID=$(ps -ef | grep ${APPLICATION_JAR} | grep -v grep | awk '{ print $2 }')
if [ -z "$PID" ]
then
    echo ${APPLICATION} is already stopped
else
    echo kill  ${PID}
    kill -9 ${PID}
    echo ${APPLICATION} stopped successfully
fi
