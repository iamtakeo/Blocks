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

export default class BlocksServer {
  constructor(room) {
    this.room = room;
    this.players = new Map();
    this.blocks = {};
    this.chunks = {};
    this.dirtyChunks = new Set();
    this.dirtyVoxels = new Map();
    this.alarmScheduled = false;
    this.freeIds = Array.from({length: 255}, (_, i) => 255 - i); // 255 down to 1
  }

  get hasSql() {
    return !!(this.room.storage && this.room.storage.sql);
  }

  runTransaction(callback) {
    if (typeof this.room.storage.transactionSync === "function") {
      this.room.storage.transactionSync(callback);
    } else {
      callback();
    }
  }

  async onStart() {
    this.chunks = {};
    this.blocks = {};
    this.dirtyVoxels.clear();
    this.dirtyChunks.clear();

    if (this.hasSql) {
      console.log("Cloudflare Durable Object SQLite storage detected.");
      // 1. Initialize SQLite schema via a migration block
      try {
        this.runTransaction(() => {
          // Create migration table to track schema versions
          this.room.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS _migrations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT UNIQUE NOT NULL,
              applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);

          // Check if init migration is already applied
          const migrationCheck = this.room.storage.sql.exec(
            "SELECT id FROM _migrations WHERE name = 'init_voxels_schema'"
          ).toArray();

          if (migrationCheck.length === 0) {
            console.log("Applying SQLite schema migration: init_voxels_schema...");

            // Create voxels table (WITHOUT ROWID for clustered index lookup optimization)
            this.room.storage.sql.exec(`
              CREATE TABLE IF NOT EXISTS voxels (
                x INTEGER NOT NULL,
                y INTEGER NOT NULL,
                z INTEGER NOT NULL,
                cx INTEGER NOT NULL,
                cy INTEGER NOT NULL,
                cz INTEGER NOT NULL,
                type TEXT NOT NULL,
                color TEXT,
                PRIMARY KEY (x, y, z)
              ) WITHOUT ROWID
            `);

            // Create secondary index for chunk-based coordinate queries
            this.room.storage.sql.exec(`
              CREATE INDEX IF NOT EXISTS idx_voxels_chunk ON voxels (cx, cy, cz)
            `);

            // Log migration as applied
            this.room.storage.sql.exec(
              "INSERT INTO _migrations (name) VALUES ('init_voxels_schema')"
            );

            // Run database optimization
            try {
              this.room.storage.sql.exec("PRAGMA optimize");
            } catch (e) {}

            console.log("SQLite schema initialized successfully.");
          }
        });
      } catch (err) {
        console.error("Failed to run SQLite schema initialization:", err);
      }

      // 2. Run data migration from legacy KV store to SQLite if necessary
      try {
        const row = this.room.storage.sql.exec("SELECT count(*) as count FROM voxels").one();
        const sqliteCount = row ? row.count : 0;
        
        if (sqliteCount === 0) {
          console.log("SQLite voxels table is empty. Checking for legacy KV storage data...");
          const allKeys = await this.room.storage.list();
          const kvChunks = [];
          
          for (const [key, value] of allKeys.entries()) {
            if (key.startsWith("chunk:")) {
              kvChunks.push({ key, data: value });
            }
          }
          
          if (kvChunks.length > 0) {
            console.log(`Found ${kvChunks.length} legacy chunks in KV storage. Migrating to SQLite...`);
            
            this.runTransaction(() => {
              let totalMigrated = 0;
              for (const chunk of kvChunks) {
                if (!chunk.data || typeof chunk.data !== "object") continue;
                for (const [voxelKey, block] of Object.entries(chunk.data)) {
                  const [xStr, yStr, zStr] = voxelKey.split(",");
                  const x = parseInt(xStr, 10);
                  const y = parseInt(yStr, 10);
                  const z = parseInt(zStr, 10);
                  const cx = Math.floor(x / 16);
                  const cy = Math.floor(y / 16);
                  const cz = Math.floor(z / 16);
                  
                  const typeVal = block === null ? "delete" : (block.type || "grass");
                  const colorVal = (block && block.color) || "";
                  
                  this.room.storage.sql.exec(
                    `INSERT OR REPLACE INTO voxels (x, y, z, cx, cy, cz, type, color) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    x, y, z, cx, cy, cz, typeVal, colorVal
                  );
                  totalMigrated++;
                }
              }
              console.log(`Migrated ${totalMigrated} voxel actions to SQLite.`);
            });
            
            // Cleanup legacy KV keys
            for (const chunk of kvChunks) {
              await this.room.storage.delete(chunk.key);
            }
            try {
              await this.room.storage.delete("migrated_to_16");
            } catch (e) {}
            console.log("Legacy KV chunks deleted from storage.");
          }
        }
      } catch (err) {
        console.error("Failed to migrate legacy KV chunks to SQLite:", err);
      }

      // 3. Load active database state from SQLite into memory for fast startup & initial syncs
      try {
        const cursor = this.room.storage.sql.exec("SELECT x, y, z, type, color FROM voxels");
        let count = 0;
        for (const row of cursor) {
          const key = `${row.x},${row.y},${row.z}`;
          if (row.type === "delete") {
            this.blocks[key] = null;
          } else {
            this.blocks[key] = { type: row.type, color: row.color || "" };
          }
          count++;
        }
        console.log(`Loaded ${count} voxel records from SQLite into memory.`);
      } catch (err) {
        console.error("Failed to load voxels from SQLite:", err);
      }

    } else {
      console.log("Standard Key-Value storage detected. Using legacy fallback.");
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
  }

  async onAlarm() {
    this.alarmScheduled = false;
    if (this.hasSql) {
      await this.flushDirtyVoxels();
    } else {
      await this.flushDirtyChunks();
    }
  }

  async flushDirtyVoxels() {
    if (this.dirtyVoxels.size === 0) return;

    const updates = Array.from(this.dirtyVoxels.entries());
    this.dirtyVoxels.clear();

    try {
      this.runTransaction(() => {
        for (const [voxelKey, block] of updates) {
          const [xStr, yStr, zStr] = voxelKey.split(",");
          const x = parseInt(xStr, 10);
          const y = parseInt(yStr, 10);
          const z = parseInt(zStr, 10);
          
          if (block === null) {
            // Write a deletion record or delete row depending on procedural status.
            // Note: to persist client terrain deletes, we store a 'delete' type placeholder.
            const cx = Math.floor(x / 16);
            const cy = Math.floor(y / 16);
            const cz = Math.floor(z / 16);
            this.room.storage.sql.exec(
              `INSERT OR REPLACE INTO voxels (x, y, z, cx, cy, cz, type, color) 
               VALUES (?, ?, ?, ?, ?, ?, 'delete', '')`,
              x, y, z, cx, cy, cz
            );
          } else {
            const cx = Math.floor(x / 16);
            const cy = Math.floor(y / 16);
            const cz = Math.floor(z / 16);
            this.room.storage.sql.exec(
              `INSERT OR REPLACE INTO voxels (x, y, z, cx, cy, cz, type, color) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              x, y, z, cx, cy, cz, block.type, block.color || ""
            );
          }
        }
      });
      console.log(`Flushed ${updates.length} dirty voxels to SQLite.`);
    } catch (err) {
      console.error("Failed to flush dirty voxels to SQLite:", err);
      // Restore updates to dirty map to retry on next alarm
      for (const [voxelKey, block] of updates) {
        if (!this.dirtyVoxels.has(voxelKey)) {
          this.dirtyVoxels.set(voxelKey, block);
        }
      }
      if (!this.alarmScheduled) {
        this.alarmScheduled = true;
        try {
          await this.room.storage.setAlarm(Date.now() + 2000);
        } catch (e) {}
      }
    }
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
    
    const url = new URL(ctx.request.url);
    let username = url.searchParams.get("username") || `Player_${connection.id.slice(0, 4)}`;
    username = username.trim().slice(0, 16);
    if (!username) {
      username = `Player_${connection.id.slice(0, 4)}`;
    }
    
    let color = url.searchParams.get("color") || "#3b82f6";
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      color = "#3b82f6";
    }

    const numericId = this.freeIds.pop() || Math.floor(Math.random() * 255) + 1;

    const newPlayer = {
      id: connection.id,
      numericId,
      username,
      color,
      position: { x: 0, y: 1.5, z: 0 },
      rotation: { y: 0 }
    };
    this.players.set(connection.id, newPlayer);

    connection.send(JSON.stringify({
      type: "init",
      id: connection.id,
      numericId: newPlayer.numericId,
      players: Array.from(this.players.values()),
      blocks: this.blocks
    }));

    this.room.broadcast(
      JSON.stringify({
        type: "player-joined",
        player: newPlayer
      }),
      [connection.id]
    );
  }

  async onMessage(message, sender) {
    try {
      if (typeof message !== "string") {
        const view = new DataView(message);
        const type = view.getUint8(0);
        
        if (type === 0x01) {
          const player = this.players.get(sender.id);
          if (player) {
            const rawX = view.getInt16(1, true);
            const rawY = view.getInt16(3, true);
            const rawZ = view.getInt16(5, true);
            const rawYaw = view.getUint16(7, true);
            
            const x = rawX / 256;
            const y = rawY / 256;
            const z = rawZ / 256;
            const rotY = rawYaw / 65535 * (2 * Math.PI);
            
            player.position = { x, y, z };
            player.rotation = { y: rotY };
            
            const broadcastBuffer = new ArrayBuffer(10);
            const broadcastView = new DataView(broadcastBuffer);
            broadcastView.setUint8(0, 0x02);
            broadcastView.setUint8(1, player.numericId);
            broadcastView.setInt16(2, rawX, true);
            broadcastView.setInt16(4, rawY, true);
            broadcastView.setInt16(6, rawZ, true);
            broadcastView.setUint16(8, rawYaw, true);
            
            this.room.broadcast(broadcastBuffer, [sender.id]);
          }
        } else if (type === 0x03) {
          const packed = view.getUint32(1, true);
          const x = (packed & 0x7F) - 50;
          const y = (packed >> 7) & 0x1F;
          const z = ((packed >> 12) & 0x7F) - 50;
          const materialId = (packed >> 19) & 0x0F;
          
          if (y < 0 || y >= 20 || Math.abs(x) >= 50 || Math.abs(z) >= 50) {
            console.warn(`Block placement out of bounds: ${x},${y},${z}`);
            return;
          }
          
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
          
          const dx = x - player.position.x;
          const dy = y - player.position.y;
          const dz = z - player.position.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > 8.0) {
            console.warn(`Reach check failed for player ${sender.id}: distance ${dist.toFixed(2)}`);
            return;
          }
          
          const materialName = ID_TO_MATERIAL[materialId];
          const key = `${x},${y},${z}`;
          
          let sanitizedBlock = null;
          if (materialName) {
            sanitizedBlock = {
              type: materialName,
              color: ""
            };
          }
          
          this.blocks[key] = sanitizedBlock;
          
          if (this.hasSql) {
            this.dirtyVoxels.set(key, sanitizedBlock);
          } else {
            const chunkKey = getChunkKey(key);
            let chunk = this.chunks[chunkKey];
            if (!chunk) {
              chunk = {};
              this.chunks[chunkKey] = chunk;
            }
            chunk[key] = sanitizedBlock;
            this.dirtyChunks.add(chunkKey);
          }
          
          if (!this.alarmScheduled) {
            this.alarmScheduled = true;
            try {
              await this.room.storage.setAlarm(Date.now() + 2000);
            } catch (err) {
              console.error("Failed to set alarm:", err);
            }
          }

          this.room.broadcast(message);
        }
        return;
      }

      const data = JSON.parse(message);
      
      if (Array.isArray(data)) {
        if (data[0] === 'u') {
          const [_, x, y, z, rotY] = data;
          const player = this.players.get(sender.id);
          if (player) {
            if (typeof x !== 'number' || isNaN(x) || !isFinite(x) ||
                typeof y !== 'number' || isNaN(y) || !isFinite(y) ||
                typeof z !== 'number' || isNaN(z) || !isFinite(z) ||
                typeof rotY !== 'number' || isNaN(rotY) || !isFinite(rotY)) {
              return;
            }
            
            player.position = { x, y, z };
            player.rotation = { y: rotY };
            
            this.room.broadcast(
              JSON.stringify(['u', sender.id, x, y, z, rotY]),
              [sender.id]
            );
          }
        }
        return;
      }

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
            
            this.room.broadcast(
              JSON.stringify(['u', sender.id, x, y, z, rotY]),
              [sender.id]
            );
          }
          break;
        }

