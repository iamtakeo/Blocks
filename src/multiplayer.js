import PartySocket from "partysocket";

const MATERIAL_TO_ID = {
  "grass": 1,
  "dirt": 2,
  "wood": 3,
  "stone": 4,
  "glass": 5,
  "neon-red": 6,
  "neon-blue": 7,
  "leaves": 8,
  "flower-red": 9,
  "flower-yellow": 10
};

const ID_TO_MATERIAL = [
  null, "grass", "dirt", "wood", "stone", "glass",
  "neon-red", "neon-blue", "leaves", "flower-red", "flower-yellow"
];

export class Multiplayer {
  constructor(username, color, game, uiCallbacks, audioSynth) {
    this.username = username;
    this.color = color;
    this.game = game;
    this.uiCallbacks = uiCallbacks; // { onPlayersUpdated }
    this.audioSynth = audioSynth;
    this.playersRegistry = new Map(); // local cache of id -> player details
    
    this.numericToUuid = new Map();
    this.uuidToNumeric = new Map();
    
    this.blockSendBuffer = new ArrayBuffer(5);
    this.blockSendView = new DataView(this.blockSendBuffer);
    this.blockSendView.setUint8(0, 0x03);

    // Choose local vs production partykit server url
    const isLocal = window.location.hostname === "localhost" || 
                    window.location.hostname === "127.0.0.1" ||
                    window.location.port !== "";
                    
    const host = isLocal ? "localhost:1999" : "blocks-party.iamtakeo.partykit.dev";

    // Initialize PartySocket connection
    this.socket = new PartySocket({
      host,
      room: "main",
      query: {
        username: this.username,
        color: this.color
      }
    });
    this.socket.binaryType = "arraybuffer";

    this.initSocketEvents();
    this.initPlayerTick();
  }

