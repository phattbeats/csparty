#!/bin/bash
# Native Xash client under strace: records every file it opens while visiting the CS Party maps.
X=/opt/xash; D=:99
pkill -f "Xvfb $D" 2>/dev/null; pkill -x xash3d 2>/dev/null; sleep 0.5
Xvfb $D -screen 0 1280x720x24 >/dev/null 2>&1 &
sleep 1
tmux kill-session -t xash 2>/dev/null
tmux new-session -d -s xash "cd $X && DISPLAY=$D LIBGL_ALWAYS_SOFTWARE=1 SDL_AUDIODRIVER=dummy strace -f -qq -e trace=openat,open -e status=successful -o /tmp/csparty/xash_open.trace ./xash3d -game cstrike -windowed -width 640 -height 360 +name Tracer +connect 127.0.0.1:27015 gs 2>&1 | tee $X/client.log"
