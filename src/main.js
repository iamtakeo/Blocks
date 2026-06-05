import { Game } from "./game.js";
import { Multiplayer } from "./multiplayer.js";

// DOM Elements
const lobbyScreen = document.getElementById("lobbyScreen");
const gameHUD = document.getElementById("gameHUD");
const joinForm = document.getElementById("joinForm");
const usernameInput = document.getElementById("usernameInput");
const colorSwatches = document.querySelectorAll(".color-swatch");
const canvas = document.getElementById("gameCanvas");

// HUD Elements
const playerCountEl = document.getElementById("playerCount");
const playerListEl = document.getElementById("playerList");
const chatMessagesEl = document.getElementById("chatMessages");
const chatInputArea = document.getElementById("chatInputArea");
const chatInput = document.getElementById("chatInput");
const hotbarSlots = document.querySelectorAll(".hotbar-slot");
const recordBtn = document.getElementById("recordBtn");
const recordIndicator = document.getElementById("recordIndicator");
const recordTimer = document.getElementById("recordTimer");

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
    onChatReceived: (senderName, senderColor, messageText, isSystem = false) => {
      appendChatMessage(senderName, senderColor, messageText, isSystem);
    },
    onPlayersUpdated: (playersList, myId) => {
      updatePlayersHUD(playersList, myId);
    }
  });
});

// Click canvas to regain pointer lock while playing
canvas.addEventListener("click", () => {
  if (gameStarted && document.pointerLockElement !== canvas && chatInputArea.classList.contains("hidden")) {
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

function appendChatMessage(username, color, message, isSystem) {
  const msgDiv = document.createElement("div");
  
  if (isSystem) {
    msgDiv.className = "chat-message system";
    msgDiv.textContent = message;
  } else {
    msgDiv.className = "chat-message";
    
    const nameSpan = document.createElement("span");
    nameSpan.className = "chat-msg-username";
    nameSpan.style.setProperty("--u-color", color);
    nameSpan.textContent = username + ":";
    
    const textSpan = document.createElement("span");
    textSpan.textContent = message;
    
    msgDiv.appendChild(nameSpan);
    msgDiv.appendChild(textSpan);
  }

  chatMessagesEl.appendChild(msgDiv);
  
  // Auto scroll to bottom
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

// Chat input toggle on Enter key press
window.addEventListener("keydown", (e) => {
  if (!gameStarted) return;

  if (e.key === "Enter") {
    const isChatInputHidden = chatInputArea.classList.contains("hidden");

    if (isChatInputHidden) {
      // Open Chat Input
      chatInputArea.classList.remove("hidden");
      chatInput.focus();
      document.exitPointerLock(); // Free mouse to allow clicking or copying chat
    } else {
      // Send message if text not empty
      const text = chatInput.value.trim();
      if (text) {
        multiplayer.sendChatMessage(text);
        chatInput.value = "";
      }
      
      // Close Chat Input & return to game
      chatInputArea.classList.add("hidden");
      canvas.focus();
      canvas.requestPointerLock();
    }
  }
});

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
  
  // Check if we are currently typing in chat input
  if (document.activeElement === chatInput) return;

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
  if (document.activeElement === chatInput) return;

  if (e.key.toLowerCase() === "r") {
    toggleRecording();
  }
});
