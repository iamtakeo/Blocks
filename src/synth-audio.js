/**
 * AudioSynthManager - Procedural Web Audio API Synthesizer
 * Synthesizes low-latency retro sound effects: footsteps, placements, breaks, and jumps.
 */
export class AudioSynthManager {
  constructor() {
    this.ctx = null;
    this.masterVolume = null;
    this.noiseBuffer = null;
  }

  /**
   * Initializes the AudioContext and pre-allocates resources.
   * Must be called on a user gesture (click/submit) to satisfy browser autoplay policies.
   */
  init() {
    if (this.ctx) return;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      console.warn("AudioSynthManager: Web Audio API is not supported in this browser.");
      return;
    }

    try {
      this.ctx = new AudioContextClass();
      
      // Master volume node to balance global levels and prevent clipping
      this.masterVolume = this.ctx.createGain();
      this.masterVolume.gain.setValueAtTime(0.25, this.ctx.currentTime);
      this.masterVolume.connect(this.ctx.destination);

      // Pre-generate white noise buffer to reuse for performance/GC efficiency
      this.noiseBuffer = this._createNoiseBuffer();
      console.log("AudioSynthManager: Initialized successfully.");
    } catch (e) {
      console.error("AudioSynthManager: Initialization failed:", e);
    }
  }

  /**
   * Resumes the AudioContext if suspended.
   */
  resume() {
    if (!this.ctx) {
      this.init();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume()
        .then(() => console.log("AudioSynthManager: Context resumed."))
        .catch(err => console.error("AudioSynthManager: Failed to resume context:", err));
    }
  }

  /**
   * Generates a 2-second white noise buffer.
   * @private
   */
  _createNoiseBuffer() {
    const bufferSize = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /**
   * Helper to play a bandpass/lowpass/highpass filtered noise burst.
   * @private
   */
  _playNoiseBurst(filterType, filterFreq, filterQ, gainStart, decayTime, time) {
    if (!this.ctx || this.ctx.state === "suspended" || !this.noiseBuffer) return;

    const playTime = time !== undefined ? time : this.ctx.currentTime;
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = this.noiseBuffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(filterFreq, playTime);
    if (filterQ) {
      filter.Q.setValueAtTime(filterQ, playTime);
    }

    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(gainStart, playTime);
    // Smooth exponential decay to avoid clicky pops
    gainNode.gain.exponentialRampToValueAtTime(0.001, playTime + decayTime);

    noiseSource.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(this.masterVolume);

    noiseSource.start(playTime);
    noiseSource.stop(playTime + decayTime);
  }

  /**
   * Helper to play a pitch-swept sine/triangle wave thud/impact.
   * @private
   */
  _playThud(startFreq, endFreq, duration, volume, time) {
    if (!this.ctx || this.ctx.state === "suspended") return;

    const playTime = time !== undefined ? time : this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(startFreq, playTime);
    osc.frequency.exponentialRampToValueAtTime(endFreq, playTime + duration);

    gainNode.gain.setValueAtTime(volume, playTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, playTime + duration);

    osc.connect(gainNode);
    gainNode.connect(this.masterVolume);

    osc.start(playTime);
    osc.stop(playTime + duration);
  }

  /**
   * Play a footstep sound mapped to a material.
   * @param {string} material - grass, dirt, wood, stone, glass, neon
   */
  playFootstep(material) {
    if (!this.ctx || this.ctx.state === "suspended") return;
    
    // Normalize material names (e.g. "neon-blue" and "neon-red" map to "neon")
    let mat = (material || "dirt").toLowerCase();
    if (mat.startsWith("neon")) {
      mat = "neon";
    }

    const now = this.ctx.currentTime;

    switch (mat) {
      case "grass":
        // Soft bandpass noise crunch + soft mid-low ground impact thud
        this._playNoiseBurst("bandpass", 1100, 1.2, 0.08, 0.08, now);
        this._playThud(80, 45, 0.06, 0.06, now);
        break;

      case "dirt":
        // Lower frequency lowpass noise + deeper dull ground thud
        this._playNoiseBurst("lowpass", 380, 1.0, 0.10, 0.10, now);
        this._playThud(95, 50, 0.10, 0.08, now);
        break;

      case "wood":
        // Wood hollow block knock (combination of two frequencies) + tiny tap click
        this._playWoodKnock(now);
        break;

      case "stone":
        // Crisp highpass click + solid, higher-impact mid-tone thud
        this._playNoiseBurst("highpass", 2400, 2.0, 0.06, 0.04, now);
        this._playThud(170, 95, 0.06, 0.06, now);
        break;

      case "glass":
        // High frequency crystal/glass tinkle + very fast highpass noise
        this._playGlassTink(now);
        break;

      case "neon":
        // Futuristic electronic laser/synthesizer zap
        this._playNeonZap(now);
        break;

      default:
        // Fallback to dirt
        this._playNoiseBurst("lowpass", 400, 1.0, 0.08, 0.08, now);
        this._playThud(80, 50, 0.08, 0.08, now);
        break;
    }
  }

  _playWoodKnock(now) {
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc1.type = "triangle";
    osc1.frequency.setValueAtTime(155, now);

    osc2.type = "sine";
    osc2.frequency.setValueAtTime(225, now);

    gainNode.gain.setValueAtTime(0.12, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(this.masterVolume);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.08);
    osc2.stop(now + 0.08);

    // Subtle high frequency transient click
    this._playNoiseBurst("highpass", 1500, 2.0, 0.04, 0.01, now);
  }

  _playGlassTink(now) {
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc1.type = "sine";
    osc1.frequency.setValueAtTime(2200, now);

    osc2.type = "sine";
    osc2.frequency.setValueAtTime(2950, now);

    gainNode.gain.setValueAtTime(0.05, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.07);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(this.masterVolume);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.07);
    osc2.stop(now + 0.07);

    // Delicate glass dust crack
    this._playNoiseBurst("highpass", 4500, 1.0, 0.02, 0.02, now);
  }

  _playNeonZap(now) {
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gainNode = this.ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(550, now);
    osc.frequency.exponentialRampToValueAtTime(160, now + 0.12);

    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1100, now);
    filter.frequency.exponentialRampToValueAtTime(380, now + 0.12);
    filter.Q.setValueAtTime(3.5, now);

    gainNode.gain.setValueAtTime(0.05, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(this.masterVolume);

    osc.start(now);
    osc.stop(now + 0.12);
  }

  /**
   * Sound effect for block placement.
   * Ascending pitch sweep chord.
   */
  playPlace() {
    if (!this.ctx || this.ctx.state === "suspended") return;

    const now = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc1.type = "sine";
    osc1.frequency.setValueAtTime(260, now);
    osc1.frequency.exponentialRampToValueAtTime(460, now + 0.08);

    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(390, now);
    osc2.frequency.exponentialRampToValueAtTime(690, now + 0.08);

    gainNode.gain.setValueAtTime(0.10, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(this.masterVolume);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.08);
    osc2.stop(now + 0.08);
  }

  /**
   * Sound effect for block fracturing (break).
   * Multiple overlapping noise bursts and low thuds.
   */
  playBreak() {
    if (!this.ctx || this.ctx.state === "suspended") return;

    const now = this.ctx.currentTime;

    // Physical block fracture low-end rumble
    this._playThud(110, 45, 0.15, 0.12, now);

    // Overlapping scheduled sound particle crunches
    this._playNoiseBurst("bandpass", 650, 1.2, 0.10, 0.06, now);
    this._playNoiseBurst("bandpass", 520, 1.0, 0.08, 0.05, now + 0.03);
    this._playNoiseBurst("bandpass", 420, 0.8, 0.06, 0.04, now + 0.06);
  }

  /**
   * Sound effect for jump sweep.
   * Retro upward pitch sweep.
   */
  playJump() {
    if (!this.ctx || this.ctx.state === "suspended") return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gainNode = this.ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(680, now + 0.22);

    gainNode.gain.setValueAtTime(0.12, now);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    osc.connect(gainNode);
    gainNode.connect(this.masterVolume);

    osc.start(now);
    osc.stop(now + 0.22);
  }
}
