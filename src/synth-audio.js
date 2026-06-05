/**
 * SynthVoice - Pre-allocated voice channel with a static DSP routing graph.
 * Minimizes node instantiation and topology changes to optimize for low-end devices.
 */
class SynthVoice {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;

    // Create the static nodes for this voice channel
    this.gainNode = this.ctx.createGain();
    this.filterNode = this.ctx.createBiquadFilter();

    // Set up the static routing topology:
    // Sources will connect to either filterNode or gainNode.
    // filterNode is permanently routed to gainNode, which goes to the destination.
    this.filterNode.connect(this.gainNode);
    this.gainNode.connect(this.destination);

    // Voice playback tracking state
    this.sources = [];
    this.active = false;
    this.startTime = 0;
    this.duration = 0;
    this.priority = 0;
    this.soundType = "";
  }

  /**
   * Checks if the voice is currently producing sound.
   */
  isActive(now) {
    return this.active && (now < this.startTime + this.duration);
  }

  /**
   * Gracefully steals this voice channel by ramping down the volume envelope
   * to zero quickly (10ms) and stopping the sources to avoid audio pops.
   */
  steal(now) {
    const currentGain = Number.isFinite(this.gainNode.gain.value) ? this.gainNode.gain.value : 0.1;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(currentGain, now);
    this.gainNode.gain.linearRampToValueAtTime(0, now + 0.01); // 10ms fade out

    this.filterNode.frequency.cancelScheduledValues(now);
    this.filterNode.Q.cancelScheduledValues(now);

    for (const src of this.sources) {
      try {
        src.stop(now + 0.01);
      } catch (e) {
        // Source node may have already stopped or not started
      }
    }

    this.active = false;
    this.sources = [];
  }

  /**
   * Trigger a filtered noise burst sound.
   */
  playNoise({ filterType, filterFreq, filterQ, gainStart, decayTime, time, noiseBuffer, priority, soundType }) {
    const now = this.ctx.currentTime;
    const playTime = time !== undefined ? time : now;
    let actualPlayTime = playTime;

    if (this.isActive(now)) {
      this.steal(now);
      actualPlayTime = now + 0.01; // delay slightly to allow 10ms ramp down
    } else {
      // Inactive: stop any residual sources and reset instantly
      this.active = false;
      this.gainNode.gain.cancelScheduledValues(now);
      for (const src of this.sources) {
        try { src.stop(now); } catch (e) {}
      }
      this.sources = [];
    }

    this.startTime = actualPlayTime;
    this.duration = decayTime;
    this.priority = priority;
    this.soundType = soundType;
    this.active = true;

    // Configure the static filter
    this.filterNode.type = filterType;
    this.filterNode.frequency.setValueAtTime(filterFreq, actualPlayTime);
    if (filterQ !== undefined) {
      this.filterNode.Q.setValueAtTime(filterQ, actualPlayTime);
    } else {
      this.filterNode.Q.setValueAtTime(1.0, actualPlayTime);
    }

    // Configure the gain envelope (exponential decay to prevent popping clicks)
    this.gainNode.gain.setValueAtTime(gainStart, actualPlayTime);
    this.gainNode.gain.exponentialRampToValueAtTime(0.001, actualPlayTime + decayTime);

    // Create a lightweight buffer source (needs recreation per spec, but connected to static filter)
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.connect(this.filterNode);
    this.sources.push(noiseSource);
    noiseSource.onended = () => {
      const index = this.sources.indexOf(noiseSource);
      if (index !== -1) {
        this.sources.splice(index, 1);
      }
    };

    noiseSource.start(actualPlayTime);
    noiseSource.stop(actualPlayTime + decayTime);
  }

  /**
   * Trigger single or multi-oscillator tone sweeps.
   */
  playTone({ oscConfig, gainStart, decayTime, time, priority, soundType }) {
    const now = this.ctx.currentTime;
    const playTime = time !== undefined ? time : now;
    let actualPlayTime = playTime;

    if (this.isActive(now)) {
      this.steal(now);
      actualPlayTime = now + 0.01;
    } else {
      // Inactive: stop residual sources instantly
      this.active = false;
      this.gainNode.gain.cancelScheduledValues(now);
      for (const src of this.sources) {
        try { src.stop(now); } catch (e) {}
      }
      this.sources = [];
    }

    this.startTime = actualPlayTime;
    this.duration = decayTime;
    this.priority = priority;
    this.soundType = soundType;
    this.active = true;

    // Configure the gain envelope
    this.gainNode.gain.setValueAtTime(gainStart, actualPlayTime);
    this.gainNode.gain.exponentialRampToValueAtTime(0.001, actualPlayTime + decayTime);

    // Spawn and configure individual oscillators
    for (const cfg of oscConfig) {
      const osc = this.ctx.createOscillator();
      osc.type = cfg.type;
      osc.frequency.setValueAtTime(cfg.startFreq, actualPlayTime);
      if (cfg.endFreq !== undefined && cfg.endFreq !== cfg.startFreq) {
        osc.frequency.exponentialRampToValueAtTime(cfg.endFreq, actualPlayTime + decayTime);
      }

      // If configuration requests filter (e.g. Neon Zap)
      if (cfg.filterConfig) {
        this.filterNode.type = cfg.filterConfig.type;
        this.filterNode.frequency.setValueAtTime(cfg.filterConfig.startFreq, actualPlayTime);
        if (cfg.filterConfig.endFreq) {
          this.filterNode.frequency.exponentialRampToValueAtTime(cfg.filterConfig.endFreq, actualPlayTime + decayTime);
        }
        if (cfg.filterConfig.Q) {
          this.filterNode.Q.setValueAtTime(cfg.filterConfig.Q, actualPlayTime);
        }
        osc.connect(this.filterNode);
      } else {
        // Direct route: bypass the filter to save CPU processing cycles
        osc.connect(this.gainNode);
      }

      this.sources.push(osc);
      osc.onended = () => {
        const index = this.sources.indexOf(osc);
        if (index !== -1) {
          this.sources.splice(index, 1);
        }
      };
      osc.start(actualPlayTime);
      osc.stop(actualPlayTime + decayTime);
    }
  }
}

