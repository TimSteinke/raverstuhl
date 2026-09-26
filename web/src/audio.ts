/**
 * A small 128 BPM techno loop (kick, offbeat bass, hats), synthesised with Web Audio and filtered
 * with the per-band attenuation of a propagation path: "what the neighbour hears". Volume is
 * normalised (the loudest band plays at the same level), so what changes is the spectrum.
 */

const BANDS = [31.5, 63, 125, 250, 500];

export class Rave {
  private ctx: AudioContext | null = null;
  private eq: BiquadFilterNode[] = [];
  private shelf!: BiquadFilterNode;
  private out!: GainNode;
  private timer = 0;
  private nextBeat = 0;
  private beat = 0;
  playing = false;

  private ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.35;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 12;
    let node: AudioNode = this.out;
    this.eq = BANDS.map((f) => {
      const b = ctx.createBiquadFilter();
      b.type = 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.2;
      b.gain.value = 0;
      node.connect(b);
      node = b;
      return b;
    });
    this.shelf = ctx.createBiquadFilter();
    this.shelf.type = 'highshelf';
    this.shelf.frequency.value = 700;
    node.connect(this.shelf);
    this.shelf.connect(limiter);
    limiter.connect(ctx.destination);
    return ctx;
  }

  /** Relative band gains in dB (0 = as on the dancefloor). Values are normalised to max 0. */
  setSpectrum(gainsDb: number[] | null) {
    this.ensure();
    const g = gainsDb ?? BANDS.map(() => 0);
    const top = Math.max(...g);
    const t = this.ctx!.currentTime;
    g.forEach((v, i) => this.eq[i].gain.setTargetAtTime(Math.max(v - top, -40), t, 0.05));
    // Everything above the 500 Hz band decays at least as fast as the 500 Hz band itself.
    this.shelf.gain.setTargetAtTime(Math.max(g[g.length - 1] - top - 12, -40), t, 0.05);
  }

  start() {
    const ctx = this.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    if (this.playing) return;
    this.playing = true;
    this.nextBeat = ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop() {
    this.playing = false;
    window.clearInterval(this.timer);
  }

  private schedule() {
    const ctx = this.ctx!;
    const spb = 60 / 128;
    while (this.nextBeat < ctx.currentTime + 0.12) {
      const t = this.nextBeat;
      this.kick(t);
      this.bass(t + spb / 2, this.beat % 8 === 7 ? 49 : 55);
      this.hat(t + spb / 2);
      if (this.beat % 2 === 1) this.hat(t + spb * 0.75, 0.25);
      this.nextBeat += spb;
      this.beat++;
    }
  }

  private kick(t: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.12);
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.5);
  }

  private bass(t: number, f: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(lp).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.25);
  }

  private hat(t: number, vol = 0.12) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * 0.05);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.value = vol;
    s.connect(hp).connect(g).connect(this.out);
    s.start(t);
  }
}
