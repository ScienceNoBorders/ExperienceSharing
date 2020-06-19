#!/bin/sh

# 项目名称
APPLICATION="daily-system"

# 项目启动jar包名称
APPLICATION_JAR="${APPLICATION}.jar"

ps -aef|grep ${APPLICATION_JAR}