/**
 * AudioSynthManager - Procedural Web Audio API Synthesizer
 * Synthesizes low-latency retro sound effects using pre-allocated voices and static connections.
 */
export class AudioSynthManager {
  constructor() {
    this.ctx = null;
    this.masterVolume = null;
    this.noiseBuffer = null;
    this.voices = [];
    this.MAX_VOICES = 16;
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

      // Pre-allocate the voice pool with static routing graphs
      this.voices = [];
      for (let i = 0; i < this.MAX_VOICES; i++) {
        this.voices.push(new SynthVoice(this.ctx, this.masterVolume));
      }

      console.log(`AudioSynthManager: Initialized successfully with ${this.MAX_VOICES} pre-allocated voices.`);
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
   * Helper to retrieve a free voice or steal one based on priority and age.
   * @private
   */
  _getVoice(priority, now) {
    if (!this.ctx || this.voices.length === 0) return null;

    // 1. Search for an inactive voice channel
    for (let i = 0; i < this.voices.length; i++) {
      if (!this.voices[i].isActive(now)) {
        return this.voices[i];
      }
    }

    // 2. Pool exhausted: find the best candidate to steal
    let bestCandidate = null;
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i];
      if (!bestCandidate) {
        bestCandidate = voice;
        continue;
      }

      // Steal criteria:
      // A. Prefer lower priority
      if (voice.priority < bestCandidate.priority) {
        bestCandidate = voice;
      } else if (voice.priority === bestCandidate.priority) {
        // B. Tie-breaker: oldest voice (earliest startTime)
        if (voice.startTime < bestCandidate.startTime) {
          bestCandidate = voice;
        }
      }
    }

