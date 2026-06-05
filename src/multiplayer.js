import PartySocket from "partysocket";

export class Multiplayer {
  constructor(username, color, game, uiCallbacks, audioSynth) {
    this.username = username;
    this.color = color;
    this.game = game;
    this.uiCallbacks = uiCallbacks; // { onPlayersUpdated }
    this.audioSynth = audioSynth;
    this.playersRegistry = new Map(); // local cache of id -> player details
    
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

    this.initSocketEvents();
    this.initPlayerTick();
  }

  initSocketEvents() {
    this.socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Handle compact updates
        if (Array.isArray(data)) {
          if (data[0] === 'u') {
            const [_, id, x, y, z, rotY] = data;
            if (id !== this.myId) {
              const p = this.playersRegistry.get(id);
              if (p) {
                p.position = { x, y, z };
                p.rotation = { y: rotY };
                this.game.updatePlayer(id, p.username, p.color, p.position, p.rotation);
              }
            }
          }
          return;
        }

        switch (data.type) {
          case "init": {
            this.myId = data.id;
            
            // 1. Render all existing blocks
            this.game.loadWorld(data.blocks);
            
            // 2. Clear and populate local registry
            this.playersRegistry.clear();
            data.players.forEach(p => {
              this.playersRegistry.set(p.id, p);
              if (p.id !== this.myId) {
                this.game.updatePlayer(p.id, p.username, p.color, p.position, p.rotation);
              }
            });

            // 3. Update UI list
            this.triggerPlayersUpdate();
            break;
          }

          case "player-joined": {
            const p = data.player;
            if (p.id !== this.myId) {
              this.playersRegistry.set(p.id, p);
              this.game.updatePlayer(p.id, p.username, p.color, p.position, p.rotation);
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
              if (data.block) {
                this.audioSynth.playPlace();
              } else {
                this.audioSynth.playBreak();
              }
            }
            break;
          }
        }
      } catch (err) {
        console.error("Multiplayer message parse error:", err);
      }
    });

    this.socket.addEventListener("error", (err) => {
      console.error("Multiplayer Socket Error:", err);
    });
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
        this.lastSentState = state;
        this.socket.send(JSON.stringify([
          'u',
          state.position.x,
          state.position.y,
          state.position.z,
          state.rotation.y
        ]));
      }
    }, 100); // 100ms intervals (10Hz)
  }

  sendBlockChange(x, y, z, materialName) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: "block-change",
        change: {
          key: `${x},${y},${z}`,
          block: materialName ? { type: materialName, color: "" } : null
        }
      }));
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
