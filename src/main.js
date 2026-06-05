import { Game } from "./game.js";
import { Multiplayer } from "./multiplayer.js";
import { AudioSynthManager } from "./synth-audio.js";

const audioSynth = new AudioSynthManager();

// DOM Elements
const lobbyScreen = document.getElementById("lobbyScreen");
const gameHUD = document.getElementById("gameHUD");
const joinForm = document.getElementById("joinForm");
const usernameInput = document.getElementById("usernameInput");
const colorSwatches = document.querySelectorAll(".color-swatch");
const canvas = document.getElementById("gameCanvas");

// Disable default context menu to allow right-click block placements
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// HUD Elements
const playerCountEl = document.getElementById("playerCount");
const playerListEl = document.getElementById("playerList");
const hotbarSlots = document.querySelectorAll(".hotbar-slot");
const recordBtn = document.getElementById("recordBtn");
const recordIndicator = document.getElementById("recordIndicator");
const recordTimer = document.getElementById("recordTimer");
const autoBadge = document.getElementById("autoBadge");

// State Variables
let selectedColor = "#ec4899"; // default active swatch color
let game = null;
let multiplayer = null;
let gameStarted = false;

// Recorder State Variables
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recordStartTime = 0;
let recordInterval = null;

// Initialize Color Swatch Picker
colorSwatches.forEach(swatch => {
  swatch.addEventListener("click", () => {
    colorSwatches.forEach(s => s.classList.remove("active"));
    swatch.classList.add("active");
    selectedColor = swatch.getAttribute("data-color");
  });
});

// Debounce and error fallback wrapper for Safari/Firefox pointer lock requests
let lastPointerLockRequest = 0;
function requestPointerLockWithFallback(element) {
  const now = Date.now();
  if (now - lastPointerLockRequest < 1000) {
    console.warn("Pointer lock request debounced to avoid browser security limits.");
    return;
  }
  lastPointerLockRequest = now;

  try {
    element.focus();
    const result = element.requestPointerLock();
    if (result && typeof result.catch === "function") {
      result.catch((err) => {
        console.warn("Pointer lock request rejected or failed:", err);
      });
    }
  } catch (err) {
    console.warn("Failed to execute requestPointerLock:", err);
  }
}

// Request pointer lock directly on click for Safari/Firefox compliance
const joinBtn = document.getElementById("joinBtn");
if (joinBtn) {
  joinBtn.addEventListener("click", () => {
    const username = usernameInput.value.trim();
    if (username) {
      audioSynth.resume();
      requestPointerLockWithFallback(canvas);
    }
  });
}

// Keep canvas focused whenever pointer lock is active
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement === canvas) {
    canvas.focus();
  }
});

// Handle Lobby Join Form Submission
joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  
  const username = usernameInput.value.trim();
  if (!username) return;

  // Initialize/resume AudioContext on user gesture
  audioSynth.resume();

  // Clean up and dispose of previous game/multiplayer instances when rejoining
  if (game) {
    try {
      game.dispose();
    } catch (err) {
      console.error("Error disposing game session:", err);
    }
    game = null;
  }
  if (multiplayer) {
    try {
      multiplayer.dispose();
    } catch (err) {
      console.error("Error disposing multiplayer session:", err);
    }
    multiplayer = null;
  }

  // 1. Transition HUD/Lobby visibility
  lobbyScreen.classList.add("hidden");
  gameHUD.classList.remove("hidden");
  
  // 2. Request pointer lock to lock mouse cursor for FPS controls
  requestPointerLockWithFallback(canvas);
  gameStarted = true;

  // 3. Initialize Babylon.js Game
  game = new Game("gameCanvas", (x, y, z, materialName) => {
    // This callback is triggered when player edits block in 3D
    if (multiplayer) {
      multiplayer.sendBlockChange(x, y, z, materialName);
    }
  }, audioSynth);
  window.game = game;

  // 4. Initialize Multiplayer Server connection
  multiplayer = new Multiplayer(username, selectedColor, game, {
    onPlayersUpdated: (playersList, myId) => {
      updatePlayersHUD(playersList, myId);
    }
  }, audioSynth);
  window.multiplayer = multiplayer;
});