    if (bestCandidate) {
      bestCandidate.steal(now);
      return bestCandidate;
    }

    return null;
  }

  /**
   * Helper to play a bandpass/lowpass/highpass filtered noise burst.
   * @private
   */
  _playNoiseBurst(filterType, filterFreq, filterQ, gainStart, decayTime, time, priority = 1, soundType = "footstep") {
    if (!this.ctx || this.ctx.state === "suspended" || !this.noiseBuffer) return;

    const playTime = time !== undefined ? time : this.ctx.currentTime;
    const voice = this._getVoice(priority, playTime);
    if (!voice) return;

    voice.playNoise({
      filterType,
      filterFreq,
      filterQ,
      gainStart,
      decayTime,
      time: playTime,
      noiseBuffer: this.noiseBuffer,
      priority,
      soundType
    });
  }

  /**
   * Helper to play a pitch-swept sine/triangle wave thud/impact.
   * @private
   */
  _playThud(startFreq, endFreq, duration, volume, time, priority = 1, soundType = "footstep") {
    if (!this.ctx || this.ctx.state === "suspended") return;

    const playTime = time !== undefined ? time : this.ctx.currentTime;
    const voice = this._getVoice(priority, playTime);
    if (!voice) return;

    voice.playTone({
      oscConfig: [
        { type: "sine", startFreq, endFreq }
      ],
      gainStart: volume,
      decayTime: duration,
      time: playTime,
      priority,
      soundType
    });
  }

  /**
   * Play a footstep sound mapped to a material.
   * @param {string} material - grass, dirt, wood, stone, glass, neon
   */
  playFootstep(material) {
    if (!this.ctx || this.ctx.state === "suspended") return;
    
    // Normalize material names
    let mat = (material || "dirt").toLowerCase();
    if (mat.startsWith("neon")) {
      mat = "neon";
    }

    const now = this.ctx.currentTime;

    switch (mat) {
      case "grass":
        // Soft bandpass noise crunch + soft mid-low ground impact thud
        this._playNoiseBurst("bandpass", 1100, 1.2, 0.08, 0.08, now, 1, "footstep");
        this._playThud(80, 45, 0.06, 0.06, now, 1, "footstep");
        break;

      case "dirt":
      case "leaves":
        // Lower frequency lowpass noise + deeper dull ground thud
        this._playNoiseBurst("lowpass", 380, 1.0, 0.10, 0.10, now, 1, "footstep");
        this._playThud(95, 50, 0.10, 0.08, now, 1, "footstep");
        break;

      case "wood":
        this._playWoodKnock(now);
        break;

      case "stone":
        // Crisp highpass click + solid, higher-impact mid-tone thud
        this._playNoiseBurst("highpass", 2400, 2.0, 0.06, 0.04, now, 1, "footstep");
        this._playThud(170, 95, 0.06, 0.06, now, 1, "footstep");
        break;

      case "glass":
        this._playGlassTink(now);
        break;

      case "neon":
        this._playNeonZap(now);
        break;

      default:
        // Fallback to dirt
        this._playNoiseBurst("lowpass", 400, 1.0, 0.08, 0.08, now, 1, "footstep");
        this._playThud(80, 50, 0.08, 0.08, now, 1, "footstep");
        break;
    }
  }

  _playWoodKnock(now) {
    const playTime = now !== undefined ? now : this.ctx.currentTime;

    // Tone part: dual-oscillator wood knock
    const voice1 = this._getVoice(1, playTime);
    if (voice1) {
      voice1.playTone({
        oscConfig: [
          { type: "triangle", startFreq: 155 },
          { type: "sine", startFreq: 225 }
        ],
        gainStart: 0.12,
        decayTime: 0.08,
        time: playTime,
        priority: 1,
        soundType: "footstep"
      });
    }

    // High frequency transient click
    const voice2 = this._getVoice(1, playTime);
    if (voice2) {
      voice2.playNoise({
        filterType: "highpass",
        filterFreq: 1500,
        filterQ: 2.0,
        gainStart: 0.04,
        decayTime: 0.01,
        time: playTime,
        noiseBuffer: this.noiseBuffer,
        priority: 1,
        soundType: "footstep"
      });
    }
  }

  _playGlassTink(now) {
    const playTime = now !== undefined ? now : this.ctx.currentTime;

    // Tone part: dual sine chime
    const voice1 = this._getVoice(1, playTime);
    if (voice1) {
      voice1.playTone({
        oscConfig: [
          { type: "sine", startFreq: 2200 },
          { type: "sine", startFreq: 2950 }
        ],
        gainStart: 0.05,
        decayTime: 0.07,
        time: playTime,
        priority: 1,
        soundType: "footstep"
      });
    }

    // Delicate glass dust crack
    const voice2 = this._getVoice(1, playTime);
    if (voice2) {
      voice2.playNoise({
        filterType: "highpass",
        filterFreq: 4500,
        filterQ: 1.0,
        gainStart: 0.02,
        decayTime: 0.02,
        time: playTime,
        noiseBuffer: this.noiseBuffer,
        priority: 1,
        soundType: "footstep"
      });
    }
  }

  _playNeonZap(now) {
    const playTime = now !== undefined ? now : this.ctx.currentTime;
    const voice = this._getVoice(1, playTime);
    if (!voice) return;

    voice.playTone({
      oscConfig: [
        {
          type: "sawtooth",
          startFreq: 550,
          endFreq: 160,
          filterConfig: {
            type: "bandpass",
            startFreq: 1100,
            endFreq: 380,
            Q: 3.5
          }
        }
      ],
      gainStart: 0.05,
      decayTime: 0.12,
      time: playTime,
      priority: 1,
      soundType: "footstep"
    });
  }

  /**
   * Sound effect for block placement.
   * Ascending pitch sweep chord.
   */
  playPlace() {
    if (!this.ctx || this.ctx.state === "suspended") return;

    const now = this.ctx.currentTime;
    const voice = this._getVoice(2, now); // Priority 2 (Place)
    if (!voice) return;

    voice.playTone({
      oscConfig: [
        { type: "sine", startFreq: 260, endFreq: 460 },
        { type: "triangle", startFreq: 390, endFreq: 690 }
      ],
      gainStart: 0.10,
      decayTime: 0.08,
      time: now,
      priority: 2,
      soundType: "place"
    });
  }

  /**
   * Sound effect for block fracturing (break).
   * Multiple overlapping noise bursts and low thuds.
   */
  playBreak() {
    if (!this.ctx || this.ctx.state === "suspended") return;

    const now = this.ctx.currentTime;

    // Physical block fracture low-end rumble
    this._playThud(110, 45, 0.15, 0.12, now, 2, "break");

    // Overlapping scheduled sound particle crunches
    this._playNoiseBurst("bandpass", 650, 1.2, 0.10, 0.06, now, 2, "break");
    this._playNoiseBurst("bandpass", 520, 1.0, 0.08, 0.05, now + 0.03, 2, "break");
    this._playNoiseBurst("bandpass", 420, 0.8, 0.06, 0.04, now + 0.06, 2, "break");
  }

  /**
   * Sound effect for jump sweep.
   * Retro upward pitch sweep.
   */
  playJump() {
    if (!this.ctx || this.ctx.state === "suspended") return;

    const now = this.ctx.currentTime;
    const voice = this._getVoice(3, now); // Priority 3 (Jump)
    if (!voice) return;

    voice.playTone({
      oscConfig: [
        { type: "triangle", startFreq: 140, endFreq: 680 }
      ],
      gainStart: 0.12,
      decayTime: 0.22,
      time: now,
      priority: 3,
      soundType: "jump"
    });
  }
}
