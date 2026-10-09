#!/bin/bash
# pull.sh [work-dir-suffix]: copy new frames from the rig to ./frames
W=work${1:+-$1}; L=/paperclip/workspace/vision-quest/ISSUE/frames${1:+-$1}; mkdir -p $L
ls $L > /tmp/have4037.txt
ssh raid "cd /srv/cs-party/test4084/$W/out/frames && ls" | grep -vxF -f /tmp/have4037.txt > /tmp/need4037.txt
[ -s /tmp/need4037.txt ] && ssh raid "cd /srv/cs-party/test4084/$W/out/frames && tar cf - -T -" < /tmp/need4037.txt | tar xf - -C $L
ls $L | wc -l
