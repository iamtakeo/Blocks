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

// Deterministic 2D Noise mathematics for terrain surface height calculation on the server
function hash2D(x, z) {
  const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453123;
  return h - Math.floor(h);
}

function smoothInterpolate(a, b, t) {
  const ft = t * Math.PI;
  const f = (1 - Math.cos(ft)) * 0.5;
  return a * (1 - f) + b * f;
}

function valueNoise2D(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  
  const v00 = hash2D(ix, iz);
  const v10 = hash2D(ix + 1, iz);
  const v01 = hash2D(ix, iz + 1);
  const v11 = hash2D(ix + 1, iz + 1);
  
  const i1 = smoothInterpolate(v00, v10, fx);
  const i2 = smoothInterpolate(v01, v11, fx);
  return smoothInterpolate(i1, i2, fz);
}

function fbm3Octaves(x, z) {
  let value = 0;
  let amplitude = 1.0;
  let frequency = 0.04;
  for (let i = 0; i < 3; i++) {
    value += amplitude * valueNoise2D(x * frequency, z * frequency);
    frequency *= 2.0;
    amplitude *= 0.5;
  }
  return value;
}

function getHeight(x, z) {
  const inSpawnSafeZone = Math.abs(x) <= 1 && Math.abs(z + 5) <= 1;
  if (inSpawnSafeZone) return 4;
  const noiseVal = fbm3Octaves(x, z);
  const h = Math.floor(noiseVal * 6.5 + 2.0); // baseline y = 2, max around 13
  return Math.max(1, h);
}

// Calculate exact surface height considering both terrain noise and modifications (placed/deleted blocks)
function getSurfaceHeight(x, z, blocks) {
  const terrainH = getHeight(x, z);
  let highestBlockY = terrainH;
  
  // Scan from top bound (255) down to terrainH + 1 for placed blocks
  for (let tempY = 255; tempY > terrainH; tempY--) {
    const key = `${Math.round(x)},${tempY},${Math.round(z)}`;
    const block = blocks[key];
    if (block !== undefined && block !== null && block.type !== "delete") {
      highestBlockY = tempY;
      break;
    }
  }
  
  // Check if any blocks in the column under highestBlockY are deleted
  while (highestBlockY > 0) {
    const key = `${Math.round(x)},${highestBlockY},${Math.round(z)}`;
    const block = blocks[key];
    if (block === null || (block && block.type === "delete")) {
      highestBlockY--;
    } else {
      break;
    }
  }
  
  return highestBlockY;
}

function findSafeSpawnPosition(blocks) {
  let spawnX = 0;
  let spawnZ = -5;
  let found = false;
  
  for (let radius = 0; radius <= 8 && !found; radius++) {
    for (let dx = -radius; dx <= radius && !found; dx++) {
      for (let dz = -radius; dz <= radius && !found; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        
        const x = 0 + dx;
        const z = -5 + dz;
        
        if (Math.abs(x) >= 49 || Math.abs(z) >= 49) continue;
        
        const terrainH = getHeight(x, z);
        const surfaceH = getSurfaceHeight(x, z, blocks);
        
        if (surfaceH === terrainH) {
          spawnX = x;
          spawnZ = z;
          found = true;
        }
      }
    }
  }
  
  const finalX = spawnX;
  const finalZ = spawnZ;
  const finalY = getSurfaceHeight(finalX, finalZ, blocks) + 2.6;
  
  return { x: finalX, y: finalY, z: finalZ };
}

