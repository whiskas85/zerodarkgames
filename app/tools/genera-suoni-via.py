import numpy as np
from scipy.io import wavfile
from scipy import signal
SR = 44100
rng = np.random.default_rng(7)

def t_(d): return np.arange(int(d * SR)) / SR
def reverb(x, decay=1.4, length=3.0, wet=0.35, bright=4000):
    n = int(length * SR); tt = np.arange(n) / SR
    ir = rng.standard_normal(n) * np.exp(-tt / (decay / 6.9))
    b, a = signal.butter(2, bright / (SR / 2)); ir = signal.lfilter(b, a, ir)
    ir[: int(0.012 * SR)] = 0  # predelay
    ir /= np.sqrt(np.sum(ir ** 2))
    y = signal.fftconvolve(np.concatenate([x, np.zeros(n)]), ir)[: len(x) + n]
    return (1 - wet) * np.concatenate([x, np.zeros(n)]) + wet * y * 0.6
def norm(x, peak=0.89):
    x = x - np.mean(x); x *= peak / (np.max(np.abs(x)) + 1e-9)
    fade = int(0.02 * SR); x[-fade:] *= np.linspace(1, 0, fade); return x
def fadeout(x, d=0.06):
    n = min(len(x), int(d * SR)); x = x.copy(); x[-n:] *= np.cos(np.linspace(0, np.pi / 2, n)) ** 2; return x
def trim(x, d):
    return fadeout(x[: int(d * SR)], 0.4)
def save(name, x): wavfile.write(name, SR, (norm(x) * 32767).astype(np.int16))

# ---------------- bip horror: battito di cuore + colpo metallico dissonante
def thump(f0=95, f1=42, d=0.45, amp=1.0):
    t = t_(d); f = f1 + (f0 - f1) * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    env = (1 - np.exp(-t * 400)) * np.exp(-t * 9)
    x = np.sin(ph) + 0.35 * np.sin(2 * ph) * np.exp(-t * 20)
    click = rng.standard_normal(len(t)) * np.exp(-t * 300) * 0.25
    b, a = signal.butter(2, 900 / (SR / 2)); click = signal.lfilter(b, a, click)
    return fadeout(amp * (x * env + click), 0.12)
def metal(d=1.6):
    t = t_(d); x = np.zeros_like(t)
    for f, a, k in [(233.1, 1.0, 2.2), (246.9, 0.8, 2.6), (370.0, 0.55, 3.2), (523.3, 0.4, 4.0), (811.0, 0.25, 5.5), (1187.0, 0.12, 7.0)]:
        x += a * np.sin(2 * np.pi * f * t + rng.random() * 6) * np.exp(-t * k)
    return fadeout(x * (1 - np.exp(-t * 200)) * 0.18, 0.3)
def tick():
    d = 1.6; out = np.zeros(int(d * SR))
    lub = thump(); dub = thump(85, 40, 0.4, 0.7)
    out[: len(lub)] += lub; s = int(0.2 * SR); out[s: s + len(dub)] += dub
    m = metal(); out[: len(m)] += m[: len(out)]
    # respiro scuro di sottofondo
    t = t_(d); n = rng.standard_normal(len(t)); b, a = signal.butter(2, [60 / (SR / 2), 260 / (SR / 2)], 'band')
    out += signal.lfilter(b, a, n) * np.exp(-t * 3) * 0.08
    return trim(reverb(fadeout(out, 0.3), decay=1.6, length=1.2, wet=0.32, bright=2500), 2.0)

# ---------------- corno da guerra
def horn_note(f, d, swell=0.7, bend_end=0.0):
    t = t_(d)
    # attacco che sale di intonazione, vibrato che cresce, piccole irregolarità
    scoop = -0.06 * np.exp(-t * 14)
    vib = (0.004 + 0.008 * np.clip((t - 0.5) / 1.0, 0, 1)) * np.sin(2 * np.pi * 4.6 * t)
    jit = signal.lfilter(*signal.butter(1, 6 / (SR / 2)), rng.standard_normal(len(t))) * 0.02
    bend = bend_end * np.clip((t - (d - 0.5)) / 0.5, 0, 1) ** 2
    freq = f * (1 + scoop + vib + jit + bend)
    ph = 2 * np.pi * np.cumsum(freq) / SR
    att = np.clip(t / 0.12, 0, 1) ** 1.5
    env = att * (0.55 + 0.45 * np.clip(t / swell, 0, 1)) * np.clip((d - t) / 0.35, 0, 1) ** 1.3
    x = np.zeros_like(t)
    for n in range(1, 40):
        if f * n > 9000: break
        # spettro da ottone: più forte = più armonici
        bright = 2.2 + 7.0 * env
        a = np.exp(-(n - 1) / bright) * (1.0 if n > 1 else 0.7)
        x += a * np.sin(n * ph + n * 0.3)
    # formanti del corno (risonanze del tubo e della campana)
    y = np.zeros_like(x)
    for fc, q, g in [(550, 1.2, 1.0), (1150, 2.0, 0.55), (2400, 3.0, 0.25)]:
        bw = fc / q; b, a = signal.butter(2, [max(30, fc - bw / 2) / (SR / 2), (fc + bw / 2) / (SR / 2)], 'band')
        y += g * signal.lfilter(b, a, x)
    y = 0.55 * y + 0.45 * signal.lfilter(*signal.butter(2, 3500 / (SR / 2)), x)
    # respiro
    br = rng.standard_normal(len(t)); b, a = signal.butter(2, [900 / (SR / 2), 4000 / (SR / 2)], 'band')
    y += signal.lfilter(b, a, br) * (0.05 + 0.25 * np.exp(-t * 18)) * np.clip(t / 0.03, 0, 1) * np.clip((d - t) / 0.3, 0, 1)
    return np.tanh(1.6 * y * env) 
def horn():
    f = 98.0  # Sol grave
    a = horn_note(f, 0.75, swell=0.4)
    b = horn_note(f, 2.9, swell=1.1, bend_end=0.06)
    gap = np.zeros(int(0.16 * SR))
    x = np.concatenate([a * 0.85, gap, b])
    return trim(reverb(x, decay=2.2, length=2.0, wet=0.36, bright=3000), 5.2)

save('bip-horror.wav', tick())
save('corno.wav', horn())
print('ok')