        case "block-change": {
          if (!data.change) return;
          const { key, block } = data.change;
          
          if (typeof key !== 'string') return;
          const parts = key.split(",");
          if (parts.length !== 3) return;
          const x = parseInt(parts[0], 10);
          const y = parseInt(parts[1], 10);
          const z = parseInt(parts[2], 10);
          if (isNaN(x) || isNaN(y) || isNaN(z)) return;
          
          if (y < 0 || y >= 20 || Math.abs(x) >= 50 || Math.abs(z) >= 50) {
            console.warn(`Block placement out of bounds: ${key}`);
            return;
          }
          
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
          
          const dx = x - player.position.x;
          const dy = y - player.position.y;
          const dz = z - player.position.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > 8.0) {
            console.warn(`Reach check failed for player ${sender.id}: distance ${dist.toFixed(2)}`);
            return;
          }
          
          let sanitizedBlock = null;
          if (block !== null && typeof block === 'object') {
            if (typeof block.type !== 'string') return;
            const validMaterials = ["grass", "dirt", "wood", "stone", "glass", "neon-red", "neon-blue", "leaves", "flower-red", "flower-yellow"];
            if (!validMaterials.includes(block.type)) return;
            sanitizedBlock = {
              type: block.type,
              color: typeof block.color === 'string' ? block.color : ""
            };
          }
          
