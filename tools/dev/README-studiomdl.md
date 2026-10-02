# Building Valve's studiomdl on Linux

Source: `utils/studiomdl` + `utils/common` from github.com/ValveSoftware/halflife.

1. Copy `utils/studiomdl` and `utils/common` side by side. In `studiomdl/*.c,h`: point the
   `studio.h` include at a local copy of `engine/studio.h`, copy `dlls/activity*.h` into
   `studiomdl/dlls/`, and rename the global `gamma` to `smd_gamma` (clashes with libm).
2. Put `windows.h` from this folder (BMP structs, stricmp & friends) on the include path,
   plus one-line `STDIO.H`, `STDLIB.H`, `STRING.H`, `MATH.H`, `direct.h`, `io.h`, `conio.h` shims.
3. Build 32-bit:

       gcc -m32 -w -fcommon -include windows.h -I<compat> -I. -I../common \
         -I<hlsdk>/common -I<hlsdk>/public -o studiomdl \
         studiomdl.c write.c tristrip.c bmpread.c ../common/cmdlib.c ../common/scriplib.c \
         ../common/mathlib.c ../common/trilib.c ../common/lbmlib.c -lm

# Headless test harness

- `srv.sh`: HLDS in tmux. `start [map]`, `stop`, `cmd "<console>"`, `log [N]`.
- `nov6.c`: LD_PRELOAD shim for sandboxes without IPv6 (steamclient wants an AF_INET6 socket).
  `gcc -m32 -shared -fPIC -o nov6.so nov6.c -ldl`. ReHLDS also needs its bundled
  `libsteam_api.so`; the one from current SteamCMD HLDS lacks `SteamGameServer_Init`.
- `cam.sh`: Xash3D FWGS + cs16-client on Xvfb, joins with `connect 127.0.0.1:27015 gs`.
  `shot <png>` grabs the screen; drive menus and jumps with `xdotool key <n>` / `keydown space`.
