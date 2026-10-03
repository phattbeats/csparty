#!/bin/bash
# compile ISSUE/fix/cs_party.sma -> ISSUE/fix/cs_party.amxx (does not touch the shared harness plugins dir)
set -e
W=/paperclip/workspace/vision-quest/ISSUE; S=$W/amxx/addons/amxmodx/scripting
cp /paperclip/workspace/vision-quest/ISSUE/fix/cs_party.sma $S/cs_party_3897.sma
cd $S
L=$W/i386/usr/lib/i386-linux-gnu:$W/i386/lib/i386-linux-gnu
$W/i386/usr/lib/i386-linux-gnu/ld-linux.so.2 --library-path $L:. --preload $W/shim/stat32.so ./amxxpc cs_party_3897.sma -o/paperclip/workspace/vision-quest/ISSUE/fix/cs_party.amxx 2>&1 | tail -6