          this.blocks[key] = sanitizedBlock;
          
          if (this.hasSql) {
            this.dirtyVoxels.set(key, sanitizedBlock);
          } else {
            const chunkKey = getChunkKey(key);
            let chunk = this.chunks[chunkKey];
            if (!chunk) {
              chunk = {};
              this.chunks[chunkKey] = chunk;
            }
            chunk[key] = sanitizedBlock;
            this.dirtyChunks.add(chunkKey);
          }
          
          if (!this.alarmScheduled) {
            this.alarmScheduled = true;
            try {
              await this.room.storage.setAlarm(Date.now() + 2000);
            } catch (err) {
              console.error("Failed to set alarm:", err);
            }
          }

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
    
    const player = this.players.get(connection.id);
    if (player) {
      this.freeIds.push(player.numericId);
    }

    this.players.delete(connection.id);

    this.room.broadcast(JSON.stringify({
      type: "player-left",
      id: connection.id
    }));

    const connections = Array.from(this.room.getConnections());
    if (connections.length === 0) {
      console.log("Last connection closed. Force flushing dirty data...");
      if (this.alarmScheduled) {
        try {
          await this.room.storage.deleteAlarm();
        } catch (e) {}
        this.alarmScheduled = false;
      }
      if (this.hasSql) {
        await this.flushDirtyVoxels();
      } else {
        await this.flushDirtyChunks();
      }
    }
  }
}
