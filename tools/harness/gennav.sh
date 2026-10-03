#!/bin/bash
W=/paperclip/workspace/vision-quest/ISSUE
for m in "$@"; do
  N=$W/hlds/cstrike/maps/$m.nav; [ -s $N ] && continue
  $W/srv.sh start $m
  last=-1; stable=0
  for i in $(seq 1 120); do sleep 10; s=$(stat -c %s $N 2>/dev/null || echo 0)
    if [ "$s" -gt 0 ] && [ "$s" = "$last" ]; then stable=$((stable+1)); else stable=0; fi; last=$s
    [ $stable -ge 6 ] && break; done
  echo "$m nav $(stat -c %s $N 2>/dev/null)"
done
$W/srv.sh stop
