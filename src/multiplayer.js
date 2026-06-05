import PartySocket from "partysocket";

export class Multiplayer {
  constructor(username, color, game, uiCallbacks) {
    this.username = username;
    this.color = color;
    this.game = game;
    this.uiCallbacks = uiCallbacks; // { onPlayersUpdated }
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

  // Poll current camera coordinate state and upload it to the server (20Hz)
  initPlayerTick() {
    setInterval(() => {
      if (this.socket.readyState === WebSocket.OPEN && this.myId) {
        const state = this.game.getPlayerState();
        this.socket.send(JSON.stringify({
          type: "player-update",
          position: state.position,
          rotation: state.rotation
        }));
      }
    }, 50); // 50ms intervals
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
}