function isBlockIntersectingAnyPlayer(bx, by, bz, players) {
  for (const player of players.values()) {
    if (!player.position) continue;
    
    const px = player.position.x;
    const py = player.position.y;
    const pz = player.position.z;
    
    const overlapX = (px + 0.3 > bx) && (px - 0.3 < bx + 1);
    const overlapZ = (pz + 0.3 > bz) && (pz - 0.3 < bz + 1);
    const overlapY = (by + 1 > py - 1.6) && (by < py + 0.2);
    
    if (overlapX && overlapY && overlapZ) {
      return true;
    }
  }
  return false;
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

// Deterministic coordinate-seeded tree placement helper
function getTreeSeed(x, z) {
  const h = Math.sin(x * 17.234 + z * 93.123) * 54321.9876;
  return h - Math.floor(h);
}

export default class BlocksServer {
  getBlockId(x, y, z) {
    if (y < 0 || y >= 256) return 0;
    
    const key = `${x},${y},${z}`;
    if (this.blocks[key] !== undefined) {
      const b = this.blocks[key];
      if (b === null || b.type === null || b.type === "delete") return 0;
      return MATERIAL_TO_ID[b.type] || 0;
    }
    
    // Procedural terrain generation
    const size = 24;
    if (x >= -size && x <= size && z >= -size && z <= size) {
      const inSpawnSafeZone = Math.abs(x) <= 1 && Math.abs(z + 5) <= 1;
      if (inSpawnSafeZone && y >= 5 && y <= 19) {
        return 0;
      }
      const h = getHeight(x, z);
      if (y <= h) {
        if (inSpawnSafeZone) {
          if (y === 4) return 5; // glass
          return 4; // stone
        }
        if (y === h) return 1; // grass
        if (y === h - 1) return 2; // dirt
        return 4; // stone
      }
      
      const isNearSpawn = Math.abs(x) < 8 && z >= -12 && z <= 4;
      if (!isNearSpawn) {
        const treeSeed = getTreeSeed(x, z);
        if (treeSeed < 0.015) {
          const trunkH = 4 + Math.floor(treeSeed * 200) % 3;
          if (y > h && y <= h + trunkH) {
            return 3; // wood trunk
          }
          const canopyCenterY = h + trunkH + 1;
          for (let tx = x - 2; tx <= x + 2; tx++) {
            for (let tz = z - 2; tz <= z + 2; tz++) {
              if (tx >= -size && tz >= -size && tx <= size && tz <= size) {
                const nearSpawn = Math.abs(tx) < 8 && tz >= -12 && tz <= 4;
                if (!nearSpawn) {
                  const seed = getTreeSeed(tx, tz);
                  if (seed < 0.015) {
                    const th = 4 + Math.floor(seed * 200) % 3;
                    const cyCenter = getHeight(tx, tz) + th + 1;
                    const lx = x - tx;
                    const ly = y - cyCenter;
                    const lz = z - tz;
                    const distSq = lx*lx + ly*ly + lz*lz;
                    if (distSq <= 6) {
                      if (lx === 0 && lz === 0 && y <= getHeight(tx, tz) + th) {
                        continue;
                      }
                      return 8; // leaves
                    }
                  }
                }
              }
            }
          }
        } else if (treeSeed < 0.06) {
          if (y === h + 1) {
            const isRed = (Math.floor(treeSeed * 1000) % 2 === 0);
            return isRed ? 9 : 10; // flower-red or flower-yellow
          }
        }
      }
    }
    
    return 0; // air
  }

  isPlayerInsideSolidBlock(x, y, z) {
    const inset = 0.05;
    const radiusX = 0.3 - inset;
    const radiusZ = 0.3 - inset;
    const feetOffset = 1.6 - inset;
    const headOffset = 0.2 - inset;

    const minX = x - radiusX;
    const maxX = x + radiusX;
    const minY = y - feetOffset;
    const maxY = y + headOffset;
    const minZ = z - radiusZ;
    const maxZ = z + radiusZ;

    const startX = Math.ceil(minX - 0.5);
    const endX = Math.floor(maxX + 0.5);
    const startY = Math.ceil(minY - 0.5);
    const endY = Math.floor(maxY + 0.5);
    const startZ = Math.ceil(minZ - 0.5);
    const endZ = Math.floor(maxZ + 0.5);

    for (let bx = startX; bx <= endX; bx++) {
      for (let by = startY; by <= endY; by++) {
        for (let bz = startZ; bz <= endZ; bz++) {
          const id = this.getBlockId(bx, by, bz);
          if (id > 0 && id < 9) {
            return true;
          }
        }
      }
    }
    return false;
  }

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
          const inSpawnSafeZone = Math.abs(row.x) <= 1 && Math.abs(row.z + 5) <= 1;
          if (inSpawnSafeZone) {
            continue;
          }
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
            for (const [voxelKey, val] of Object.entries(value)) {
              const [xStr, yStr, zStr] = voxelKey.split(",");
              const x = parseInt(xStr, 10);
              const y = parseInt(yStr, 10);
              const z = parseInt(zStr, 10);
              const inSpawnSafeZone = Math.abs(x) <= 1 && Math.abs(z + 5) <= 1;
              if (inSpawnSafeZone) {
                continue;
              }
              this.blocks[voxelKey] = val;
            }
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
    
    try {
      await this.room.storage.put(batch);
      this.dirtyChunks.clear();
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

    // Dynamically calculate surface starting position with safe spiral negotiation
    const spawnPos = findSafeSpawnPosition(this.blocks);
    const spawnX = spawnPos.x;
    const spawnY = spawnPos.y;
    const spawnZ = spawnPos.z;

    const newPlayer = {
      id: connection.id,
      numericId,
      username,
      color,
      position: null,
      rotation: null
    };
    this.players.set(connection.id, newPlayer);

    connection.send(JSON.stringify({
      type: "init",
      id: connection.id,
      numericId: newPlayer.numericId,
      players: Array.from(this.players.values()),
      blocks: this.blocks,
      spawnPosition: spawnPos
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
            const now = Date.now();
            player.moveTokens = player.moveTokens === undefined ? 10 : player.moveTokens;
            player.lastMoveTime = player.lastMoveTime || now;
            const elapsedMove = now - player.lastMoveTime;
            player.moveTokens = Math.min(10, player.moveTokens + elapsedMove * 0.02);
            player.lastMoveTime = now;
            if (player.moveTokens < 1) return;
            player.moveTokens -= 1;

            const rawX = view.getInt16(1, true);
            const rawY = view.getInt16(3, true);
            const rawZ = view.getInt16(5, true);
            const rawYaw = view.getUint16(7, true);
            
            const x = Math.max(-23.5, Math.min(23.5, rawX / 256));
            const y = Math.max(0.5, Math.min(28.0, rawY / 256));
            const z = Math.max(-23.5, Math.min(23.5, rawZ / 256));
            const rotY = rawYaw / 65535 * (2 * Math.PI);
            
            // Safety checks
            const isUnsafe = y < -5 || this.isPlayerInsideSolidBlock(x, y, z);
            if (isUnsafe) {
              const safe = findSafeSpawnPosition(this.blocks);
              player.position = safe;
              sender.send(JSON.stringify({
                type: "teleport",
                x: safe.x,
                y: safe.y,
                z: safe.z
              }));
              
              const rawSafeX = Math.round(safe.x * 256);
              const rawSafeY = Math.round(safe.y * 256);
              const rawSafeZ = Math.round(safe.z * 256);
              
              const correctedBuffer = new ArrayBuffer(10);
              const correctedView = new DataView(correctedBuffer);
              correctedView.setUint8(0, 0x02);
              correctedView.setUint8(1, player.numericId);
              correctedView.setInt16(2, rawSafeX, true);
              correctedView.setInt16(4, rawSafeY, true);
              correctedView.setInt16(6, rawSafeZ, true);
              correctedView.setUint16(8, rawYaw, true);
              
              this.room.broadcast(correctedBuffer, [sender.id]);
              return;
            }

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
          
          const key = `${x},${y},${z}`;
          const reject = () => {
            sender.send(JSON.stringify({ type: "block-change", key, block: this.blocks[key] || null }));
          };
          
          if (y < 0 || y >= 20 || Math.abs(x) >= 50 || Math.abs(z) >= 50) {
            console.warn(`Block placement out of bounds: ${x},${y},${z}`);
            reject();
            return;
          }
          
          const inSpawnSafeZone = Math.abs(x) <= 1 && Math.abs(z + 5) <= 1;
          if (inSpawnSafeZone) {
            if (y > 4) {
              console.warn(`Binary block placement rejected in spawn safe zone: ${x},${y},${z}`);
              reject();
              return;
            }
            if (y <= 4 && materialId === 0) {
              console.warn(`Binary block deletion rejected in spawn safe zone platform: ${x},${y},${z}`);
              reject();
              return;
            }
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
            reject();
            return;
          }
          player.actionTokens -= 1;
          
          if (!player.position) {
            console.warn(`Reach check failed for player ${sender.id}: unknown position`);
            reject();
            return;
          }

          const dx = x - player.position.x;
          const dy = y - player.position.y;
          const dz = z - player.position.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > 8.0) {
            console.warn(`Reach check failed for player ${sender.id}: distance ${dist.toFixed(2)}`);
            reject();
            return;
          }
          
          if (materialId > 0 && materialId < 9) {
            if (isBlockIntersectingAnyPlayer(x, y, z, this.players)) {
              console.warn(`Block placement rejected for player ${sender.id}: intersects player`);
              reject();
              return;
            }
          }
          
          const materialName = ID_TO_MATERIAL[materialId];
          
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

      const handleParsedMessage = async (data) => {
        if (Array.isArray(data) && data[0] === 'u') {
          if (data.length !== 5) return;
          const [_, rx, ry, rz, rotY] = data;
          const player = this.players.get(sender.id);
          if (player) {
            const now = Date.now();
            player.moveTokens = player.moveTokens === undefined ? 10 : player.moveTokens;
            player.lastMoveTime = player.lastMoveTime || now;
            const elapsedMove = now - player.lastMoveTime;
            player.moveTokens = Math.min(10, player.moveTokens + elapsedMove * 0.02);
            player.lastMoveTime = now;
            if (player.moveTokens < 1) return;
            player.moveTokens -= 1;
            if (typeof rx !== 'number' || isNaN(rx) || !isFinite(rx) ||
                typeof ry !== 'number' || isNaN(ry) || !isFinite(ry) ||
                typeof rz !== 'number' || isNaN(rz) || !isFinite(rz) ||
                typeof rotY !== 'number' || isNaN(rotY) || !isFinite(rotY)) {
              return;
            }
            const x = Math.max(-23.5, Math.min(23.5, rx));
            const y = Math.max(0.5, Math.min(28.0, ry));
            const z = Math.max(-23.5, Math.min(23.5, rz));
            
            // Safety checks
            const isUnsafe = y < -5 || this.isPlayerInsideSolidBlock(x, y, z);
            if (isUnsafe) {
              const safe = findSafeSpawnPosition(this.blocks);
              player.position = safe;
              sender.send(JSON.stringify({
                type: "teleport",
                x: safe.x,
                y: safe.y,
                z: safe.z
              }));
              this.room.broadcast(
                JSON.stringify(['u', sender.id, safe.x, safe.y, safe.z, rotY]),
                [sender.id]
              );
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
            const { x: rx, y: ry, z: rz } = data.position;
            const rotY = data.rotation.y;
            if (typeof rx !== 'number' || isNaN(rx) || !isFinite(rx) ||
                typeof ry !== 'number' || isNaN(ry) || !isFinite(ry) ||
                typeof rz !== 'number' || isNaN(rz) || !isFinite(rz) ||
                typeof rotY !== 'number' || isNaN(rotY) || !isFinite(rotY)) {
              return;
            }
            const x = Math.max(-23.5, Math.min(23.5, rx));
            const y = Math.max(0.5, Math.min(28.0, ry));
            const z = Math.max(-23.5, Math.min(23.5, rz));
            
            // Safety checks
            const isUnsafe = y < -5 || this.isPlayerInsideSolidBlock(x, y, z);
            if (isUnsafe) {
              const safe = findSafeSpawnPosition(this.blocks);
              player.position = safe;
              sender.send(JSON.stringify({
                type: "teleport",
                x: safe.x,
                y: safe.y,
                z: safe.z
              }));
              this.room.broadcast(
                JSON.stringify(['u', sender.id, safe.x, safe.y, safe.z, rotY]),
                [sender.id]
              );
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
          
          const reject = () => {
            sender.send(JSON.stringify({ type: "block-change", key, block: this.blocks[key] || null }));
          };

          if (y < 0 || y >= 20 || Math.abs(x) >= 50 || Math.abs(z) >= 50) {
            console.warn(`Block placement out of bounds: ${key}`);
            reject();
            return;
          }
          
          const inSpawnSafeZone = Math.abs(x) <= 1 && Math.abs(z + 5) <= 1;
          if (inSpawnSafeZone) {
            if (y > 4) {
              console.warn(`Block placement rejected in spawn safe zone: ${key}`);
              reject();
              return;
            }
            if (y <= 4 && block === null) {
              console.warn(`Block deletion rejected in spawn safe zone platform: ${key}`);
              reject();
              return;
            }
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
            reject();
            return;
          }
          player.actionTokens -= 1;
          
          if (!player.position) {
            console.warn(`Reach check failed for player ${sender.id}: unknown position`);
            reject();
            return;
          }

          const dx = x - player.position.x;
          const dy = y - player.position.y;
          const dz = z - player.position.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > 8.0) {
            console.warn(`Reach check failed for player ${sender.id}: distance ${dist.toFixed(2)}`);
            reject();
            return;
          }
          
          if (block !== null && typeof block === 'object') {
            const materialId = MATERIAL_TO_ID[block.type] || 0;
            if (materialId > 0 && materialId < 9) {
              if (isBlockIntersectingAnyPlayer(x, y, z, this.players)) {
                console.warn(`Block placement rejected for player ${sender.id}: intersects player`);
                reject();
                return;
              }
            }
          }
          
          let sanitizedBlock = null;
          if (block !== null && typeof block === 'object') {
            if (typeof block.type !== 'string') return;
            const validMaterials = ["grass", "dirt", "wood", "stone", "glass", "neon-red", "neon-blue", "leaves", "flower-red", "flower-yellow"];
            if (!validMaterials.includes(block.type)) return;
            sanitizedBlock = {
              type: block.type,
              color: typeof block.color === 'string' ? block.color.slice(0, 15) : ""
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
      };

      if (Array.isArray(data)) {
        if (typeof data[0] === 'string' && data[0] === 'u') {
          await handleParsedMessage(data);
        } else {
          for (const msg of data) {
            await handleParsedMessage(msg);
          }
        }
        return;
      }
      
      await handleParsedMessage(data);
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
