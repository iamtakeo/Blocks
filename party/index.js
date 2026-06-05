function getChunkKey(voxelKey) {
  const [xStr, yStr, zStr] = voxelKey.split(",");
  const x = parseInt(xStr, 10);
  const y = parseInt(yStr, 10);
  const z = parseInt(zStr, 10);
  const cx = Math.floor(x / 16);
  const cy = Math.floor(y / 16);
  const cz = Math.floor(z / 16);
  return `chunk:${cx},${cy},${cz}`;
}

export default class BlocksServer {
  constructor(room) {
    this.room = room;
    this.players = new Map(); // Store connected player data: id -> { id, username, color, position, rotation }
    this.blocks = {}; // Stateful in-memory cache of world deltas
    this.chunks = {}; // Stateful in-memory cache of chunks (chunkKey -> chunkData)
    this.dirtyChunks = new Set(); // Queue of dirty chunks
    this.alarmScheduled = false;
  }

  async onStart() {
    this.chunks = {};
    
    try {
      // Migrate legacy 8x8x8 keys to 16x16x16 format if not already done
      const migrated = await this.room.storage.get("migrated_to_16");
      if (!migrated) {
        console.log("Starting legacy chunk migration to 16x16x16...");
        const allKeys = await this.room.storage.list();
        const legacyChunks = [];
        const allBlocks = {};
        
        for (const [key, value] of allKeys.entries()) {
          if (key.startsWith("chunk:")) {
            legacyChunks.push(key);
            Object.assign(allBlocks, value);
          }
        }
        
        if (legacyChunks.length > 0) {
          const newChunks = {};
          for (const [voxelKey, block] of Object.entries(allBlocks)) {
            const [xStr, yStr, zStr] = voxelKey.split(",");
            const x = parseInt(xStr, 10);
            const y = parseInt(yStr, 10);
            const z = parseInt(zStr, 10);
            
            const cx = Math.floor(x / 16);
            const cy = Math.floor(y / 16);
            const cz = Math.floor(z / 16);
            const newKey = `chunk:${cx},${cy},${cz}`;
            if (!newChunks[newKey]) {
              newChunks[newKey] = {};
            }
            newChunks[newKey][voxelKey] = block;
          }
          
          // Put new chunks
          for (const [chunkKey, chunkData] of Object.entries(newChunks)) {
            await this.room.storage.put(chunkKey, chunkData);
          }
          
          // Delete old chunks that are not part of new chunk keys
          for (const oldKey of legacyChunks) {
            if (!newChunks[oldKey]) {
              await this.room.storage.delete(oldKey);
            }
          }
        }
        await this.room.storage.put("migrated_to_16", true);
        console.log("Migration to 16x16x16 completed.");
      }
    } catch (err) {
      console.error("Migration failed:", err);
    }

    // Load the current chunks from storage into memory
    try {
      const list = await this.room.storage.list();
      for (const [key, value] of list.entries()) {
        if (key.startsWith("chunk:")) {
          this.chunks[key] = value;
          Object.assign(this.blocks, value);
        }
      }
    } catch (err) {
      console.error("Failed to load chunks on startup:", err);
    }
  }

  async onAlarm() {
    this.alarmScheduled = false;
    await this.flushDirtyChunks();
  }

  async flushDirtyChunks() {
    if (this.dirtyChunks.size === 0) return;
    
    const batch = {};
    for (const chunkKey of this.dirtyChunks) {
      batch[chunkKey] = this.chunks[chunkKey] || {};
    }
    
    this.dirtyChunks.clear();
    
    try {
      await this.room.storage.put(batch);
      console.log(`Flushed ${Object.keys(batch).length} dirty chunks to storage.`);
    } catch (err) {
      console.error("Failed to flush dirty chunks to storage:", err);
    }
  }

  async onConnect(connection, ctx) {
    console.log(`Connection opened: ${connection.id}`);
    
    // Parse query params to get player details
    const url = new URL(ctx.request.url);
    let username = url.searchParams.get("username") || `Player_${connection.id.slice(0, 4)}`;
    username = username.trim().slice(0, 16);
    if (!username) {
      username = `Player_${connection.id.slice(0, 4)}`;
    }
    
    let color = url.searchParams.get("color") || "#3b82f6"; // Default blue
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      color = "#3b82f6";
    }

    // Register new player
    const newPlayer = {
      id: connection.id,
      username,
      color,
      position: { x: 0, y: 1.5, z: 0 },
      rotation: { y: 0 }
    };
    this.players.set(connection.id, newPlayer);

    // 1. Send initial state to the connected player
    connection.send(JSON.stringify({
      type: "init",
      id: connection.id,
      players: Array.from(this.players.values()),
      blocks: this.blocks
    }));

