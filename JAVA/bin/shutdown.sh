#!/bin/sh
ps -ef|grep statistical-0.0.1.jar |grep -v grep | awk '{print $2}' | xargs -i kill {} > /dev/null 2>&1
exit 0
