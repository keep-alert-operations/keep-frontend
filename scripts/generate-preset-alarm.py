"""Synthesize the noisy-preset alarm (REV-58): a heavy, loud action-trailer loop.

Regenerate the committed asset with numpy installed:

    python scripts/generate-preset-alarm.py src/assets/preset-alarm.wav

140 BPM in D minor, 16 bars (27.4 s), no silence anywhere so it loops straight
back into itself:
  bars 0-3     a booming impact and distorted "braaam" on every bar over a D
               drone, pumping distorted bass and string ostinato; Dm -> F
  bars 4-5     build: accelerating toms, snare roll, riser
  bars 6-13    full pulse: big low hit on every bar, taiko groove, arpeggio and
               heroic brass lead; doubled hits and octave lead from bar 10
  bars 14-15   final long braaam with the groove driving on, snare roll and
               riser back into bar 0
Everything is compressed hard and driven into a soft clipper, so the quietest
second stays within a few dB of the loudest. Filtering and reverb are circular
FFTs, so the loop is seamless. Output: 44.1 kHz mono 16-bit WAV.
"""
import sys
import wave

import numpy as np

SR = 44100
BPM = 140
BEAT = 60 / BPM
BAR = 4 * BEAT
S16 = BEAT / 4
BARS = 16
N = int(round(BARS * BAR * SR))
rng = np.random.default_rng(7)

CHORDS = {"Dm": (38, [62, 65, 69], 3), "F": (41, [65, 69, 72], 4)}  # root, voicing, third


def B(bar, step=0.0):
    return bar * BAR + step * S16


