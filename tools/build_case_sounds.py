#!/usr/bin/env python3
"""Synthesizes the case-opening sounds into <outdir>/cstrike/sound/csp/ (22.05 kHz mono 16-bit)."""
import os, sys, wave
import numpy as np

SR = 22050
rng = np.random.default_rng(5)
def t(n): return np.arange(int(SR * n)) / SR
def env(x, a, d): return np.minimum(x / max(a, 1e-4), 1) * np.exp(-x / d)
def tone(f, n, a=0.003, d=0.1, harm=(1.0)):
    x = t(n); y = sum(h * np.sin(2 * np.pi * f * (i + 1) * x) for i, h in enumerate(harm)); return y * env(x, a, d)
def noise(n, a=0.003, d=0.1):
    x = t(n); return rng.standard_normal(len(x)) * env(x, a, d)
def lp(y, k):
    return np.convolve(y, np.ones(k) / k, mode="same")
def mix(n, *parts):
    out = np.zeros(int(SR * n))
    for off, y in parts:
        i = int(SR * off); y = y[: len(out) - i]; out[i:i + len(y)] += y
    return out
def save(name, y, peak=0.85):
    y = y / max(1e-9, np.abs(y).max()) * peak
    p = os.path.join(OUT, name); os.makedirs(os.path.dirname(p), exist_ok=True)
    with wave.open(p, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((y * 32767).astype(np.int16).tobytes())

OUT = os.path.join(sys.argv[1], "cstrike", "sound", "csp")
# latch clunk, then a rising shimmer as the reel starts
x = t(0.7)
rise = np.sin(2 * np.pi * np.cumsum(300 + 1400 * (x / 0.7) ** 2) / SR) * (x / 0.7) ** 1.5 * np.exp(-(x / 0.7) ** 6) * 0.5
save("case_open.wav", mix(0.7, (0, tone(90, 0.25, 0.002, 0.06, (1, 0.6)) * 1.2), (0, lp(noise(0.12, 0.001, 0.02), 6)), (0.05, rise)))
# one tick of the reel passing the marker
save("case_tick.wav", mix(0.05, (0, tone(1900, 0.05, 0.0005, 0.008, (1, 0.4))), (0, lp(noise(0.03, 0.0003, 0.005), 3) * 0.6)))
# landing thud for common pulls
save("case_land.wav", mix(0.5, (0, tone(140, 0.3, 0.002, 0.07, (1, 0.5))), (0, lp(noise(0.15, 0.001, 0.03), 8)), (0.04, tone(880, 0.4, 0.002, 0.12, (1, 0.3)) * 0.4)))
# rare pull (purple/pink/red): bright rising arpeggio over the thud
arp = [(i * 0.07, tone(f, 0.6, 0.002, 0.18, (1, 0.4, 0.2))) for i, f in enumerate((523, 659, 784, 1047))]
save("case_rare.wav", mix(0.9, (0, tone(120, 0.3, 0.002, 0.08, (1, 0.5))), *arp))
# knife sting: metal shing, a boom, then a long gold shimmer
shing = lp(noise(0.5, 0.002, 0.18), 2) * np.sin(2 * np.pi * 3200 * t(0.5)) + tone(2400, 0.5, 0.001, 0.2, (1, 0.5, 0.3))
boom = mix(0.9, (0, tone(55, 0.9, 0.003, 0.3, (1, 0.7, 0.4))), (0, lp(noise(0.3, 0.001, 0.08), 12) * 1.5))
shim = [(0.12 + i * 0.06, tone(f, 1.0, 0.002, 0.3, (1, 0.5, 0.25)) * 0.7) for i, f in enumerate((784, 988, 1175, 1568, 1976, 2349))]
save("knife_sting.wav", mix(1.6, (0, shing), (0.02, boom), *shim))
print("ok")
