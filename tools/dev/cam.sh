#!/bin/bash
# Headless CS client for screenshots: start | stop | shot <file.png> | cmd "<console cmd>" | log
X=/opt/xash; D=:99
case "$1" in
  start) pkill -f "Xvfb $D" 2>/dev/null; pkill -x xash3d 2>/dev/null; sleep 0.5
         Xvfb $D -screen 0 1280x720x24 >/dev/null 2>&1 &
         sleep 1
         cd $X && tmux kill-session -t xash 2>/dev/null
         tmux new-session -d -s xash "cd $X && DISPLAY=$D LIBGL_ALWAYS_SOFTWARE=1 ./xash3d -game cstrike -windowed -width 1280 -height 720 -dev 2 -log -nosound +connect 127.0.0.1:27015 gs 2>&1 | tee $X/client.log";;
  stop)  tmux kill-session -t xash 2>/dev/null; pkill -x xash3d; pkill -f "Xvfb $D";;
  shot)  DISPLAY=$D import -window root "${2:-/tmp/claude-0/shot.png}";;
  cmd)   shift; tmux send-keys -t xash "$*" Enter;;
  log)   tail -n ${2:-30} $X/client.log;;
esac
