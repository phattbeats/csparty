#!/usr/bin/env python3
"""GoldSrc RCON client: run a console command on a CS Party server (csp_start, csp_state, changelevel ...).

usage: tools/rcon.py [--host 127.0.0.1] [--port 27015] [--password PW | env RCON_PASSWORD] <command...>
"""
import argparse, os, socket, sys

ap = argparse.ArgumentParser()
ap.add_argument("--host", default="127.0.0.1")
ap.add_argument("--port", type=int, default=27015)
ap.add_argument("--password", default=os.environ.get("RCON_PASSWORD", ""))
ap.add_argument("command", nargs="+")
a = ap.parse_args()
if not a.password: sys.exit("set --password or RCON_PASSWORD")

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
def ask(payload):
    s.sendto(b"\xff\xff\xff\xff" + payload.encode("latin1") + b"\n", (a.host, a.port))
    return s.recvfrom(65535)[0]

reply = ask("challenge rcon")                       # -> "\xff\xff\xff\xffchallenge rcon 123456\n"
challenge = reply[4:].decode("latin1").replace("\0", " ").split()[-1]   # reply ends in "\n\0"
s.sendto(b"\xff\xff\xff\xff" + f'rcon {challenge} "{a.password}" {" ".join(a.command)}\n'.encode("latin1"), (a.host, a.port))
out = []
try:
    while True:
        data = s.recvfrom(65535)[0]
        out.append(data[5:].decode("latin1") if data[4:5] == b"l" else data[4:].decode("latin1"))
        s.settimeout(0.3)                           # long outputs arrive in several packets
except socket.timeout:
    pass
text = "".join(out)
if "Bad rcon" in text: sys.exit(text.strip())
sys.stdout.write(text)
