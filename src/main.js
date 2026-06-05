import { Game } from "./game.js";
import { Multiplayer } from "./multiplayer.js";

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

// Handle Lobby Join Form Submission
joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  
  const username = usernameInput.value.trim();
  if (!username) return;

  // 1. Transition HUD/Lobby visibility
  lobbyScreen.classList.add("hidden");
  gameHUD.classList.remove("hidden");
  
  // 2. Request pointer lock to lock mouse cursor for FPS controls
  canvas.focus();
  canvas.requestPointerLock();
  gameStarted = true;

  // 3. Initialize Babylon.js Game
  game = new Game("gameCanvas", (x, y, z, materialName) => {
    // This callback is triggered when player edits block in 3D
    if (multiplayer) {
      multiplayer.sendBlockChange(x, y, z, materialName);
    }
  });

  // 4. Initialize Multiplayer Server connection
  multiplayer = new Multiplayer(username, selectedColor, game, {
    onPlayersUpdated: (playersList, myId) => {
      updatePlayersHUD(playersList, myId);
    }
  });
});

// Click canvas to regain pointer lock while playing
canvas.addEventListener("click", () => {
  if (gameStarted && document.pointerLockElement !== canvas) {
    canvas.focus();
    canvas.requestPointerLock();
  }
});

// ==========================================================================
// HUD Updates (Chat, Players, Hotbar)
// ==========================================================================

function updatePlayersHUD(players, myId) {
  playerCountEl.textContent = players.length;
  playerListEl.innerHTML = "";

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
    { time: 1000, action: "teleport", pos: { x: 0, y: 1.5, z: -4 }, rot: { y: 0 } },
    { time: 2000, action: "place", x: 0, y: 0, z: 0, material: "neon-blue" },
    { time: 3500, action: "place", x: 0, y: 1, z: 0, material: "neon-red" },
    { time: 5000, action: "place", x: 0, y: 2, z: 0, material: "neon-blue" },
    { time: 6500, action: "teleport", pos: { x: 3, y: 2, z: -3 }, rot: { y: -Math.PI / 4 } },
    { time: 7500, action: "teleport", pos: { x: 4, y: 2, z: 0 }, rot: { y: -Math.PI / 2 } },
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
          if (game) game.teleportPlayer(step.pos.x, step.pos.y, step.pos.z, step.rot.y);
          break;
        case "place":
          if (multiplayer) multiplayer.sendBlockChange(step.x, step.y, step.z, step.material);
          break;
        case "delete":
          if (multiplayer) multiplayer.sendBlockChange(step.x, step.y, step.z, null);
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

    // 2. Wait for Babylon and Multiplayer sockets to initialize, then execute
    const runWhenReady = () => {
      if (game && multiplayer && multiplayer.socket.readyState === WebSocket.OPEN) {
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
// Debug Overlay Event Listeners (F3 Toggle & Mouse Indicators)
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
