#!/bin/bash
# run.sh [name]: GPU browser player on the ISSUE test stack (relay :8184, server :27084); work dir test4084/work[-name]
D=/srv/cs-party/test4084; N=${1:-}; W=$D/work${N:+-$N}
mkdir -p $W; cp $D/rig/shoot.js $D/rig/inner.sh $W/; [ -d $W/node_modules ] || cp -r /srv/cs-party/test4037/work/node_modules $W/
: > $W/cmd.txt; : > $W/log.txt
docker rm -f csp4084-pw${N:+-$N} >/dev/null 2>&1
docker run -d --name csp4084-pw${N:+-$N} --network host --shm-size 1g --runtime nvidia -e NVIDIA_VISIBLE_DEVICES=GPU-dfbbb30f-7843-c385-e247-f4284c43df64 -e NVIDIA_DRIVER_CAPABILITIES=all \
  -v $W:/work -e KEY=ISSUEKEY -e RPW=csp4084 -e RPORT=27084 -e RELAY=http://127.0.0.1:8184 -e PHONE="$PHONE" -e VW="$VW" -e VH="$VH" -e EXTRA="$EXTRA" -e PAD="$PAD" \
  mcr.microsoft.com/playwright:v1.55.0-noble bash /work/inner.sh