    // 2. Broadcast the arrival of this new player to all others
    this.room.broadcast(
      JSON.stringify({
        type: "player-joined",
        player: newPlayer
      }),
      [connection.id] // exclude the joining player
    );
  }

  async onMessage(message, sender) {
    try {
      const data = JSON.parse(message);
      
      // 1. Handle compact updates (Array)
      if (Array.isArray(data)) {
        if (data[0] === 'u') {
          const [_, x, y, z, rotY] = data;
          const player = this.players.get(sender.id);
          if (player) {
            // Sanitize player updates
            if (typeof x !== 'number' || isNaN(x) || !isFinite(x) ||
                typeof y !== 'number' || isNaN(y) || !isFinite(y) ||
                typeof z !== 'number' || isNaN(z) || !isFinite(z) ||
                typeof rotY !== 'number' || isNaN(rotY) || !isFinite(rotY)) {
              return;
            }
            
            player.position = { x, y, z };
            player.rotation = { y: rotY };
            
            // Broadcast new position to everyone else
            this.room.broadcast(
              JSON.stringify(['u', sender.id, x, y, z, rotY]),
              [sender.id]
            );
          }
        }
        return;
      }

      // 2. Handle legacy or standard JSON messages
      switch (data.type) {
        case "player-update": {
          const player = this.players.get(sender.id);
          if (player && data.position && data.rotation) {
            const { x, y, z } = data.position;
            const rotY = data.rotation.y;
            if (typeof x !== 'number' || isNaN(x) || !isFinite(x) ||
                typeof y !== 'number' || isNaN(y) || !isFinite(y) ||
                typeof z !== 'number' || isNaN(z) || !isFinite(z) ||
                typeof rotY !== 'number' || isNaN(rotY) || !isFinite(rotY)) {
              return;
            }
            
            player.position = { x, y, z };
            player.rotation = { y: rotY };
            
            // Broadcast new position to everyone else (as compact update)
            this.room.broadcast(
              JSON.stringify(['u', sender.id, x, y, z, rotY]),
              [sender.id]
            );
          }
          break;
        }

        case "block-change": {
          if (!data.change) return;
          const { key, block } = data.change; // key: "x,y,z", block: { type, color } | null
          
          // Sanitize key
          if (typeof key !== 'string') return;
          const parts = key.split(",");
          if (parts.length !== 3) return;
          const x = parseInt(parts[0], 10);
          const y = parseInt(parts[1], 10);
          const z = parseInt(parts[2], 10);
          if (isNaN(x) || isNaN(y) || isNaN(z)) return;
          
          // Boundary limits: y >= 0 && y < 20 && Math.abs(x) < 50 && Math.abs(z) < 50
          if (y < 0 || y >= 20 || Math.abs(x) >= 50 || Math.abs(z) >= 50) {
            console.warn(`Block placement out of bounds: ${key}`);
            return;
          }
          
          // Placement rate-limiting: 10 actions max, recovery 10/sec
          const player = this.players.get(sender.id);
          if (!player) return;
          
          const now = Date.now();
          player.lastActionTime = player.lastActionTime || 0;
          player.actionTokens = player.actionTokens === undefined ? 10 : player.actionTokens;
          
          const elapsed = now - player.lastActionTime;
          player.actionTokens = Math.min(10, player.actionTokens + elapsed * 0.01);
          player.lastActionTime = now;
          
          if (player.actionTokens < 1) {
            console.warn(`Rate limit exceeded for player ${sender.id}`);
            return;
          }
          player.actionTokens -= 1;
          
          // Reach checks: within 8 units of the player position
          const dx = x - player.position.x;
          const dy = y - player.position.y;
          const dz = z - player.position.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > 8.0) {
            console.warn(`Reach check failed for player ${sender.id}: distance ${dist.toFixed(2)}`);
            return;
          }
          
          // Sanitize block format
          let sanitizedBlock = null;
          if (block !== null && typeof block === 'object') {
            if (typeof block.type !== 'string') return;
            const validMaterials = ["grass", "dirt", "wood", "stone", "glass", "neon-red", "neon-blue"];
            if (!validMaterials.includes(block.type)) return;
            sanitizedBlock = {
              type: block.type,
              color: typeof block.color === 'string' ? block.color : ""
            };
          }
          
          // Apply change to cache (store null for deletions to preserve delta overlay)
          this.blocks[key] = sanitizedBlock;
          
          // Update in-memory chunks cache (eliminate async reads)
          const chunkKey = getChunkKey(key);
          let chunk = this.chunks[chunkKey];
          if (!chunk) {
            chunk = {};
            this.chunks[chunkKey] = chunk;
          }
          chunk[key] = sanitizedBlock;
          
          // Queue dirty chunks for Durable Object Alarm
          this.dirtyChunks.add(chunkKey);
          if (!this.alarmScheduled) {
            this.alarmScheduled = true;
            try {
              await this.room.storage.setAlarm(Date.now() + 2000);
            } catch (err) {
              console.error("Failed to set alarm:", err);
            }
          }

          // Broadcast the block change to everyone in the room immediately (non-blocking)
          this.room.broadcast(JSON.stringify({
            type: "block-change",
            key,
            block: sanitizedBlock
          }));

          break;
        }
      }
    } catch (err) {
      console.error("Error processing message:", err);
    }
  }

  async onClose(connection) {
    console.log(`Connection closed: ${connection.id}`);
    
    // Remove the player
    this.players.delete(connection.id);

    // Broadcast departure to everyone else
    this.room.broadcast(JSON.stringify({
      type: "player-left",
      id: connection.id
    }));

    // Force-flush remaining dirty chunks when the last connection closes
    const connections = Array.from(this.room.getConnections());
    if (connections.length === 0) {
      console.log("Last connection closed. Force flushing dirty chunks...");
      if (this.alarmScheduled) {
        try {
          await this.room.storage.deleteAlarm();
        } catch (e) {}
        this.alarmScheduled = false;
      }
      await this.flushDirtyChunks();
    }
  }
}
