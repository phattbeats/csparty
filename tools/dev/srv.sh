#!/bin/bash
# CS 1.6 test server helper: start [map] | stop | cmd "<console cmd>" | log [N]
H=/opt/hlds; S=cs16
case "$1" in
  start) tmux kill-session -t $S 2>/dev/null; : > $H/console.log
         tmux new-session -d -s $S "cd $H && LD_PRELOAD=$H/shim/nov6.so LD_LIBRARY_PATH=$H:\$LD_LIBRARY_PATH ./hlds_linux -game cstrike -bots +ip 127.0.0.1 +port 27015 +maxplayers 10 +sv_lan 1 +map ${2:-de_dust2} 2>&1 | tee -a $H/console.log";;
  stop)  tmux send-keys -t $S "quit" Enter 2>/dev/null; sleep 1; tmux kill-session -t $S 2>/dev/null;;
  cmd)   shift; tmux send-keys -t $S "$*" Enter;;
  log)   tail -n ${2:-40} $H/console.log;;
esac
