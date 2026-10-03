#!/bin/bash
# start [map] | cmd "<console cmd>" | stop | log [N]
W=/paperclip/workspace/vision-quest/ISSUE; F=$W/console.fifo
case "$1" in
  start) for p in /proc/[0-9]*; do grep -qa "^./hlds_linux" $p/cmdline 2>/dev/null && kill -9 ${p#/proc/} 2>/dev/null; done; sleep 1; rm -f $F; mkfifo $F; : > $W/console.log
         cd $W/hlds; export LD_LIBRARY_PATH=$W/hlds:$W/i386/usr/lib/i386-linux-gnu:$W/i386/lib/i386-linux-gnu
         ( tail -f /dev/null > $F & ); nohup sh -c "LD_PRELOAD='$W/shim/stat32.so $W/shim/nov6.so' exec ./hlds_linux -game cstrike -bots +ip 127.0.0.1 +port 27345 +maxplayers 10 +sv_lan 1 +rcon_password csp +log on +map ${2:-de_dust2} </dev/null" >> $W/console.log 2>&1 &
         ;;
  cmd)   shift; echo "$*" > $F;;
  stop)  for p in /proc/[0-9]*; do grep -qa "^./hlds_linux" $p/cmdline 2>/dev/null && kill -9 ${p#/proc/} 2>/dev/null; done;;
  log)   grep -v '^\s*$' $W/console.log | tail -n ${2:-30};;
esac
# rcon helper
[ "$1" = rcon ] && { shift; python3 $W/src/tools/rcon.py --host 127.0.0.1 --port 27345 --password csp "$@"; }
