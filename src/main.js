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

  // 4. Initialize Multiplayer Server connection
  multiplayer = new Multiplayer(username, selectedColor, game, {
    onPlayersUpdated: (playersList, myId) => {
      updatePlayersHUD(playersList, myId);
    }
  }, audioSynth);
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

  if (e.key.toLowerCase() === "r") {
    toggleRecording();
  }
});

// ==========================================================================
// Automated Demo / Verification Playbacks
// ==========================================================================

const SCENARIOS = {
  build_neon_tower: [
    { time: 500, action: "chat", text: "🤖 Automated Demo: Building Neon Tower..." },
    { time: 1000, action: "teleport", pos: { x: 0, y: 6.6, z: -4 }, rot: { y: 0 } },
    { time: 2000, action: "place", x: 0, y: 0, z: 0, material: "neon-blue" },
    { time: 3500, action: "place", x: 0, y: 1, z: 0, material: "neon-red" },
    { time: 5000, action: "place", x: 0, y: 2, z: 0, material: "neon-blue" },
    { time: 6500, action: "teleport", pos: { x: 3, y: 4.1, z: -3 }, rot: { y: -Math.PI / 4 } },
    { time: 7500, action: "teleport", pos: { x: 4, y: 5.1, z: 0 }, rot: { y: -Math.PI / 2 } },
    { time: 8500, action: "chat", text: "🤖 Neon tower built successfully!" },
    { time: 10000, action: "stop" }
  ],
  sandbox_test: [
    { time: 500, action: "chat", text: "🤖 Sandbox automated checks starting..." },
    { time: 1500, action: "place", x: -2, y: 0, z: 2, material: "grass" },
    { time: 2500, action: "place", x: -2, y: 1, z: 2, material: "wood" },
    { time: 3500, action: "delete", x: -2, y: 1, z: 2 },
    { time: 4500, action: "chat", text: "🤖 Sandbox checks completed." },
    { time: 5500, action: "stop" }
  ],
  navigate_world: [
    { time: 500, action: "chat", text: "🤖 Automated Bot: Initiating world navigation..." },
    { time: 1000, action: "teleport", pos: { x: 0, y: 6.6, z: -4 }, rot: { y: 0 } },
    { time: 1500, action: "input", type: "keydown", code: "KeyW", keyCode: 87 },
    { time: 3500, action: "input", type: "keydown", code: "Space", keyCode: 32 },
    { time: 3600, action: "input", type: "keyup", code: "Space", keyCode: 32 },
    { time: 5000, action: "input", type: "keyup", code: "KeyW", keyCode: 87 },
    { time: 5500, action: "input", type: "keydown", code: "KeyD", keyCode: 68 },
    { time: 7500, action: "input", type: "keyup", code: "KeyD", keyCode: 68 },
    { time: 8000, action: "chat", text: "🤖 Automated Bot: Navigation completed successfully!" },
    { time: 10000, action: "stop" }
  ]
};

function executeScenario(scenarioName) {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    console.error(`Scenario '${scenarioName}' not found.`);
    return;
  }

  // Force start recording if not already recording
  if (!isRecording) {
    startRecording();
  }

  // Show auto badge
  autoBadge.classList.remove("hidden");

  scenario.forEach(step => {
    setTimeout(() => {
      switch (step.action) {
        case "chat":
          console.log(`Automation: ${step.text}`);
          break;
        case "teleport":
          if (game) {
            let finalY = step.pos.y;
            if (finalY !== undefined && finalY !== null) {
              if (game.checkCollisionCustom(step.pos.x, finalY, step.pos.z)) {
                const safePos = game.getSafeSpawnPosition(step.pos.x, step.pos.z);
                finalY = safePos.y;
              }
            }
            game.teleportPlayer(step.pos.x, finalY, step.pos.z, step.rot.y);
          }
          break;
        case "place":
          if (multiplayer) multiplayer.sendBlockChange(step.x, step.y, step.z, step.material);
          break;
        case "delete":
          if (multiplayer) multiplayer.sendBlockChange(step.x, step.y, step.z, null);
          break;
        case "input":
          if (window.triggerPuppeteerKey) {
            window.triggerPuppeteerKey(step.type, step.code).catch(() => {});
          } else {
            const keyboardEvent = new KeyboardEvent(step.type, { code: step.code, keyCode: step.keyCode, bubbles: true });
            window.dispatchEvent(keyboardEvent);
            const canvasEl = document.getElementById("gameCanvas");
            if (canvasEl) canvasEl.dispatchEvent(keyboardEvent);
          }
          if (game && step.code === "Space") {
            const keyboardEvent = new KeyboardEvent(step.type, { code: step.code, keyCode: step.keyCode });
            if (step.type === "keydown") {
              game._onKeyDown(keyboardEvent);
            } else if (step.type === "keyup") {
              game._onKeyUp(keyboardEvent);
            }
          }
          break;
        case "stop":
          stopRecording();
          break;
      }
    }, step.time);
  });
}

// Expose automation API globally for testing agents
window.BlocksAutomation = {
  isRunning: false,
  get game() { return game; },
  get multiplayer() { return multiplayer; },
  runDemo: (scenarioName) => {
    if (window.BlocksAutomation.isRunning) {
      console.warn("Automation is already running.");
      return;
    }

    console.log(`Starting automated playback: ${scenarioName}`);
    window.BlocksAutomation.isRunning = true;

    // 1. Check if logged in. If not, auto-submit login first
    if (!gameStarted) {
      usernameInput.value = `Tester_Bot_${Math.floor(Math.random() * 900 + 100)}`;
      // Click the purple swatch for testing
      const purpleSwatch = document.querySelector(".color-swatch[data-color='#8b5cf6']");
      if (purpleSwatch) purpleSwatch.click();
      
      joinForm.dispatchEvent(new Event("submit"));
    }

    // 2. Wait for Babylon, world loading, and Multiplayer sockets to initialize, then execute
    const runWhenReady = () => {
      if (game && game.isWorldLoaded && multiplayer && multiplayer.socket.readyState === WebSocket.OPEN) {
        executeScenario(scenarioName);
        
        // Reset running flag after scenario stop time
        const scenario = SCENARIOS[scenarioName];
        if (scenario) {
          const stopStep = scenario.find(s => s.action === "stop");
          const duration = stopStep ? stopStep.time : 10000;
          setTimeout(() => {
            window.BlocksAutomation.isRunning = false;
          }, duration + 500);
        }
      } else {
        setTimeout(runWhenReady, 100);
      }
    };

    runWhenReady();
  }
};

// ==========================================================================
// Debug Overlay Event Listeners (F3 Toggle, Input Indicators, FPS Meter)
// ==========================================================================

// Toggle debug overlay with F3
window.addEventListener("keydown", (e) => {
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
  if (e.button === 0) {
    const btn = document.getElementById("btnLeft");
    if (btn) btn.classList.add("active");
  } else if (e.button === 2) {
    const btn = document.getElementById("btnRight");
    if (btn) btn.classList.add("active");
  }
});

window.addEventListener("pointerup", (e) => {
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
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  const key = e.key.toLowerCase();
  if (key === "w" && keyW) keyW.classList.add("pressed");
  if (key === "a" && keyA) keyA.classList.add("pressed");
  if (key === "s" && keyS) keyS.classList.add("pressed");
  if (key === "d" && keyD) keyD.classList.add("pressed");
  if (e.code === "Space" && keySpace) keySpace.classList.add("pressed");
});

window.addEventListener("keyup", (e) => {
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