def chord_of(bar):
    return "Dm" if (bar // 2) % 2 == 0 else "F"


def hz(m):
    return 440.0 * 2 ** ((np.asarray(m, float) - 69) / 12)


def add(buf, t, sig):
    i0 = int(round(t * SR)) % N
    first = min(len(sig), N - i0)
    buf[i0:i0 + first] += sig[:first]
    if len(sig) > first:
        buf[:len(sig) - first] += sig[first:]


def spectral(x, response):
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(np.fft.rfft(x) * response(f), len(x))


def lp(x, fc, order=2):
    return spectral(x, lambda f: 1 / np.sqrt(1 + (f / fc) ** (2 * order)))


def hp(x, fc, order=2):
    return spectral(x, lambda f: 1 / np.sqrt(1 + (fc / np.maximum(f, 1e-9)) ** (2 * order)))


def norm(x):
    peak = np.abs(x).max()
    return x / peak if peak else x


def saw(freq, n, phase0=None):
    dt = np.broadcast_to(np.asarray(freq, float) / SR, (n,))
    ph = ((rng.random() if phase0 is None else phase0) + np.cumsum(dt) - dt) % 1.0
    v = 2 * ph - 1
    m = ph < dt
    x = ph[m] / dt[m]
    v[m] -= x + x - x * x - 1
    m = ph > 1 - dt
    x = (ph[m] - 1) / dt[m]
    v[m] -= x * x + x + x + 1
    return v


def pulse(freq, n, duty):
    p0 = rng.random()
    v = 0.5 * (saw(freq, n, p0) - saw(freq, n, (p0 + duty) % 1.0))
    return v - v.mean()


def sine(freq, n):
    dt = np.broadcast_to(np.asarray(freq, float) / SR, (n,))
    return np.sin(2 * np.pi * np.cumsum(dt))


def env(n, attack, tau=None, release=0.01):
    t = np.arange(n) / SR
    e = np.minimum(1.0, t / max(attack, 1e-4))
    if tau:
        e = e * np.exp(-t / tau)
    r = min(n, int(release * SR))
    if r:
        e[-r:] *= np.linspace(1, 0, r)
    return e


def keyframes(points):
    t = np.arange(N) / SR
    xs, ys = zip(*points)
    return np.interp(t, xs, ys, left=ys[0], right=ys[-1])


impact_bus, braam_bus, drone_bus, pad_bus, bass_bus = (np.zeros(N) for _ in range(5))
drum_bus, snare_bus, ost_bus, arp_bus, lead_bus, fx_bus = (np.zeros(N) for _ in range(6))


# --- Instruments -----------------------------------------------------------

def braam(t, chord, amp, length=3.4, tau=1.3):
    """Stacked, detuned saws with a sub, heavily distorted; brightness flares on the attack."""
    root, _, third = CHORDS[chord]
    n = int(length * SR)
    raw = np.zeros(n)
    for m, a in ((root - 12, 1.0), (root, 1.0), (root + 7, 0.8), (root + 12, 0.6), (root + 12 + third, 0.4)):
        for d in np.linspace(-0.15, 0.15, 5):
            raw += a * saw(hz(m + d), n)
    tt = np.arange(n) / SR
    bright = np.minimum(1, tt / 0.02) * np.exp(-tt / 0.45)
    x = np.tanh(4.0 * norm(lp(raw, 320) + 1.4 * bright * lp(raw, 3000)))
    x += 0.8 * sine(hz(root - 12), n)
    add(braam_bus, t, amp * x * env(n, 0.02, tau, 0.3))


def make_impact():
    n = int(2.5 * SR)
    tt = np.arange(n) / SR
    sub = sine(30 + 90 * np.exp(-tt * 7), n) * np.exp(-tt / 0.8)
    body = sine(70 + 120 * np.exp(-tt * 30), n) * np.exp(-tt / 0.18)
    thud = norm(lp(rng.standard_normal(n), 200)) * np.exp(-tt / 0.12)
    crack = norm(hp(rng.standard_normal(n), 2500)) * np.exp(-tt / 0.03)
    return np.tanh(2.5 * (sub + 0.7 * body + 0.6 * thud + 0.5 * crack))


def make_drum(kind):
    n = int({"tom": 0.6, "kick": 0.5, "snare": 0.5, "hat": 0.12, "crash": 3.0}[kind] * SR)
    tt = np.arange(n) / SR
    noise = rng.standard_normal(n)
    if kind == "tom":
        x = sine(85 + 70 * np.exp(-tt * 25), n) * np.exp(-tt / 0.25) + 0.5 * norm(lp(noise, 500)) * np.exp(-tt / 0.05)
        x = np.tanh(1.8 * x)
    elif kind == "kick":
        x = sine(48 + 120 * np.exp(-tt * 35), n) * np.exp(-tt / 0.22) + 0.35 * noise * np.exp(-tt * 900)
        x = np.tanh(2.0 * x)
    elif kind == "snare":
        x = norm(hp(lp(noise, 8000), 300)) * np.exp(-tt / 0.13) + 0.5 * sine(190, n) * np.exp(-tt / 0.05)
        x = np.tanh(1.8 * x)
    elif kind == "hat":
        x = norm(hp(noise, 7000)) * np.exp(-tt / 0.025)
    else:
        x = norm(hp(noise, 4000)) * np.exp(-tt / 1.0)
    return norm(x) * env(n, 0.0005, None, 0.02)


IMPACT = make_impact()
DRUM = {k: make_drum(k) for k in ("tom", "kick", "snare", "hat", "crash")}


def hit(kind, t, amp):
    if kind == "impact":
        add(impact_bus, t, amp * IMPACT)
    elif kind == "snare":
        add(snare_bus, t, amp * DRUM["snare"])
    else:
        add(drum_bus, t, amp * DRUM[kind])


def big_hit(bar, amp, long=False):
    hit("impact", B(bar), amp)
    if long:
        braam(B(bar), chord_of(bar), amp)
    else:
        braam(B(bar), chord_of(bar), 0.85 * amp, length=1.7, tau=0.6)


_ost_cache, _arp_cache, _bass_cache = {}, {}, {}


def ostinato_bar(bar):
    root = CHORDS[chord_of(bar)][0] + 12
    if root not in _ost_cache:
        n = int(S16 * 0.9 * SR)
        _ost_cache[root] = (saw(hz(root), n) + 0.5 * saw(hz(root + 12), n)) * env(n, 0.003, 0.07)
    for s, accent in enumerate([1, .6, .6, 1, .6, .6, 1, .6] * 2):
        add(ost_bus, B(bar, s), accent * _ost_cache[root])


def bass_bar(bar):
    """Pumping, distorted eighth-note bass on the chord root."""
    root = CHORDS[chord_of(bar)][0] - 12
    if root not in _bass_cache:
        n = int(2 * S16 * 0.92 * SR)
        x = saw(hz(root), n) + saw(hz(root + 12) * 1.004, n)
        _bass_cache[root] = np.tanh(3.0 * norm(lp(x, 500))) * env(n, 0.004, 0.18)
    for s in range(0, 16, 2):
        add(bass_bus, B(bar, s), _bass_cache[root])


def arp_bar(bar):
    tones = CHORDS[chord_of(bar)][1]
    tones = [m + 12 for m in tones] + [tones[0] + 24]
    for s, idx in enumerate([0, 1, 2, 3, 2, 1, 2, 3] * 2):
        m = tones[idx]
        if m not in _arp_cache:
            n = int(S16 * 0.95 * SR)
            _arp_cache[m] = (pulse(hz(m), n, 0.3) + 0.5 * saw(hz(m), n)) * env(n, 0.002, 0.1)
        add(arp_bus, B(bar, s), _arp_cache[m])


MELODY = {  # per bar % 4, (midi, beats); bars 0-1 are Dm, 2-3 are F
    0: [(69, 2), (74, 1), (76, 1)],
    1: [(77, 3), (76, 1)],
    2: [(72, 2), (69, 1), (72, 1)],
    3: [(77, 2), (79, 1), (81, 1)],
}


def lead_bar(bar, octaves=(0,)):
    beat = 0
    for m, beats in MELODY[bar % 4]:
        n = int(beats * BEAT * SR)
        tt = np.arange(n) / SR
        vib = 2 ** (0.15 * np.sin(2 * np.pi * 5 * tt) * np.minimum(1, np.maximum(0, tt - 0.25) / 0.2) / 12)
        x = np.zeros(n)
        for o in octaves:
            f = hz(m + 12 * o) * vib
            x += sum(saw(f * 2 ** (d / 1200), n) for d in (-8, 0, 8)) / 3
        x += 0.5 * saw(hz(m - 12) * vib, n)
        add(lead_bus, B(bar) + beat * BEAT, np.tanh(2.0 * x) * env(n, 0.03, None, 0.06))
        beat += beats


def pad_and_drone():
    for bar in range(0, BARS, 2):
        n = int((2 * BAR + 0.3) * SR)
        x = sum(saw(hz(m + d), n) for m in CHORDS[chord_of(bar)][1] for d in (-0.08, 0, 0.08))
        add(pad_bus, B(bar) - 0.15, x * env(n, 0.15, None, 0.3))
    t = np.arange(N) / SR
    drone_bus[:] = np.sin(2 * np.pi * hz(26) * t) + 0.6 * lp(saw(hz(38), N), 220)


def riser(t0, t1, amp):
    n = int((t1 - t0) * SR)
    ramp = np.linspace(0, 1, n)
    noise = norm(hp(rng.standard_normal(n), 1500)) * ramp ** 2
    tone = norm(lp(saw(150 * 10 ** ramp, n), 4000)) * ramp ** 1.5
    add(fx_bus, t0, amp * (noise + 0.6 * tone) * env(n, 0.01, None, 0.005))


def groove_bar(bar, amp, hats=0):
    for s in (0, 3, 6, 8, 10, 11, 14):
        hit("tom", B(bar, s), amp * (1.0 if s in (0, 8) else 0.75))
    for s in (0, 8, 10):
        hit("kick", B(bar, s), amp)
    for s in (4, 12):
        hit("snare", B(bar, s), amp)
    for s in range(0, 16, 1 if hats == 16 else 2) if hats else ():
        hit("hat", B(bar, s), amp * (0.6 if s % 4 else 0.9))


def snare_roll(bar, amp):
    for s in range(16):
        hit("snare", B(bar, s), amp * (0.6 + 0.025 * s))
        if s >= 8:
            hit("snare", B(bar, s + 0.5), amp * (0.6 + 0.025 * s))


# --- Score -----------------------------------------------------------------
pad_and_drone()
for bar in range(BARS):
    ostinato_bar(bar)
    bass_bar(bar)
    big_hit(bar, 1.0, long=bar in (0, 2, 6, 10))
for bar in range(2, BARS):
    arp_bar(bar)

for bar in range(4):                            # intro: heavy hits, half-time toms
    for s in (0, 4, 8, 10, 12):
        hit("tom", B(bar, s), 0.8)
for s in range(0, 16, 2):                       # build
    hit("tom", B(4, s), 0.8 + 0.01 * s)
for s in range(16):
    hit("tom", B(5, s), 0.85 + 0.01 * s)
snare_roll(5, 0.9)
riser(B(4), B(6), 1.0)

for bar in range(6, 14):                        # full pulse and climax
    groove_bar(bar, 1.0, hats=16)
    lead_bar(bar, octaves=(0, 1) if bar >= 10 else (0,))
    if bar >= 10:
        hit("impact", B(bar, 8), 0.9)
for bar in (0, 6, 10):
    hit("crash", B(bar), 1.0)

braam(B(14), chord_of(14), 1.2, length=3.6, tau=2.0)   # final braaam drives back to the top
groove_bar(14, 1.0, hats=8)
groove_bar(15, 1.0, hats=16)
snare_roll(15, 1.0)
riser(B(14), B(16), 1.1)

# --- Mix -------------------------------------------------------------------
buses = {
    "impact": (impact_bus, 1.0),
    "braam": (braam_bus, 0.9),
    "bass": (bass_bus, 0.35),
    "drone": (drone_bus, 0.12),
    "pad": (lp(pad_bus, 2000), 0.25),
    "drums": (drum_bus, 0.6),
    "snare": (snare_bus, 0.5),
    "ost": (lp(ost_bus, 4000), 0.6),
    "arp": (lp(hp(arp_bus, 300), 8000), 0.5),
    "lead": (lp(lead_bus, 5000), 0.8),
    "fx": (fx_bus, 0.45),
}
mixed = {name: weight * norm(x) for name, (x, weight) in buses.items()}
dry = sum(mixed.values())
send = 0.4 * mixed["impact"] + 0.3 * mixed["braam"] + 0.8 * mixed["snare"] + 0.4 * mixed["lead"] + 0.4 * mixed["arp"]
nir = int(2.5 * SR)
tt = np.arange(nir) / SR
ir = lp(rng.standard_normal(nir) * np.exp(-tt / 0.5), 5000)
ir[:int(0.012 * SR)] = 0
ir /= np.sqrt((ir ** 2).sum())
ir_full = np.zeros(N)
ir_full[:nir] = ir
wet = np.fft.irfft(np.fft.rfft(send) * np.fft.rfft(ir_full), N)
mix = norm(hp(dry + 0.3 * wet, 30))  # drop sub-audible rumble that only eats headroom


def moving_avg(x, seconds):
    w = max(1, int(seconds * SR))
    c = np.cumsum(np.concatenate([x[-w:], x]))  # wrap so the loop start is compressed like the rest
    return (c[w:] - c[:-w]) / w


# Heavy compression (8:1 above -16 dBFS), then a hard drive into tanh.
level = np.sqrt(moving_avg(mix ** 2, 0.02)) + 1e-9
gain = moving_avg(np.where(level > 0.16, (0.16 / level) ** 0.875, 1.0), 0.005)
DRIVE = 2.4
out = np.tanh(DRIVE * norm(mix * gain)) / np.tanh(DRIVE) * 0.97

path = sys.argv[1]
with wave.open(path, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((out * 32767).astype("<i2").tobytes())
print(f"{path}: {N / SR:.1f}s, peak {np.abs(out).max():.3f}, RMS {20 * np.log10(np.sqrt((out ** 2).mean())):.1f} dBFS")
