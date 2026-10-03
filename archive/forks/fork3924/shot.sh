#!/bin/bash
# shot.sh name  -> shots/name.png (waits for it)
cd /paperclip/workspace/vision-quest/ISSUE; rm -f shots/$1.done; touch ctl/shot_$1
for i in $(seq 1 60); do [ -f shots/$1.done ] && exit 0; sleep 1; done; echo "shot $1 timed out"
