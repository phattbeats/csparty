#!/bin/bash
# hns_sweep.sh <map>...  (ARENAS="2 8 9" limits which arenas run; HARNESS picks the harness dir)
# harness sweep (ISSUE): per map, every Hide and Seek arena gets a bot round,
# the csp_hns_corners escape test, and a count of boundary pushes. Needs the ISSUE harness with the plugin and boards installed.
W=${HARNESS:-/paperclip/workspace/vision-quest/ISSUE}; R="$W/srv.sh rcon"
for M in "$@"; do
  (setsid $W/srv.sh start $M >/dev/null 2>&1 </dev/null &)
  for i in $(seq 1 40); do sleep 5; $R csp_hns_probe >/dev/null 2>&1 && break; done
  sleep 3; L0=$(grep -ac "" $W/console.log); $R csp_hns_probe >/dev/null 2>&1; sleep 2   # rcon replies get cut off: read the console
  tail -n +$L0 $W/console.log | grep -a "^\[CSP\] hns arena\|^\[CSP\] HNS arena"
  N=$(tail -n +$L0 $W/console.log | grep -ac "^\[CSP\] hns arena [0-9]")
  for a in ${ARENAS:-$(seq 0 $((N-1)))}; do
    $R csp_stop >/dev/null 2>&1; sleep 3
    L0=$(grep -ac "" $W/console.log)
    $R "csp_force_mg 7" >/dev/null; $R "csp_hns_arena $a" >/dev/null; $R csp_start >/dev/null
    for i in $(seq 1 40); do sleep 3; tail -n +$L0 $W/console.log | grep -aq "Minigame Hide and Seek started" && break; done
    sleep 2; $R csp_hns_corners >/dev/null
    for i in $(seq 1 60); do sleep 2; tail -n +$L0 $W/console.log | grep -aq "corners: done" && break; done
    sleep 25
    echo "== $M arena $a: $(tail -n +$L0 $W/console.log | grep -a '^\[CSP\] Hide and Seek arena' | head -1)"
    tail -n +$L0 $W/console.log | grep -a "^\[CSP\] corner test.*ESCAPED"
    echo "   corners ok: $(tail -n +$L0 $W/console.log | grep -ac '^\[CSP\] corner test.*back inside'), $(tail -n +$L0 $W/console.log | grep -a '^\[CSP\] corners: done')"
    echo "   bot boundary pushes (logged, throttled): $(tail -n +$L0 $W/console.log | grep -ac '^\[CSP\] HNS .*left the arena')"
  done
done
echo SWEEP-DONE
