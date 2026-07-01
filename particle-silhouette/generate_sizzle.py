#!/usr/bin/env python3
"""Generate the electric "sizzle" sound used when a pink jellyfish attaches to
the figure. Pure standard library (no numpy) so it runs anywhere.

Usage:  python3 generate_sizzle.py [output.wav]
Default output: sizzle.wav (next to this script).
"""
import math
import os
import random
import struct
import sys
import wave

SAMPLE_RATE = 44100
DURATION = 0.55  # seconds


def generate(path):
    n = int(SAMPLE_RATE * DURATION)
    samples = []
    prev_noise = 0.0
    # deterministic-ish but lively
    random.seed(7)
    for i in range(n):
        t = i / SAMPLE_RATE

        # bright, crackly noise (first-difference high-pass emphasises the fizz)
        w = random.uniform(-1.0, 1.0)
        high = w - prev_noise
        prev_noise = w
        # sparse crackle gating so it "spits" like burning
        crackle = high * (1.0 if random.random() < 0.55 else 0.25)

        # electric buzz: a descending square-ish zap for the "shock" character
        f = 90.0 + 380.0 * math.exp(-3.5 * t)
        buzz = math.copysign(1.0, math.sin(2.0 * math.pi * f * t))
        # a touch of higher harmonic for edge
        buzz += 0.4 * math.copysign(1.0, math.sin(2.0 * math.pi * f * 2.02 * t))

        # amplitude envelope: fast attack, exponential decay + tiny tremolo
        attack = min(1.0, t / 0.006)
        env = attack * math.exp(-6.5 * t)
        tremolo = 0.85 + 0.15 * math.sin(2.0 * math.pi * 60.0 * t)

        s = (0.72 * crackle + 0.30 * buzz) * env * tremolo
        samples.append(s)

    peak = max(1e-6, max(abs(s) for s in samples))
    scale = 0.9 / peak
    frames = bytearray()
    for s in samples:
        v = max(-1.0, min(1.0, s * scale))
        frames += struct.pack("<h", int(v * 32767))

    with wave.open(path, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(bytes(frames))
    print(f"wrote {path} ({len(frames)} bytes, {DURATION}s @ {SAMPLE_RATE}Hz)")


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "sizzle.wav")
    generate(out)