  initSocketEvents() {
    this.socket.addEventListener("open", () => {
      console.log("PAGE LOG: Multiplayer Socket OPENED");
    });
    this.socket.addEventListener("close", (e) => {
      console.log("PAGE LOG: Multiplayer Socket CLOSED", e.code, e.reason);
    });
    this.socket.addEventListener("message", (event) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          this.handleBinaryMessage(event.data);
          return;
        }

        const data = JSON.parse(event.data);
        
        // Handle compact updates & batched arrays
        if (Array.isArray(data)) {
          if (typeof data[0] === 'string' && data[0] === 'u') {
            this.handleParsedMessage(data);
          } else {
            for (const msg of data) {
              this.handleParsedMessage(msg);
            }
          }
          return;
        }

        this.handleParsedMessage(data);
      } catch (err) {
        console.error("Multiplayer message parse error:", err);
      }
    });

    this.socket.addEventListener("error", (err) => {
      console.error("Multiplayer Socket Error:", err);
    });
  }

  handleParsedMessage(data) {
    if (Array.isArray(data) && data[0] === 'u') {
      const [_, id, x, y, z, rotY] = data;
      if (id !== this.myId) {
        const p = this.playersRegistry.get(id);
        if (p) {
          p.position = { x, y, z };
          p.rotation = { y: rotY };
          this.game.updatePlayer(id, p.username, p.color, p.position, p.rotation);
        }
      }
      return;
    }

    switch (data.type) {
      case "teleport": {
        this.game.teleportPlayer(data.x, data.y, data.z);
        break;
      }

      case "init": {
        this.myId = data.id;
        this.myNumericId = data.numericId;
        
        this.numericToUuid.clear();
        this.uuidToNumeric.clear();
        
        // Align local camera coordinates with the server-selected spawn position
        const myPlayer = data.players.find(p => p.id === this.myId);
        const spawnPos = data.spawnPosition || (myPlayer ? myPlayer.position : null);
        if (spawnPos) {
          this.game.camera.position.x = spawnPos.x;
          this.game.camera.position.z = spawnPos.z;
          if (myPlayer && myPlayer.rotation) {
            this.game.camera.rotation.y = myPlayer.rotation.y;
          }
          this.game.spawnPosition.x = spawnPos.x;
          this.game.spawnPosition.z = spawnPos.z;
        }
        
        // 1. Render all existing blocks (loadWorld will recalculate the correct camera height y)
        this.game.loadWorld(data.blocks);
        
        // 2. Clear and populate local registry
        for (const [id, p] of this.playersRegistry) {
          this.game.removePlayer(id);
        }
        this.playersRegistry.clear();
        data.players.forEach(p => {
          this.playersRegistry.set(p.id, p);
          this.numericToUuid.set(p.numericId, p.id);
          this.uuidToNumeric.set(p.id, p.numericId);
          if (p.id !== this.myId && p.position) {
            this.game.updatePlayer(p.id, p.username, p.color, p.position, p.rotation);
          }
        });

        // 3. Update UI list
        this.triggerPlayersUpdate();

        // Immediately send our actual loaded spawn position to the server
        this.sendCurrentPosition();
        break;
      }

      case "player-joined": {
        const p = data.player;
        if (p.id !== this.myId) {
          this.playersRegistry.set(p.id, p);
          this.numericToUuid.set(p.numericId, p.id);
          this.uuidToNumeric.set(p.id, p.numericId);
          if (p.position) {
            this.game.updatePlayer(p.id, p.username, p.color, p.position, p.rotation);
          }
          console.log(`${p.username} joined the sandbox.`);
          this.triggerPlayersUpdate();
        }
        break;
      }

      case "player-update": {
        if (data.id !== this.myId) {
          const p = this.playersRegistry.get(data.id);
          if (p) {
            p.position = data.position;
            p.rotation = data.rotation;
            this.game.updatePlayer(data.id, p.username, p.color, data.position, data.rotation);
          }
        }
        break;
      }

      case "player-left": {
        const p = this.playersRegistry.get(data.id);
        if (p) {
          this.numericToUuid.delete(p.numericId);
          this.uuidToNumeric.delete(data.id);
          this.game.removePlayer(data.id);
          console.log(`${p.username} left the sandbox.`);
          this.playersRegistry.delete(data.id);
          this.triggerPlayersUpdate();
        }
        break;
      }

      case "block-change": {
        const [xStr, yStr, zStr] = data.key.split(",");
        const x = parseInt(xStr, 10);
        const y = parseInt(yStr, 10);
        const z = parseInt(zStr, 10);
        
        // Update local scene block
        this.game.setBlock(x, y, z, data.block ? data.block.type : null);

        // Play procedural audio
        if (this.audioSynth) {
          const camPos = this.game.camera.position;
          const dx = x - camPos.x;
          const dy = y - camPos.y;
          const dz = z - camPos.z;
          if (dx*dx + dy*dy + dz*dz < 400) {
            if (data.block) {
              this.audioSynth.playPlace();
            } else {
              this.audioSynth.playBreak();
            }
          }
        }
        break;
      }
    }
  }

  handleBinaryMessage(buffer) {
    const view = new DataView(buffer);
    const type = view.getUint8(0);
    
    if (type === 0x02) {
      const numericId = view.getUint8(1);
      const id = this.numericToUuid.get(numericId);
      if (id && id !== this.myId) {
        const rawX = view.getInt16(2, true);
        const rawY = view.getInt16(4, true);
        const rawZ = view.getInt16(6, true);
        const rawYaw = view.getUint16(8, true);
        
        const x = rawX / 256;
        const y = rawY / 256;
        const z = rawZ / 256;
        const rotY = rawYaw / 65535 * (2 * Math.PI);
        
        const p = this.playersRegistry.get(id);
        if (p) {
          p.position = { x, y, z };
          p.rotation = { y: rotY };
          this.game.updatePlayer(id, p.username, p.color, p.position, p.rotation);
        }
      }
    } else if (type === 0x03) {
      const packed = view.getUint32(1, true);
      const x = (packed & 0x7F) - 50;
      const y = (packed >> 7) & 0x1F;
      const z = ((packed >> 12) & 0x7F) - 50;
      const materialId = (packed >> 19) & 0x0F;
      
      const materialName = ID_TO_MATERIAL[materialId];
      
      // Update local scene block
      this.game.setBlock(x, y, z, materialName);

      // Play procedural audio
      if (this.audioSynth) {
        const camPos = this.game.camera.position;
        const dx = x - camPos.x;
        const dy = y - camPos.y;
        const dz = z - camPos.z;
        if (dx*dx + dy*dy + dz*dz < 400) {
          if (materialName) {
            this.audioSynth.playPlace();
          } else {
            this.audioSynth.playBreak();
          }
        }
      }
    }
  }

  sendCurrentPosition() {
    if (this.socket.readyState === WebSocket.OPEN && this.myId) {
      const state = this.game.getPlayerState();
      this.lastSentState = state;

      const tickSendBuffer = new ArrayBuffer(9);
      const tickSendView = new DataView(tickSendBuffer);
      tickSendView.setUint8(0, 0x01);

      const rawX = Math.round(state.position.x * 256);
      const rawY = Math.round(state.position.y * 256);
      const rawZ = Math.round(state.position.z * 256);
      const normalizedYaw = ((state.rotation.y % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const rawYaw = Math.round(normalizedYaw / (2 * Math.PI) * 65535);

      tickSendView.setInt16(1, rawX, true);
      tickSendView.setInt16(3, rawY, true);
      tickSendView.setInt16(5, rawZ, true);
      tickSendView.setUint16(7, rawYaw, true);

      this.socket.send(tickSendBuffer);
    }
  }

  // Poll current camera coordinate state and upload it to the server (10Hz)
  initPlayerTick() {
    this.lastSentState = null;

    this.tickInterval = setInterval(() => {
      if (this.socket.readyState === WebSocket.OPEN && this.myId) {
        const state = this.game.getPlayerState();
        if (this.lastSentState) {
          const dx = Math.abs(state.position.x - this.lastSentState.position.x);
          const dy = Math.abs(state.position.y - this.lastSentState.position.y);
          const dz = Math.abs(state.position.z - this.lastSentState.position.z);
          const dr = Math.abs(state.rotation.y - this.lastSentState.rotation.y);
          if (dx <= 0.001 && dy <= 0.001 && dz <= 0.001 && dr <= 0.001) {
            return;
          }
        }
        this.sendCurrentPosition();
      }
    }, 100); // 100ms intervals (10Hz)
  }

  sendBlockChange(x, y, z, materialName) {
    if (this.socket.readyState === WebSocket.OPEN) {
      const materialId = MATERIAL_TO_ID[materialName] || 0;
      const offset = 50;
      const packed = ((x + offset) & 0x7F) |
                     (((y) & 0x1F) << 7) |
                     (((z + offset) & 0x7F) << 12) |
                     ((materialId & 0x0F) << 19);

      this.blockSendView.setUint32(1, packed, true);
      this.socket.send(this.blockSendBuffer);
    }
  }

  triggerPlayersUpdate() {
    this.uiCallbacks.onPlayersUpdated(
      Array.from(this.playersRegistry.values()),
      this.myId
    );
  }

  dispose() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.socket) {
      this.socket.close();
    }
  }
}