// Click canvas to regain pointer lock while playing
canvas.addEventListener("click", () => {
  audioSynth.resume();
  if (gameStarted && document.pointerLockElement !== canvas) {
    requestPointerLockWithFallback(canvas);
  }
});

// ==========================================================================
// HUD Updates (Chat, Players, Hotbar)
// ==========================================================================

function updatePlayersHUD(players, myId) {
  playerCountEl.textContent = players.length;
  playerListEl.innerHTML = "";

  const debugBuildersCount = document.getElementById("debugBuildersCount");
  const meterBuilders = document.getElementById("meterBuilders");
  if (debugBuildersCount) debugBuildersCount.textContent = players.length;
  if (meterBuilders) {
    const percent = Math.min((players.length / 10) * 100, 100);
    meterBuilders.style.width = percent + "%";
  }

  players.forEach(p => {
    const row = document.createElement("div");
    row.className = `player-row ${p.id === myId ? "me" : ""}`;
    row.style.setProperty("--p-color", p.color);

    const dot = document.createElement("span");
    dot.className = "player-status-dot";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = p.username;

    row.appendChild(dot);
    row.appendChild(nameSpan);
    playerListEl.appendChild(row);
  });
}

function appendChatMessage(sender, color, text, system = false) {
  console.log(`[${sender}] ${text}`);
}

// ==========================================================================
// Hotbar / Material Selection
// ==========================================================================

function selectHotbarSlot(slotIndex) {
  hotbarSlots.forEach(slot => {
    if (parseInt(slot.getAttribute("data-index"), 10) === slotIndex) {
      slot.classList.add("active");
      const materialName = slot.getAttribute("data-material");
      if (game) {
        game.selectMaterial(materialName);
      }
    } else {
      slot.classList.remove("active");
    }
  });
}

// Hotbar Click Listeners
hotbarSlots.forEach(slot => {
  slot.addEventListener("click", () => {
    const index = parseInt(slot.getAttribute("data-index"), 10);
    selectHotbarSlot(index);
  });
});

// Keyboard 1-7 keys listeners
window.addEventListener("keydown", (e) => {
  if (!gameStarted) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const num = parseInt(e.key, 10);
  if (num >= 1 && num <= 7) {
    selectHotbarSlot(num);
  }
});

// ==========================================================================
// Gameplay Recorder Functions & Listeners
// ==========================================================================

function toggleRecording() {
  if (!gameStarted) return;
  
  if (!isRecording) {
    startRecording();
  } else {
    stopRecording();
  }
}

