"""BSP and WAD helpers shared by web/pack_gamedata.py and tools/race_map.py."""
import re, struct, os

def wad_read(path):
    d = open(path, "rb").read()
    magic, n, ofs = struct.unpack_from("<4sii", d, 0)
    lumps = {}
    for i in range(n):
        filepos, disksize, size, typ, comp, _p1, _p2 = struct.unpack_from("<iiibbbb", d, ofs + 32 * i)
        name = d[ofs + 32 * i + 16: ofs + 32 * i + 32].split(b"\0")[0]
        lumps[name.decode("latin1").lower()] = (name, typ, comp, size, d[filepos: filepos + disksize])
    return magic, lumps

def wad_write(magic, lumps, names):
    body = bytearray(b"\0" * 12); entries = []
    for nm in sorted(names):
        raw, typ, comp, size, data = lumps[nm]
        entries.append((len(body), len(data), size, typ, comp, raw)); body += data
        while len(body) % 4: body += b"\0"
    ofs = len(body)
    for filepos, disksize, size, typ, comp, raw in entries:
        body += struct.pack("<iiibbbb", filepos, disksize, size, typ, comp, 0, 0) + raw[:16].ljust(16, b"\0")
    struct.pack_into("<4sii", body, 0, magic, len(entries), ofs)
    return bytes(body)

def bsp_info(path):
    d = open(path, "rb").read()
    lumps = [struct.unpack_from("<ii", d, 4 + 8 * i) for i in range(15)]
    ofs, _ = lumps[2]
    n, = struct.unpack_from("<i", d, ofs)
    external = set()
    for i in range(n):
        o, = struct.unpack_from("<i", d, ofs + 4 + 4 * i)
        if o < 0: continue
        name = d[ofs + o: ofs + o + 16].split(b"\0")[0].decode("latin1").lower()
        mip, = struct.unpack_from("<I", d, ofs + o + 24)
        if mip == 0: external.add(name)
    ents = d[lumps[0][0]: lumps[0][0] + lumps[0][1]].decode("latin1", "replace")
    m = re.search(r'"wad"\s+"([^"]*)"', ents)
    keys = [os.path.basename(w.replace("\\", "/")).lower() for w in (m.group(1) if m else "").split(";") if w.strip()]
    sky = re.search(r'"skyname"\s+"([^"]*)"', ents)
    return external, keys, (sky.group(1) if sky else "desert")

