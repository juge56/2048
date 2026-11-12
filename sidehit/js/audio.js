// Fully synthesised sound: wind, edge hiss, landing thumps and score chimes.
export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const loop = (type, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      return { filter, gain };
    };
    this.wind = loop('bandpass', 500, 0.6);
    this.edge = loop('highpass', 2600, 0.5);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.value = this.muted ? 0 : 0.8;
    return this.muted;
  }

  // speed in m/s, carve 0..1 (how hard the edge is working), on snow or not
  update(speed, carve, onSnow, onRail) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.wind.gain.gain.setTargetAtTime(Math.min(speed / 32, 1) ** 1.6 * 0.5, t, 0.1);
    this.wind.filter.frequency.setTargetAtTime(350 + speed * 28, t, 0.1);
    const glide = onSnow ? 0.03 + Math.min(speed / 30, 1) * 0.07 + carve * 0.3 : onRail ? 0.22 : 0;
    this.edge.gain.gain.setTargetAtTime(glide, t, 0.05);
    this.edge.filter.frequency.setTargetAtTime(onRail ? 5200 : 2400 - carve * 1000, t, 0.05);
  }

  // Cut the looping wind and edge noise, e.g. when leaving a ride.
  silence() {
    if (!this.ctx) return;
    for (const l of [this.wind, this.edge]) { l.gain.gain.cancelScheduledValues(this.ctx.currentTime); l.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03); }
  }
  suspend() { if (this.ctx) this.ctx.suspend(); }

  _tone(type, f0, f1, dur, vol, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator(), gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  thump(strength) { this._tone('sine', 140, 40, 0.22, Math.min(0.25 + strength * 0.06, 0.9)); }
  pop() { this._tone('triangle', 220, 420, 0.08, 0.2); }
  clank() { this._tone('square', 880, 620, 0.09, 0.12); }
  chime(n) { for (let i = 0; i < Math.min(n, 4) + 1; i++) this._tone('sine', 660 * 1.26 ** i, 660 * 1.26 ** i, 0.25, 0.14, i * 0.07); }
  crash() { this._tone('sawtooth', 160, 35, 0.4, 0.4); }
}
