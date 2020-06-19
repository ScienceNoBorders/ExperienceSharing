#!/bin/sh
# export PATH=/home/netsense/tools/jre1.8.0_171/bin:$PATH
#java -Xms128m -Xmx512m -XX:OnOutOfMemoryError="kill -9 %p" -jar ../lib/ns-workzone.jar
nohup java -Xms128m -Xmx512m -XX:OnOutOfMemoryError="kill -9 %p" -jar ../package/statistical-0.0.1.jar --spring.profiles.active=pro >/dev/null 2>&1 &
