#!/bin/bash
# q.sh [-w name] line... : append command lines for the browser rig; q.sh -l N : tail log; q.sh -g files : fetch from out/
D=/srv/cs-party/test4084; W=work
if [ "$1" = -w ]; then W=work-$2; shift 2; fi
case "$1" in
  -l) ssh raid "tail -n ${2:-20} $D/$W/log.txt";;
  -g) shift; mkdir -p /paperclip/workspace/vision-quest/ISSUE/shots; for f in "$@"; do scp -q raid:$D/$W/out/$f.png /paperclip/workspace/vision-quest/ISSUE/shots/ ; done;;
  *) printf '%s\n' "$@" | ssh raid "cat >> $D/$W/cmd.txt";;
esac
