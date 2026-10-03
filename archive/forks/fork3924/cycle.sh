#!/bin/bash
# restart the harness server on $1 (default de_dust2) with the installed plugin, rejoin the headless client, start a match
W=/paperclip/workspace/vision-quest; cd $W/ISSUE
R="python3 $W/ISSUE/src/tools/rcon.py --host 127.0.0.1 --port 27345 --password csp"
touch ctl/quit; sleep 3
(cd $W/ISSUE && ./srv.sh stop; sleep 1; setsid ./srv.sh start ${1:-de_dust2} >/dev/null 2>&1 </dev/null &)
for i in $(seq 1 40); do $R csp_stop >/dev/null 2>&1 && break; sleep 4; done
setsid python3 drive.py ${W2:-960} ${H2:-540} > drive.log 2>&1 < /dev/null &
n0=$(grep -c "VQTest.*entered the game" $W/ISSUE/console.log)
for i in $(seq 1 60); do sleep 5; n=$(grep -c "VQTest.*entered the game" $W/ISSUE/console.log); [ $n -gt $n0 ] && break; done
sleep 15; $R csp_start >/dev/null; sleep 6; $R csp_state | head -2
