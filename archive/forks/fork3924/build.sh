#!/bin/bash
# compile ISSUE/cs_party.sma -> ISSUE/cs_party.amxx and install into the harness
set -e
W=/paperclip/workspace/vision-quest/ISSUE; S=$W/amxx/addons/amxmodx/scripting
cp /paperclip/workspace/vision-quest/ISSUE/cs_party.sma $S/cs_party_3924.sma
cd $S
L=$W/i386/usr/lib/i386-linux-gnu:$W/i386/lib/i386-linux-gnu
$W/i386/usr/lib/i386-linux-gnu/ld-linux.so.2 --library-path $L:. --preload $W/shim/stat32.so ./amxxpc cs_party_3924.sma -o/paperclip/workspace/vision-quest/ISSUE/cs_party.amxx 2>&1 | tail -8
cp /paperclip/workspace/vision-quest/ISSUE/cs_party.amxx $W/hlds/cstrike/addons/amxmodx/plugins/cs_party.amxx
