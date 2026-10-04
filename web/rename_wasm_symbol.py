#!/usr/bin/env python3
"""Rename a symbol in an Emscripten side module's import and export names (same length only).

Side modules share one symbol table. cs16-client's client and menu modules both define `gpGlobals`
(the client's points at its globalvars_t, the menu's at the engine's ui_globalvars_t). Whichever
loads first owns the symbol, so once the client loads it overwrites the menu's pointer, and the
menu reads scrWidth 0. The next screen resize rebuilt every menu font at height 0, and the next
loading screen crashed in UI_DrawString (`h % charH`: "remainder by zero").

usage: rename_wasm_symbol.py module.so old new
"""
import sys


def leb(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1; r |= (x & 0x7F) << s; s += 7
        if x < 0x80:
            return r, i


def name_spans(b):
    """(start, end) of every import module/field name and export name."""
    out, i = [], 8
    while i < len(b):
        sid = b[i]; i += 1
        n, i = leb(b, i); end = i + n
        if sid in (2, 7):
            c, j = leb(b, i)
            for _ in range(c):
                if sid == 2:
                    l, j = leb(b, j); out.append((j, j + l)); j += l   # module ("env", "GOT.mem")
                l, j = leb(b, j); out.append((j, j + l)); j += l
                k = b[j]; j += 1
                if sid == 7 or k in (0, 4):
                    _, j = leb(b, j)
                elif k == 1:                                     # table: reftype, limits
                    j += 1; fl, j = leb(b, j); _, j = leb(b, j)
                    if fl & 1: _, j = leb(b, j)
                elif k == 2:                                     # memory: limits
                    fl, j = leb(b, j); _, j = leb(b, j)
                    if fl & 1: _, j = leb(b, j)
                elif k == 3:                                     # global: valtype, mut
                    j += 2
        i = end
    return out


def main():
    path, old, new = sys.argv[1], sys.argv[2].encode(), sys.argv[3].encode()
    if len(old) != len(new):
        sys.exit("names must be the same length")
    b = bytearray(open(path, "rb").read())
    if b[:4] != b"\0asm":
        sys.exit(f"{path}: not WebAssembly")
    if any(b[s:e] == new for s, e in name_spans(b)):
        sys.exit(f"{path}: {new.decode()} already exists")
    hits = [(s, e) for s, e in name_spans(b) if b[s:e] == old]
    if not hits:
        sys.exit(f"{path}: no {old.decode()} import/export")
    for s, e in hits:
        b[s:e] = new
    open(path, "wb").write(b)
    print(f"{path}: renamed {old.decode()} -> {new.decode()} in {len(hits)} import/export names")


main()