function startRecording() {
  recordedChunks = [];
  
  let stream;
  try {
    stream = canvas.captureStream(30); // Capture canvas at 30 FPS
  } catch (err) {
    console.error("Canvas captureStream is not supported:", err);
    appendChatMessage("System", "#ef4444", "Recording is not supported in this browser.", true);
    return;
  }
  
  let options = { mimeType: 'video/webm; codecs=vp9' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'video/webm; codecs=vp8' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = { mimeType: 'video/webm' };
    }
  }

  try {
    mediaRecorder = new MediaRecorder(stream, options);
  } catch (err) {
    console.error("MediaRecorder creation failed:", err);
    appendChatMessage("System", "#ef4444", "Failed to start recorder.", true);
    return;
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    
    // Auto download
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = `blocks-gameplay-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 100);

    appendChatMessage("System", "#10b981", "Recording downloaded successfully!", true);
  };

  mediaRecorder.start();
  isRecording = true;
  
  recordBtn.classList.add("recording");
  recordIndicator.classList.remove("hidden");
  
  recordStartTime = Date.now();
  updateRecordTimer();
  recordInterval = setInterval(updateRecordTimer, 1000);
  
  appendChatMessage("System", "#ef4444", "Recording started (WebM). Press 'R' or click again to stop.", true);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  isRecording = false;
  
  recordBtn.classList.remove("recording");
  recordIndicator.classList.add("hidden");
  autoBadge.classList.add("hidden");
  
  clearInterval(recordInterval);
  recordTimer.textContent = "REC 00:00";
}

function updateRecordTimer() {
  const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
  const minutes = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  recordTimer.textContent = `REC ${minutes}:${seconds}`;
}

// Button Click Listener
recordBtn.addEventListener("click", () => {
  toggleRecording();
});

// Keypress shortcut ('R' key)
window.addEventListener("keydown", (e) => {
  if (!gameStarted) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key.toLowerCase() === "r") {
    toggleRecording();
  }
});

// Expose game state globally for testing/automation purposes
window.game = game;
window.multiplayer = multiplayer;

// ==========================================================================
// Debug Overlay Event Listeners (F3 Toggle, Input Indicators, FPS Meter)
// ==========================================================================

// Toggle debug overlay with F3
window.addEventListener("keydown", (e) => {
  if (!gameStarted) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "F3") {
    e.preventDefault();
    const debugOverlay = document.getElementById("debugOverlay");
    if (debugOverlay) {
      debugOverlay.classList.toggle("hidden");
    }
  }
});

// Mouse button debug indicators
window.addEventListener("pointerdown", (e) => {
  if (!gameStarted) return;
  if (e.button === 0) {
    const btn = document.getElementById("btnLeft");
    if (btn) btn.classList.add("active");
  } else if (e.button === 2) {
    const btn = document.getElementById("btnRight");
    if (btn) btn.classList.add("active");
  }
});

window.addEventListener("pointerup", (e) => {
  if (!gameStarted) return;
  if (e.button === 0) {
    const btn = document.getElementById("btnLeft");
    if (btn) btn.classList.remove("active");
  } else if (e.button === 2) {
    const btn = document.getElementById("btnRight");
    if (btn) btn.classList.remove("active");
  }
});

// Keyboard mechanical keystroke presses debug indicators
const keyW = document.getElementById("keyW");
const keyA = document.getElementById("keyA");
const keyS = document.getElementById("keyS");
const keyD = document.getElementById("keyD");
const keySpace = document.getElementById("keySpace");

window.addEventListener("keydown", (e) => {
  if (!gameStarted) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "w" && keyW) keyW.classList.add("pressed");
  if (key === "a" && keyA) keyA.classList.add("pressed");
  if (key === "s" && keyS) keyS.classList.add("pressed");
  if (key === "d" && keyD) keyD.classList.add("pressed");
  if (e.code === "Space" && keySpace) keySpace.classList.add("pressed");
});

window.addEventListener("keyup", (e) => {
  if (!gameStarted) return;
  const key = e.key.toLowerCase();
  if (key === "w" && keyW) keyW.classList.remove("pressed");
  if (key === "a" && keyA) keyA.classList.remove("pressed");
  if (key === "s" && keyS) keyS.classList.remove("pressed");
  if (key === "d" && keyD) keyD.classList.remove("pressed");
  if (e.code === "Space" && keySpace) keySpace.classList.remove("pressed");
});

// Real-time FPS Counter Loop
let lastTime = performance.now();
let frameCount = 0;
let fps = 60;
function updateFPS() {
  const now = performance.now();
  frameCount++;
  if (now > lastTime + 1000) {
    fps = Math.round((frameCount * 1000) / (now - lastTime));
    const fpsEl = document.getElementById("debugFPS");
    const fpsMeter = document.getElementById("meterFPS");
    if (fpsEl) fpsEl.textContent = fps + " FPS";
    if (fpsMeter) {
      const percent = Math.min((fps / 60) * 100, 100);
      fpsMeter.style.width = percent + "%";
      if (fps < 30) {
        fpsMeter.style.backgroundColor = "#ef4444";
      } else if (fps < 50) {
        fpsMeter.style.backgroundColor = "#f59e0b";
      } else {
        fpsMeter.style.backgroundColor = "#10b981";
      }
    }
    frameCount = 0;
    lastTime = now;
  }
  requestAnimationFrame(updateFPS);
}
requestAnimationFrame(updateFPS);

// Reset stuck keys on window blur
window.addEventListener("blur", () => {
  if (keyW) keyW.classList.remove("pressed");
  if (keyA) keyA.classList.remove("pressed");
  if (keyS) keyS.classList.remove("pressed");
  if (keyD) keyD.classList.remove("pressed");
  if (keySpace) keySpace.classList.remove("pressed");

  if (game) {
    game._spaceReleased = true;
    if (game.camera && game.camera.inputs && game.camera.inputs.attached && game.camera.inputs.attached.keyboard) {
      game.camera.inputs.attached.keyboard.keys = [];
    }
  }
});
