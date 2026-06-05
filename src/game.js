import {
  Engine,
  Scene,
  Vector3,
  HemisphericLight,
  DirectionalLight,
  Color3,
  UniversalCamera,
  MeshBuilder,
  StandardMaterial,
  Material,
  DynamicTexture,
  Mesh,
  TransformNode,
  Ray,
  PointerEventTypes,
  ShadowGenerator,
  PointLight,
  VertexData
} from "@babylonjs/core";
import { Vector3Pool } from "./pool.js";

// Polyfill Vector3.HermiteToRef since it is not defined in BabylonJS
if (!Vector3.HermiteToRef) {
  Vector3.HermiteToRef = function(value1, tangent1, value2, tangent2, amount, result) {
    const s = amount;
    const s2 = s * s;
    const s3 = s2 * s;
    
    const h1 = 2.0 * s3 - 3.0 * s2 + 1.0;
    const h2 = -2.0 * s3 + 3.0 * s2;
    const h3 = s3 - 2.0 * s2 + s;
    const h4 = s3 - s2;
    
    result.x = value1.x * h1 + value2.x * h2 + tangent1.x * h3 + tangent2.x * h4;
    result.y = value1.y * h1 + value2.y * h2 + tangent1.y * h3 + tangent2.y * h4;
    result.z = value1.z * h1 + value2.z * h2 + tangent1.z * h3 + tangent2.z * h4;
    return result;
  };
}

// Seedable 2D Hash
function hash2D(x, z) {
  const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453123;
  return h - Math.floor(h);
}

// Linear interpolation with smoothstep-like curve
function smoothInterpolate(a, b, t) {
  const ft = t * Math.PI;
  const f = (1 - Math.cos(ft)) * 0.5;
  return a * (1 - f) + b * f;
}

// 2D Value Noise
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

// 3-octave Fractional Brownian Motion (fBm)
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

// Deterministic coordinate-seeded tree placement helper
function getTreeSeed(x, z) {
  const h = Math.sin(x * 17.234 + z * 93.123) * 54321.9876;
  return h - Math.floor(h);
}

// Material mapping constants
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

const CHUNK_SIZE = 16;
const CHUNK_SIZE_SQ = 256;
const PADDED_SIZE = 18;
const PADDED_SIZE_SQ = 324;
const MASK_BUFFER = new Int16Array(CHUNK_SIZE_SQ);
const PADDED_BUFFER = new Uint8Array(5832);

const _displacement = new Vector3();
const _currentPos = new Vector3();
const _resolvedPos = new Vector3();
const _fogColorCave = new Color3(0.01, 0.02, 0.05);
const _fogColorSky = Color3.FromHexString("#bae6fd");
const _clearColorCave = new Color3(0.01, 0.02, 0.05);
const _clearColorSky = Color3.FromHexString("#bae6fd");
const _scratchRay = new Ray(Vector3.Zero(), Vector3.Zero(), 1);
const _safeSpawnPos = new Vector3();
const _interpolateTangent1 = new Vector3();
const _interpolateTangent2 = new Vector3();

class OptimizedChunkMesher {
  constructor() {
    this.mask = MASK_BUFFER;
  }

  static getPaddedIndex(x, y, z) {
    return x + y * PADDED_SIZE + z * PADDED_SIZE_SQ;
  }

  meshChunk(paddedVoxelArray) {
    const meshesData = new Map();

    for (let d = 0; d < 3; d++) {
      const u = (d + 1) % 3;
      const v = (d + 2) % 3;

      const x = [0, 0, 0];
      const q = [0, 0, 0];
      q[d] = 1;

      for (x[d] = 0; x[d] <= CHUNK_SIZE; ) {
        let maskIdx = 0;

        for (x[v] = 1; x[v] <= CHUNK_SIZE; x[v]++) {
          for (x[u] = 1; x[u] <= CHUNK_SIZE; x[u]++) {
            const idxA = OptimizedChunkMesher.getPaddedIndex(
              x[0],
              x[1],
              x[2]
            );
            const idxB = OptimizedChunkMesher.getPaddedIndex(
              x[0] + q[0],
              x[1] + q[1],
              x[2] + q[2]
            );

            const idA = paddedVoxelArray[idxA];
            const idB = paddedVoxelArray[idxB];

            // Filter out flowers (ID 9, 10) from greedy meshing
            const typeA = (idA > 0 && idA < 9) ? idA : 0;
            const typeB = (idB > 0 && idB < 9) ? idB : 0;

            if (typeA === typeB) {
              this.mask[maskIdx++] = 0;
            } else {
              const isTransA = typeA === 0 || typeA === 5;
              const isTransB = typeB === 0 || typeB === 5;

              if (typeA > 0 && isTransB && x[d] > 0) {
                this.mask[maskIdx++] = typeA;
              } else if (typeB > 0 && isTransA && x[d] < CHUNK_SIZE) {
                this.mask[maskIdx++] = -typeB;
              } else {
                this.mask[maskIdx++] = 0;
              }
            }
          }
        }

        x[d]++;

        maskIdx = 0;
        for (let j = 0; j < CHUNK_SIZE; j++) {
          for (let i = 0; i < CHUNK_SIZE; ) {
            const maskVal = this.mask[maskIdx];

            if (maskVal !== 0) {
              const val = Math.abs(maskVal);
              const isFrontFace = maskVal > 0;
              let w = 1;

              while (i + w < CHUNK_SIZE && this.mask[maskIdx + w] === maskVal) {
                w++;
              }

              let h = 1;
              let heightDone = false;
              while (j + h < CHUNK_SIZE) {
                for (let k = 0; k < w; k++) {
                  if (this.mask[maskIdx + k + h * CHUNK_SIZE] !== maskVal) {
                    heightDone = true;
                    break;
                  }
                }
                if (heightDone) break;
                h++;
              }

              if (!meshesData.has(val)) {
                meshesData.set(val, {
                  positions: [],
                  indices: [],
                  normals: [],
                  uvs: []
                });
              }
              const geo = meshesData.get(val);
              const startIdx = geo.positions.length / 3;

              const c1 = [0, 0, 0];
              c1[d] = x[d]; c1[u] = i; c1[v] = j;

              const c2 = [0, 0, 0];
              c2[d] = x[d]; c2[u] = i + w; c2[v] = j;

              const c3 = [0, 0, 0];
              c3[d] = x[d]; c3[u] = i + w; c3[v] = j + h;

              const c4 = [0, 0, 0];
              c4[d] = x[d]; c4[u] = i; c4[v] = j + h;

              geo.positions.push(
                c1[0], c1[1], c1[2],
                c2[0], c2[1], c2[2],
                c3[0], c3[1], c3[2],
                c4[0], c4[1], c4[2]
              );

              const normX = q[0] * (isFrontFace ? 1 : -1);
              const normY = q[1] * (isFrontFace ? 1 : -1);
              const normZ = q[2] * (isFrontFace ? 1 : -1);
              geo.normals.push(
                normX, normY, normZ,
                normX, normY, normZ,
                normX, normY, normZ,
                normX, normY, normZ
              );

              if (d === 0) {
                geo.uvs.push(
                  0, 0,
                  0, w,
                  h, w,
                  h, 0
                );
              } else {
                geo.uvs.push(
                  0, 0,
                  w, 0,
                  w, h,
                  0, h
                );
              }

              const usePatternA = (d === 1) !== isFrontFace;
              if (usePatternA) {
                geo.indices.push(
                  startIdx, startIdx + 1, startIdx + 2,
                  startIdx, startIdx + 2, startIdx + 3
                );
              } else {
                geo.indices.push(
                  startIdx, startIdx + 2, startIdx + 1,
                  startIdx, startIdx + 3, startIdx + 2
                );
              }

              for (let yOffset = 0; yOffset < h; yOffset++) {
                for (let xOffset = 0; xOffset < w; xOffset++) {
                  this.mask[maskIdx + xOffset + yOffset * CHUNK_SIZE] = 0;
                }
              }

              i += w;
              maskIdx += w;
            } else {
              i++;
              maskIdx++;
            }
          }
        }
      }
    }

    return meshesData;
  }
}

export class Game {
  constructor(canvasId, onBlockChange, audioSynth) {
    this.canvas = document.getElementById(canvasId);
    this.onBlockChange = onBlockChange; // callback(x, y, z, materialName | null)
    this.audioSynth = audioSynth;
    
    // Core engine & scene
    this.engine = new Engine(this.canvas, true, {
      preserveDrawingBuffer: true,
      adaptToDeviceRatio: true,
      limitDeviceRatio: 2.0
    });
    this.scene = new Scene(this.engine);
    
    // Configs & Chunk Storage
    this.activeMaterial = "grass";
    this.chunks = new Map(); // chunkKey ("cx,cy,cz") -> Uint8Array(4096)
    this.chunkMeshes = new Map(); // chunkKey ("cx,cy,cz") -> Map of materialName -> Mesh
    this.flowerInstances = new Map(); // key ("x,y,z") -> InstancedMesh
    this.otherPlayers = new Map(); // id -> { root, body, head, label }
    this.chunkMesher = new OptimizedChunkMesher();
    
    // Kinematic physics state
    this.verticalVelocity = 0.0;
    this._spaceReleased = true;
    this.lastCamGridX = null;
    this.lastCamGridZ = null;
    this._isBulkLoading = false;
    this.isWorldLoaded = false;
    this.instanceId = Math.random().toString(36).substring(2, 9);
    
    const loadingOverlay = document.getElementById("loadingOverlay");
    if (loadingOverlay) {
      loadingOverlay.classList.remove("hidden");
    }

    this.initScene();
    this.initLights();
    this.initSkyDome();
    this.initGround();
    this.initMaterials();
    this.initPlayerCamera();
    this.initHighlight();
    this.initInteraction();
    
    // Handle window resize with requestAnimationFrame debouncing
    let resizePending = false;
    this._resizeHandler = () => {
      if (!resizePending) {
        resizePending = true;
        requestAnimationFrame(() => {
          this.engine.resize();
          resizePending = false;
        });
      }
    };
    window.addEventListener("resize", this._resizeHandler);

    // Start rendering loop
    this.engine.runRenderLoop(() => {
      this.scene.render();
    });
  }

  getHeight(x, z) {
    const inSpawnSafeZone = Math.abs(x) <= 1 && Math.abs(z + 5) <= 1;
    if (inSpawnSafeZone) return 4;
    const noiseVal = fbm3Octaves(x, z);
    const h = Math.floor(noiseVal * 6.5 + 2.0); // baseline y = 2, max around 13
    return Math.max(1, h);
  }

  initScene() {
    // Enable collisions
    this.scene.collisionsEnabled = true;
    
    // Enable linear distance fog matching the horizon
    this.scene.fogEnabled = true;
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogColor = Color3.FromHexString("#bae6fd");
    this.scene.fogStart = 35;
    this.scene.fogEnd = 85;
    
    // Set clearColor to match horizon fog
    this.scene.clearColor = Color3.FromHexString("#bae6fd");
  }

  initLights() {
    // Ambient soft lighting
    const hemiLight = new HemisphericLight("hemiLight", new Vector3(0, 1, 0), this.scene);
    hemiLight.intensity = 0.55;
    hemiLight.diffuse = new Color3(0.9, 0.95, 1.0);
    hemiLight.specular = new Color3(0.1, 0.1, 0.1);
    hemiLight.groundColor = new Color3(0.25, 0.28, 0.24); // soft grass-green bounced light for block undersides
    
    // Sun light (casting sharp definitions)
    const dirLight = new DirectionalLight("dirLight", new Vector3(-1, -2, -1), this.scene);
    dirLight.position = new Vector3(20, 40, 20);
    dirLight.intensity = 0.45;
    dirLight.diffuse = new Color3(1.0, 0.96, 0.9);
    
    // Player flashlight (PointLight parented to camera inside initPlayerCamera)
    this.flashlight = new PointLight("flashlight", new Vector3(0, 0, 0), this.scene);
    this.flashlight.intensity = 0.0; // Starts turned off
    this.flashlight.range = 25;
    this.flashlight.diffuse = new Color3(1.0, 0.98, 0.85);
    
    // Soft PCF Shadows setup
    this.shadowGenerator = new ShadowGenerator(1024, dirLight);
    this.shadowGenerator.usePercentageCloserFiltering = true;
    this.shadowGenerator.filteringQuality = ShadowGenerator.QUALITY_HIGH;
  }

  initSkyDome() {
    // Create sky dome sphere (diameter 200 fits within maxZ culling range)
    this.skySphere = MeshBuilder.CreateSphere("skySphere", {
      segments: 24,
      diameter: 200,
      sideOrientation: Mesh.BACKSIDE // Reverse normals to face inward
    }, this.scene);
    
    this.skySphere.infiniteDistance = true; // Lock position to player camera
    this.skySphere.isPickable = false;

    // Ultra-lightweight dynamic gradient texture (2 x 512 pixels, no mipmaps, under 1 KB VRAM)
    const skyTex = new DynamicTexture("skyTex", { width: 2, height: 512 }, this.scene, false);
    const ctx = skyTex.getContext();
    
    // Create vertical gradient matching horizon stops to the equator
    const grad = ctx.createLinearGradient(0, 512, 0, 0);
    grad.addColorStop(0.0, "#bae6fd"); // Bottom pole / nadir (horizon sky blue)
    grad.addColorStop(0.5, "#bae6fd"); // Equator / horizon (horizon sky blue)
    grad.addColorStop(1.0, "#0284c7"); // Top pole / zenith (deep day blue)
    
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 2, 512);
    skyTex.update();

    // wrapU = 1 (WRAP_ADDRESSMODE) to prevent vertical seam line, wrapV = 0 (CLAMP) to prevent poles bleeding
    skyTex.wrapU = 1; 
    skyTex.wrapV = 0; 

    // Create sky standard material
    const skyMat = new StandardMaterial("skyMat", this.scene);
    skyMat.diffuseTexture = skyTex;
    skyMat.specularColor = new Color3(0, 0, 0);
    skyMat.emissiveColor = new Color3(1, 1, 1); // self-illuminating
    skyMat.disableLighting = true;
    skyMat.fogEnabled = false;
    skyMat.backFaceCulling = true; // Enabled since sideOrientation handles inward normals
    skyMat.disableDepthWrite = true; // Ensure sky is always behind all objects

    this.skySphere.material = skyMat;
  }

  initGround() {
    // Create a large flat ground plane just below block coordinate zero (y = -0.5)
    this.ground = MeshBuilder.CreateGround("ground", { width: 100, height: 100 }, this.scene);
    this.ground.position.y = -0.5;
    this.ground.checkCollisions = true;
    this.ground.receiveShadows = true;

    // Create a dynamic grid texture for the ground
    const gridTex = new DynamicTexture("gridTex", 256, this.scene, true);
    const ctx = gridTex.getContext();
    ctx.fillStyle = "#090d16"; // Dark slate
    ctx.fillRect(0, 0, 256, 256);
    
    // Grid lines
    ctx.strokeStyle = "rgba(139, 92, 246, 0.25)"; // Glowing purple/indigo grid lines
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, 256, 256);
    gridTex.update();
    
    gridTex.uScale = 100;
    gridTex.vScale = 100;

    const groundMat = new StandardMaterial("groundMat", this.scene);
    groundMat.diffuseTexture = gridTex;
    groundMat.specularColor = new Color3(0, 0, 0);
    this.ground.material = groundMat;
  }

  createVoxelTexture(fillColor, borderColor, materialName) {
    const tex = new DynamicTexture("voxelTex_" + materialName, 64, this.scene, true);
    const ctx = tex.getContext();
    
    if (fillColor === "transparent") {
      ctx.clearRect(0, 0, 64, 64);
    } else {
      ctx.fillStyle = fillColor;
      ctx.fillRect(0, 0, 64, 64);
    }
    
    // Seedable LCG for detailed micro-textures
    let seed = 12345;
    if (materialName === "grass") seed = 98234;
    else if (materialName === "dirt") seed = 12983;
    else if (materialName === "wood") seed = 76543;
    else if (materialName === "stone") seed = 45612;
    else if (materialName === "glass") seed = 88123;
    else if (materialName === "neon-red") seed = 55432;
    else if (materialName === "neon-blue") seed = 22345;
    else if (materialName === "leaves") seed = 34567;
    
    const lcg = {
      seed: seed,
      next: function() {
        this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
        return this.seed / 4294967296;
      }
    };
    
    if (materialName === "grass") {
      // Draw green blades of grass/spots
      for (let i = 0; i < 60; i++) {
        const gx = Math.floor(lcg.next() * 64);
        const gy = Math.floor(lcg.next() * 64);
        const length = 2 + Math.floor(lcg.next() * 5);
        ctx.fillStyle = lcg.next() > 0.5 ? "#059669" : "#34d399";
        ctx.fillRect(gx, gy, 2, length);
      }
    } else if (materialName === "dirt") {
      // Grains/pebbles
      for (let i = 0; i < 80; i++) {
        const gx = Math.floor(lcg.next() * 64);
        const gy = Math.floor(lcg.next() * 64);
        ctx.fillStyle = lcg.next() > 0.5 ? "#5c2d10" : "#92400e";
        ctx.fillRect(gx, gy, 2 + Math.floor(lcg.next() * 2), 2 + Math.floor(lcg.next() * 2));
      }
    } else if (materialName === "wood") {
      // Wood grain lines
      ctx.strokeStyle = "#92400e";
      ctx.lineWidth = 2;
      for (let i = 0; i < 15; i++) {
        const gy = Math.floor(lcg.next() * 64);
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(64, gy + (lcg.next() * 6 - 3));
        ctx.stroke();
      }
    } else if (materialName === "stone") {
      // Granite flecks/cracks
      for (let i = 0; i < 100; i++) {
        const gx = Math.floor(lcg.next() * 64);
        const gy = Math.floor(lcg.next() * 64);
        ctx.fillStyle = lcg.next() > 0.5 ? "#374151" : "#6b7280";
        ctx.fillRect(gx, gy, 1 + Math.floor(lcg.next() * 2), 1 + Math.floor(lcg.next() * 2));
      }
      ctx.strokeStyle = "#1f2937";
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(lcg.next() * 64, lcg.next() * 64);
        ctx.lineTo(lcg.next() * 64, lcg.next() * 64);
        ctx.stroke();
      }
    } else if (materialName === "glass") {
      // Draw diagonal shine reflection
      ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(35, 0);
      ctx.lineTo(0, 35);
      ctx.lineTo(0, 10);
      ctx.closePath();
      ctx.fill();
      
      ctx.beginPath();
      ctx.moveTo(40, 0);
      ctx.lineTo(55, 0);
      ctx.lineTo(0, 55);
      ctx.lineTo(0, 40);
      ctx.closePath();
      ctx.fill();
    } else if (materialName === "leaves") {
      // Green leaf micro-details
      for (let i = 0; i < 70; i++) {
        const gx = Math.floor(lcg.next() * 64);
        const gy = Math.floor(lcg.next() * 64);
        ctx.fillStyle = lcg.next() > 0.5 ? "#14532d" : "#22c55e";
        ctx.fillRect(gx, gy, 2 + Math.floor(lcg.next() * 2), 2 + Math.floor(lcg.next() * 2));
      }
    } else if (materialName === "neon-red" || materialName === "neon-blue") {
      // Glow details/circuits
      ctx.strokeStyle = materialName === "neon-red" ? "#fda4af" : "#67e8f9";
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const x1 = Math.floor(lcg.next() * 8) * 8;
        const y1 = Math.floor(lcg.next() * 8) * 8;
        const len = 16 + Math.floor(lcg.next() * 3) * 8;
        const dir = lcg.next() > 0.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        if (dir) {
          ctx.lineTo(x1 + len, y1);
        } else {
          ctx.lineTo(x1, y1 + len);
        }
        ctx.stroke();
      }
    } else if (materialName.startsWith("flower")) {
      // Draw flower stems and petals
      ctx.fillStyle = "#16803d";
      ctx.fillRect(30, 24, 4, 40);
      
      ctx.fillStyle = materialName === "flower-red" ? "#f43f5e" : "#fbbf24";
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const angle = (i * 2 * Math.PI) / 5;
        const px = 32 + Math.cos(angle) * 10;
        const py = 20 + Math.sin(angle) * 10;
        ctx.arc(px, py, 6, 0, 2 * Math.PI);
      }
      ctx.fill();
      
      ctx.fillStyle = "#1e293b";
      ctx.beginPath();
      ctx.arc(32, 20, 4, 0, 2 * Math.PI);
      ctx.fill();
    }
    
    if (!materialName.startsWith("flower")) {
      // Draw border outline
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 4;
      ctx.strokeRect(2, 2, 60, 60);
      
      // Draw top/left bevel highlights
      // Top highlight (white, semi-transparent)
      ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(2, 2);
      ctx.lineTo(62, 2);
      ctx.stroke();
      
      // Left highlight (white, semi-transparent)
      ctx.beginPath();
      ctx.moveTo(2, 2);
      ctx.lineTo(2, 62);
      ctx.stroke();
      
      // Bottom shadow (black, semi-transparent)
      ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
      ctx.beginPath();
      ctx.moveTo(2, 62);
      ctx.lineTo(62, 62);
      ctx.stroke();
      
      // Right shadow (black, semi-transparent)
      ctx.beginPath();
      ctx.moveTo(62, 2);
      ctx.lineTo(62, 62);
      ctx.stroke();
    }
    
    tex.update();
    return tex;
  }

  initMaterials() {
    this.materials = {};

    // 1. Grass
    const grass = new StandardMaterial("mat_grass", this.scene);
    grass.diffuseTexture = this.createVoxelTexture("#10b981", "#047857", "grass");
    grass.specularColor = new Color3(0.05, 0.05, 0.05);
    this.materials["grass"] = grass;

    // 2. Dirt
    const dirt = new StandardMaterial("mat_dirt", this.scene);
    dirt.diffuseTexture = this.createVoxelTexture("#78350f", "#451a03", "dirt");
    dirt.specularColor = new Color3(0, 0, 0);
    this.materials["dirt"] = dirt;

    // 3. Wood
    const wood = new StandardMaterial("mat_wood", this.scene);
    wood.diffuseTexture = this.createVoxelTexture("#d97706", "#92400e", "wood");
    wood.specularColor = new Color3(0.05, 0.05, 0.05);
    this.materials["wood"] = wood;

    // 4. Stone
    const stone = new StandardMaterial("mat_stone", this.scene);
    stone.diffuseTexture = this.createVoxelTexture("#4b5563", "#1f2937", "stone");
    stone.specularColor = new Color3(0.1, 0.1, 0.1);
    this.materials["stone"] = stone;

    // 5. Glass
    const glass = new StandardMaterial("mat_glass", this.scene);
    glass.diffuseTexture = this.createVoxelTexture("rgba(186, 230, 253, 0.5)", "rgba(56, 189, 248, 0.8)", "glass");
    glass.alpha = 0.45;
    glass.specularColor = new Color3(0.5, 0.5, 0.5);
    glass.backFaceCulling = false;
    glass.twoSidedLighting = true;
    glass.separateCullingPass = true;
    this.materials["glass"] = glass;

    // 6. Neon Red
    const neonRed = new StandardMaterial("mat_neon_red", this.scene);
    neonRed.diffuseTexture = this.createVoxelTexture("#f43f5e", "#be123c", "neon-red");
    neonRed.emissiveColor = new Color3(0.8, 0.15, 0.25);
    neonRed.specularColor = new Color3(0.1, 0.1, 0.1);
    this.materials["neon-red"] = neonRed;

    // 7. Neon Blue
    const neonBlue = new StandardMaterial("mat_neon_blue", this.scene);
    neonBlue.diffuseTexture = this.createVoxelTexture("#06b6d4", "#0891b2", "neon-blue");
    neonBlue.emissiveColor = new Color3(0.01, 0.45, 0.6);
    neonBlue.specularColor = new Color3(0.1, 0.1, 0.1);
    this.materials["neon-blue"] = neonBlue;

    // 8. Leaves
    const leaves = new StandardMaterial("mat_leaves", this.scene);
    leaves.diffuseTexture = this.createVoxelTexture("#15803d", "#14532d", "leaves");
    leaves.specularColor = new Color3(0.05, 0.05, 0.05);
    this.materials["leaves"] = leaves;

    // 9. Flower Red
    const flowerRed = new StandardMaterial("mat_flower-red", this.scene);
    flowerRed.diffuseTexture = this.createVoxelTexture("transparent", "#f43f5e", "flower-red");
    flowerRed.diffuseTexture.hasAlpha = true;
    flowerRed.useAlphaFromDiffuseTexture = true;
    flowerRed.transparencyMode = Material.MATERIAL_ALPHATEST;
    flowerRed.backFaceCulling = false;
    flowerRed.twoSidedLighting = true;
    flowerRed.specularColor = new Color3(0, 0, 0);
    this.materials["flower-red"] = flowerRed;

    // 10. Flower Yellow
    const flowerYellow = new StandardMaterial("mat_flower-yellow", this.scene);
    flowerYellow.diffuseTexture = this.createVoxelTexture("transparent", "#fbbf24", "flower-yellow");
    flowerYellow.diffuseTexture.hasAlpha = true;
    flowerYellow.useAlphaFromDiffuseTexture = true;
    flowerYellow.transparencyMode = Material.MATERIAL_ALPHATEST;
    flowerYellow.backFaceCulling = false;
    flowerYellow.twoSidedLighting = true;
    flowerYellow.specularColor = new Color3(0, 0, 0);
    this.materials["flower-yellow"] = flowerYellow;

    // Create hidden base template meshes for instancing
    this.templateMeshes = {};
    for (const [name, mat] of Object.entries(this.materials)) {
      const template = MeshBuilder.CreateBox("template_" + name, { size: 1.0 }, this.scene);
      template.material = mat;
      template.isVisible = false;
      template.isPickable = false;
      template.checkCollisions = false;
      
      if (this.shadowGenerator) {
        this.shadowGenerator.addShadowCaster(template, true);
      }
      template.receiveShadows = true;
      
      this.templateMeshes[name] = template;
    }
  }

  getBlockId(x, y, z) {
    if (y < 0 || y >= 256) return 0;
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    const cz = Math.floor(z / 16);
    const chunkKey = `${cx},${cy},${cz}`;
    const chunk = this.chunks.get(chunkKey);
    if (!chunk) return 0;
    const lx = ((x % 16) + 16) % 16;
    const ly = ((y % 16) + 16) % 16;
    const lz = ((z % 16) + 16) % 16;
    return chunk[lx | (lz << 4) | (ly << 8)];
  }

  setBlockId(x, y, z, id) {
    if (y < 0 || y >= 256) return;
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    const cz = Math.floor(z / 16);
    const chunkKey = `${cx},${cy},${cz}`;
    let chunk = this.chunks.get(chunkKey);
    if (!chunk) {
      if (id === 0) return;
      chunk = new Uint8Array(4096);
      this.chunks.set(chunkKey, chunk);
    }
    const lx = ((x % 16) + 16) % 16;
    const ly = ((y % 16) + 16) % 16;
    const lz = ((z % 16) + 16) % 16;
    chunk[lx | (lz << 4) | (ly << 8)] = id;

    if (id === 0) {
      let isEmpty = true;
      for (let i = 0; i < 4096; i++) {
        if (chunk[i] > 0) {
          isEmpty = false;
          break;
        }
      }
      if (isEmpty) {
        this.chunks.delete(chunkKey);
      }
    }
  }

  getPaddedChunkArray(cx, cy, cz) {
    const padded = PADDED_BUFFER;
    padded.fill(0);
    
    for (let dcx = -1; dcx <= 1; dcx++) {
      for (let dcy = -1; dcy <= 1; dcy++) {
        for (let dcz = -1; dcz <= 1; dcz++) {
          const ncx = cx + dcx;
          const ncy = cy + dcy;
          const ncz = cz + dcz;
          const chunkKey = `${ncx},${ncy},${ncz}`;
          const chunk = this.chunks.get(chunkKey);
          if (!chunk) continue;
          
          const startWx = Math.max(cx * 16 - 1, ncx * 16);
          const endWx = Math.min(cx * 16 + 16, ncx * 16 + 15);
          
          const startWy = Math.max(cy * 16 - 1, ncy * 16);
          const endWy = Math.min(cy * 16 + 16, ncy * 16 + 15);
          
          const startWz = Math.max(cz * 16 - 1, ncz * 16);
          const endWz = Math.min(cz * 16 + 16, ncz * 16 + 15);
          
          if (startWx <= endWx && startWy <= endWy && startWz <= endWz) {
            for (let wx = startWx; wx <= endWx; wx++) {
              const px = wx - cx * 16 + 1;
              const nlx = wx - ncx * 16;
              for (let wz = startWz; wz <= endWz; wz++) {
                const pz = wz - cz * 16 + 1;
                const nlz = wz - ncz * 16;
                
                for (let wy = startWy; wy <= endWy; wy++) {
                  const py = wy - cy * 16 + 1;
                  const nly = wy - ncy * 16;
                  
                  const paddedIdx = px + py * 18 + pz * 324;
                  const chunkIdx = nlx | (nlz << 4) | (nly << 8);
                  padded[paddedIdx] = chunk[chunkIdx];
                }
              }
            }
          }
        }
      }
    }
    return padded;
  }

  rebuildChunkMesh(cx, cy, cz) {
    const chunkKey = `${cx},${cy},${cz}`;
    const padded = this.getPaddedChunkArray(cx, cy, cz);
    const meshesData = this.chunkMesher.meshChunk(padded);
    
    let chunkMeshesMap = this.chunkMeshes.get(chunkKey);
    if (!chunkMeshesMap) {
      chunkMeshesMap = new Map();
      this.chunkMeshes.set(chunkKey, chunkMeshesMap);
    }
    
    for (let id = 1; id <= 8; id++) {
      const matName = ID_TO_MATERIAL[id];
      const data = meshesData.get(id);
      let mesh = chunkMeshesMap.get(matName);
      
      if (!data || data.positions.length === 0) {
        if (mesh) {
          mesh.dispose();
          chunkMeshesMap.delete(matName);
        }
        continue;
      }
      
      if (!mesh) {
        mesh = new Mesh(`chunk_${chunkKey}_${matName}`, this.scene);
        mesh.material = this.materials[matName];
        mesh.position.set(cx * 16, cy * 16, cz * 16);
        mesh.checkCollisions = false;
        
        if (this.shadowGenerator) {
          this.shadowGenerator.addShadowCaster(mesh, true);
        }
        mesh.receiveShadows = true;
        
        chunkMeshesMap.set(matName, mesh);
      } else {
        mesh.unfreezeWorldMatrix();
      }
      
      const vertexData = new VertexData();
      vertexData.positions = data.positions;
      vertexData.indices = data.indices;
      vertexData.normals = data.normals;
      vertexData.uvs = data.uvs;
      
      vertexData.applyToMesh(mesh, true);
      mesh.computeWorldMatrix(true);
      mesh.freezeWorldMatrix();
    }
    
    for (const [matName, mesh] of chunkMeshesMap.entries()) {
      const id = MATERIAL_TO_ID[matName];
      if (!meshesData.has(id)) {
        mesh.dispose();
        chunkMeshesMap.delete(matName);
      }
    }
  }

  rebuildChunkAndNeighbors(x, y, z) {
    const cx = Math.floor(x / 16);
    const cy = Math.floor(y / 16);
    const cz = Math.floor(z / 16);
    
    this.rebuildChunkMesh(cx, cy, cz);
    
    const lx = ((x % 16) + 16) % 16;
    const ly = ((y % 16) + 16) % 16;
    const lz = ((z % 16) + 16) % 16;
    
    if (lx === 0) this.rebuildChunkMesh(cx - 1, cy, cz);
    if (lx === 15) this.rebuildChunkMesh(cx + 1, cy, cz);
    if (ly === 0) this.rebuildChunkMesh(cx, cy - 1, cz);
    if (ly === 15) this.rebuildChunkMesh(cx, cy + 1, cz);
    if (lz === 0) this.rebuildChunkMesh(cx, cy, cz - 1);
    if (lz === 15) this.rebuildChunkMesh(cx, cy, cz + 1);
  }

  ddaRaycast(origin, direction, maxDistance) {
    const startX = Math.floor(origin.x);
    const startY = Math.floor(origin.y);
    const startZ = Math.floor(origin.z);

    let x = startX;
    let y = startY;
    let z = startZ;

    const dx = direction.x;
    const dy = direction.y;
    const dz = direction.z;

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;

    const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
    const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);

    let tMaxX = dx === 0 ? Infinity : (dx > 0 ? (x + 1 - origin.x) * tDeltaX : (origin.x - x) * tDeltaX);
    let tMaxY = dy === 0 ? Infinity : (dy > 0 ? (y + 1 - origin.y) * tDeltaY : (origin.y - y) * tDeltaY);
    let tMaxZ = dz === 0 ? Infinity : (dz > 0 ? (z + 1 - origin.z) * tDeltaZ : (origin.z - z) * tDeltaZ);

    let t = 0;
    let hitNormalX = 0;
    let hitNormalY = 0;
    let hitNormalZ = 0;

    let steps = 0;
    const maxSteps = 100;

    while (t < maxDistance && steps < maxSteps) {
      steps++;
      const id = this.getBlockId(x, y, z);
      if (id > 0) {
        return {
          hit: true,
          x, y, z,
          distance: t,
          normalX: hitNormalX,
          normalY: hitNormalY,
          normalZ: hitNormalZ,
          materialId: id
        };
      }

      if (y < 0) {
        return {
          hit: true,
          x, y: -1, z,
          distance: t,
          normalX: 0,
          normalY: 1,
          normalZ: 0,
          isGround: true
        };
      }

      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          t = tMaxX;
          x += stepX;
          tMaxX += tDeltaX;
          hitNormalX = -stepX;
          hitNormalY = 0;
          hitNormalZ = 0;
        } else {
          t = tMaxZ;
          z += stepZ;
          tMaxZ += tDeltaZ;
          hitNormalX = 0;
          hitNormalY = 0;
          hitNormalZ = -stepZ;
        }
      } else {
        if (tMaxY < tMaxZ) {
          t = tMaxY;
          y += stepY;
          tMaxY += tDeltaY;
          hitNormalX = 0;
          hitNormalY = -stepY;
          hitNormalZ = 0;
        } else {
          t = tMaxZ;
          z += stepZ;
          tMaxZ += tDeltaZ;
          hitNormalX = 0;
          hitNormalY = 0;
          hitNormalZ = -stepZ;
        }
      }
    }

    return { hit: false };
  }

  checkCollisionCustom(cx, cy, cz) {
    const radiusX = 0.3;
    const radiusZ = 0.3;
    const feetOffset = 1.6;
    const headOffset = 0.2;
    const groundY = -0.5;
    const epsilon = 0.01; // 1cm margin to prevent float errors and floor boundary touches

    const minX = cx - radiusX + epsilon;
    const maxX = cx + radiusX - epsilon;
    const minY = cy - feetOffset + epsilon;
    const maxY = cy + headOffset - epsilon;
    const minZ = cz - radiusZ + epsilon;
    const maxZ = cz + radiusZ - epsilon;

    if (minY < groundY) {
      return { hit: true, ground: true, bx: Math.round(cx), by: -1, bz: Math.round(cz) };
    }

    const startX = Math.floor(minX);
    const endX = Math.floor(maxX);
    const startY = Math.floor(minY);
    const endY = Math.floor(maxY);
    const startZ = Math.floor(minZ);
    const endZ = Math.floor(maxZ);

    for (let bx = startX; bx <= endX; bx++) {
      for (let by = startY; by <= endY; by++) {
        for (let bz = startZ; bz <= endZ; bz++) {
          const id = this.getBlockId(bx, by, bz);
          if (id > 0 && id < 9) {
            return { hit: true, bx, by, bz };
          }
        }
      }
    }
    return null;
  }

  resolveCollisionCustom(currentPos, velocity) {
    let px = currentPos.x;
    let py = currentPos.y;
    let pz = currentPos.z;

    let vx = velocity.x;
    let vy = velocity.y;
    let vz = velocity.z;

    const radiusX = 0.3;
    const radiusZ = 0.3;
    const feetOffset = 1.6;
    const headOffset = 0.2;
    const maxStepHeight = 0.6;
    const groundY = -0.5;

    if (vx !== 0) {
      const targetX = px + vx;
      const coll = this.checkCollisionCustom(targetX, py, pz);
      if (coll) {
        let stepped = false;
        if (vy <= 0) {
          const stepY = coll.by + 1.0 + feetOffset;
          const lift = stepY - py;
          if (lift > 0 && lift <= maxStepHeight) {
            if (!this.checkCollisionCustom(targetX, stepY, pz)) {
              py = stepY;
              px = targetX;
              stepped = true;
            }
          }
        }
        if (!stepped) {
          if (vx > 0) {
            px = coll.bx - radiusX - 0.001;
          } else {
            px = coll.bx + 1.0 + radiusX + 0.001;
          }
        }
      } else {
        px = targetX;
      }
    }

    if (vz !== 0) {
      const targetZ = pz + vz;
      const coll = this.checkCollisionCustom(px, py, targetZ);
      if (coll) {
        let stepped = false;
        if (vy <= 0) {
          const stepY = coll.by + 1.0 + feetOffset;
          const lift = stepY - py;
          if (lift > 0 && lift <= maxStepHeight) {
            if (!this.checkCollisionCustom(px, stepY, targetZ)) {
              py = stepY;
              pz = targetZ;
              stepped = true;
            }
          }
        }
        if (!stepped) {
          if (vz > 0) {
            pz = coll.bz - radiusZ - 0.001;
          } else {
            pz = coll.bz + 1.0 + radiusZ + 0.001;
          }
        }
      } else {
        pz = targetZ;
      }
    }

    if (vy !== 0) {
      const targetY = py + vy;
      const coll = this.checkCollisionCustom(px, targetY, pz);
      if (coll) {
        if (vy < 0) {
          if (coll.ground) {
            py = groundY + feetOffset;
          } else {
            py = coll.by + 1.0 + feetOffset;
          }
          this.verticalVelocity = 0.0;
        } else {
          py = coll.by - headOffset - 0.001;
          this.verticalVelocity = 0.0;
        }
      } else {
        py = targetY;
      }
    }

    _resolvedPos.set(px, py, pz);
    return _resolvedPos;
  }

  isPlayerGrounded() {
    return this.checkCollisionCustom(this.camera.position.x, this.camera.position.y - 0.05, this.camera.position.z) !== null;
  }

  getMaterialUnderPlayer() {
    const px = this.camera.position.x;
    const py = this.camera.position.y;
    const pz = this.camera.position.z;
    const minY = py - 1.6;
    if (minY < -0.49) {
      return "dirt";
    }
    const bx = Math.floor(px);
    const by = Math.floor(minY - 0.1);
    const bz = Math.floor(pz);
    const id = this.getBlockId(bx, by, bz);
    if (id > 0) {
      return ID_TO_MATERIAL[id] || "dirt";
    }
    return "dirt";
  }

  isPlayerInsideSolidBlock() {
    const pos = this.camera.position;
    const cx = pos.x;
    const cy = pos.y;
    const cz = pos.z;

    const inset = 0.05;
    const radiusX = 0.3 - inset;
    const radiusZ = 0.3 - inset;
    const feetOffset = 1.6 - inset;
    const headOffset = 0.2 - inset;

    const minX = cx - radiusX;
    const maxX = cx + radiusX;
    const minY = cy - feetOffset;
    const maxY = cy + headOffset;
    const minZ = cz - radiusZ;
    const maxZ = cz + radiusZ;

    const startX = Math.floor(minX);
    const endX = Math.floor(maxX);
    const startY = Math.floor(minY);
    const endY = Math.floor(maxY);
    const startZ = Math.floor(minZ);
    const endZ = Math.floor(maxZ);

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

  getSafeSpawnPosition(x = 0, z = -5) {
    const terrainH = this.getHeight(x, z);
    let highestBlockY = terrainH;
    for (let tempY = 255; tempY > terrainH; tempY--) {
      const id = this.getBlockId(Math.round(x), tempY, Math.round(z));
      if (id > 0 && id < 9) {
        highestBlockY = tempY;
        break;
      }
    }
    _safeSpawnPos.set(x, highestBlockY + 2.6, z);
    return _safeSpawnPos;
  }

  teleportPlayer(x, y, z, rotationY) {
    console.warn(`[Teleport] Snapping player to: ${x}, ${y}, ${z}, rotY: ${rotationY}`);
    
    let finalY = y;
    if (finalY === undefined || finalY === null) {
      const terrainH = this.getHeight(x, z);
      let highestBlockY = terrainH;
      for (let tempY = 255; tempY > terrainH; tempY--) {
        if (this.getBlockId(Math.round(x), tempY, Math.round(z)) > 0) {
          highestBlockY = tempY;
          break;
        }
      }
      finalY = highestBlockY + 2.6;
    }
    
    this.camera.position.set(x, finalY, z);
    this.verticalVelocity = 0.0;
    if (this.lastCamPosition) {
      this.lastCamPosition.copyFrom(this.camera.position);
    }
    if (rotationY !== undefined && rotationY !== null) {
      this.camera.rotation.y = rotationY;
    }
    
    const debugLastAction = document.getElementById("debugLastAction");
    if (debugLastAction) {
      debugLastAction.textContent = `Teleported to ${x.toFixed(1)}, ${finalY.toFixed(1)}, ${z.toFixed(1)}`;
    }
  }

  checkPlayerSafetyAndTeleport() {
    if (!this.isWorldLoaded) return;
    if (this.camera.position.y < -5 || this.isPlayerInsideSolidBlock()) {
      const safePos = this.getSafeSpawnPosition(this.camera.position.x, this.camera.position.z);
      this.teleportPlayer(safePos.x, safePos.y, safePos.z);
    }
  }

  initPlayerCamera() {
    // Set up FPS camera
    const spawnH = this.getHeight(0, -5);
    const initialPos = new Vector3(0, spawnH + 2.6, -5);
    this.camera = new UniversalCamera("playerCam", initialPos, this.scene);
    this.spawnPosition = initialPos.clone();
    this.camera.setTarget(new Vector3(0, spawnH + 2.6, 0));
    this.camera.attachControl(this.canvas, true);

    // Parent flashlight to camera now that camera is initialized
    if (this.flashlight) {
      this.flashlight.parent = this.camera;
    }

    // WASD and arrow key bindings for walking
    this.camera.keysUp.push(87);    // W
    this.camera.keysDown.push(83);  // S
    this.camera.keysLeft.push(65);  // A
    this.camera.keysRight.push(68); // D

    // Disable built-in collisions and enable custom physics
    this.camera.checkCollisions = false;
    this.scene.collisionsEnabled = false;
    this.camera.applyGravity = false; // Disable built-in gravity
    
    // Player size hitbox (height is approx 1.8 units, width is 0.8 units)
    this.camera.ellipsoid = new Vector3(0.4, 0.9, 0.4);
    this.camera.ellipsoidOffset = new Vector3(0, 0.2, 0); // Centers eye height near top of ellipsoid

    // Set reasonable walking speed and responsiveness
    this.camera.inertia = 0.8;
    this.camera.speed = 0.3;

    // Prevent camera zooming/looking under ground
    this.camera.minZ = 0.1;

    // Override camera update to implement custom AABB physics and step-climbing
    const originalUpdate = this.camera.update;
    this.camera.update = () => {
      // 1. Process inputs (updates cameraDirection based on WASD keys)
      this.camera._checkInputs();

      if (Math.abs(this.verticalVelocity) > 0.0001) {
        this.camera.cameraDirection.y = this.verticalVelocity;
      }

      const dt = Math.min(4.0, this.engine.getDeltaTime() / 16.666);
      _displacement.copyFrom(this.camera.cameraDirection);
      _displacement.scaleInPlace(dt);
      if (!this.isWorldLoaded) {
        if (_displacement.lengthSquared() > 0.00001) {
          // Temporary spectator (noclip) camera state when joining:
          // Move directly through terrain without collision resolution (faster speed)
          _displacement.scaleInPlace(1.5);
          this.camera.position.addInPlace(_displacement);
        }
      } else {
        // Resolve collisions using our custom AABB solver
        if (_displacement.lengthSquared() > 0.00001) {
          _currentPos.copyFrom(this.camera.position);
          const resolvedPos = this.resolveCollisionCustom(_currentPos, _displacement);
          this.camera.position.copyFrom(resolvedPos);
        }
      }

      // Clamp camera position to prevent escaping bounds (both in spectator and regular modes)
      this.camera.position.x = Math.max(-23.5, Math.min(23.5, this.camera.position.x));
      this.camera.position.z = Math.max(-23.5, Math.min(23.5, this.camera.position.z));
      this.camera.position.y = Math.max(-10.0, Math.min(32.0, this.camera.position.y));

      // 3. Clear cameraDirection so Babylon's default update doesn't move it again
      this.camera.cameraDirection.set(0, 0, 0);

      // 4. Call original update to update view matrix, rotation, etc.
      originalUpdate.call(this.camera);

      // 5. Fail-safe safety checks
      this.checkPlayerSafetyAndTeleport();
    };

    this.lastCamPosition = this.camera.position.clone();
    this.footstepTimer = 0;

    // Custom gravity and physics solver
    this._physicsObserver = this.scene.onBeforeRenderObservable.add(() => {
      if (!this.isWorldLoaded) {
        this.verticalVelocity = 0.0;
        this.lastCamPosition.copyFrom(this.camera.position);
        return;
      }

      const dt = Math.min(4.0, this.engine.getDeltaTime() / 16.666);
      const isGrounded = this.isPlayerGrounded();
      
      if (isGrounded && this.verticalVelocity <= 0) {
        this.verticalVelocity = 0.0;
      } else {
        // Apply downward gravity acceleration
        this.verticalVelocity -= 0.012 * dt;
        // Cap terminal velocity
        if (this.verticalVelocity < -0.3) {
          this.verticalVelocity = -0.3;
        }
      }
      
      if (Math.abs(this.verticalVelocity) > 0.0001) {
        this.camera.cameraDirection.y = this.verticalVelocity * dt;
      }

      // Footstep audio detection based on horizontal movement
      if (isGrounded) {
        const dx = this.camera.position.x - this.lastCamPosition.x;
        const dz = this.camera.position.z - this.lastCamPosition.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 0.001) {
          this.footstepTimer += dist;
          if (this.footstepTimer >= 1.8) {
            if (this.audioSynth) {
              const mat = this.getMaterialUnderPlayer();
              this.audioSynth.playFootstep(mat);
            }
            this.footstepTimer = 0;
          }
        }
      } else {
        this.footstepTimer = 0;
      }
      this.lastCamPosition.copyFrom(this.camera.position);
    });

    // Dynamic cave biome detector (fade light and fog under y=2)
    this._biomeObserver = this.scene.onBeforeRenderObservable.add(() => {
      const playerY = this.camera.position.y;
      const targetInCave = playerY < 2.0;
      
      // Target settings
      const targetFogColor = targetInCave ? _fogColorCave : _fogColorSky;
      const targetClearColor = targetInCave ? _clearColorCave : _clearColorSky;
      const targetHemiIntensity = targetInCave ? 0.05 : 0.55;
      const targetDirIntensity = targetInCave ? 0.05 : 0.45;
      const targetFogStart = targetInCave ? 5.0 : 35.0;
      const targetFogEnd = targetInCave ? 25.0 : 85.0;
      
      // Interpolate color and intensities
      Color3.LerpToRef(this.scene.fogColor, targetFogColor, 0.05, this.scene.fogColor);
      Color3.LerpToRef(this.scene.clearColor, targetClearColor, 0.05, this.scene.clearColor);
      
      const hemiLight = this.scene.getLightByName("hemiLight");
      if (hemiLight) {
        hemiLight.intensity += (targetHemiIntensity - hemiLight.intensity) * 0.05;
      }
      
      const dirLight = this.scene.getLightByName("dirLight");
      if (dirLight) {
        dirLight.intensity += (targetDirIntensity - dirLight.intensity) * 0.05;
      }
      
      this.scene.fogStart += (targetFogStart - this.scene.fogStart) * 0.05;
      this.scene.fogEnd += (targetFogEnd - this.scene.fogEnd) * 0.05;
    });
  }

  initHighlight() {
    // Wireframe cube overlay to show which block is targeted
    this.highlightBox = MeshBuilder.CreateBox("highlightBox", { size: 1.02 }, this.scene);
    this.highlightBox.isPickable = false; // Prevent raycasts from picking the highlight mesh itself!
    
    const highlightMat = new StandardMaterial("highlightMat", this.scene);
    highlightMat.diffuseColor = new Color3(1, 1, 1);
    highlightMat.emissiveColor = new Color3(1, 1, 1);
    highlightMat.wireframe = true;
    highlightMat.disableLighting = true;
    
    this.highlightBox.material = highlightMat;
    this.highlightBox.isVisible = false;
  }

  initInteraction() {
    this._hudFrameCount = 0;
    this._renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      this._hudFrameCount++;
      const shouldUpdateHUD = this._hudFrameCount % 30 === 0;

      if (shouldUpdateHUD) {
        const debugDPR = document.getElementById("debugDPR");
        if (debugDPR) debugDPR.textContent = window.devicePixelRatio.toFixed(2);
        
        const debugCanvasCSS = document.getElementById("debugCanvasCSS");
        if (debugCanvasCSS) debugCanvasCSS.textContent = `${this.canvas.clientWidth}x${this.canvas.clientHeight}`;
        
        const debugCanvasRender = document.getElementById("debugCanvasRender");
        if (debugCanvasRender) debugCanvasRender.textContent = `${this.engine.getRenderWidth()}x${this.engine.getRenderHeight()}`;
        
        const debugPointerLock = document.getElementById("debugPointerLock");
        if (debugPointerLock) {
          debugPointerLock.textContent = document.pointerLockElement === this.canvas ? "Locked" : "Unlocked";
          debugPointerLock.style.color = document.pointerLockElement === this.canvas ? "#10b981" : "#ef4444";
        }
      }

      if (!this.isWorldLoaded) {
        this.highlightBox.isVisible = false;
        return;
      }

      this.camera.getForwardRayToRef(_scratchRay, 1);
      const origin = _scratchRay.origin;
      const direction = _scratchRay.direction;
      const pickInfo = this.ddaRaycast(origin, direction, 6);

      if (shouldUpdateHUD) {
        const debugRayHit = document.getElementById("debugRayHit");
        const debugRayDist = document.getElementById("debugRayDist");
        const debugPickedMesh = document.getElementById("debugPickedMesh");
        const debugBlockTarget = document.getElementById("debugBlockTarget");

        if (pickInfo.hit) {
          if (debugRayHit) {
            debugRayHit.textContent = "True";
            debugRayHit.style.color = "#10b981";
          }
          if (debugRayDist) debugRayDist.textContent = pickInfo.distance.toFixed(2);
          if (debugPickedMesh) debugPickedMesh.textContent = pickInfo.isGround ? "ground" : (ID_TO_MATERIAL[pickInfo.materialId] || "block");
          if (debugBlockTarget) debugBlockTarget.textContent = `${pickInfo.x}, ${pickInfo.y}, ${pickInfo.z}`;
        } else {
          if (debugRayHit) {
            debugRayHit.textContent = "False";
            debugRayHit.style.color = "#ef4444";
          }
          if (debugRayDist) debugRayDist.textContent = "-";
          if (debugPickedMesh) debugPickedMesh.textContent = "-";
          if (debugBlockTarget) debugBlockTarget.textContent = "-";
        }
      }

      if (pickInfo.hit) {
        const gridX = pickInfo.x;
        const gridY = pickInfo.y;
        const gridZ = pickInfo.z;
        const isFlower = pickInfo.materialId === 9 || pickInfo.materialId === 10;
        this.highlightBox.position.set(gridX + 0.5, gridY + 0.5, gridZ + 0.5);
        this.highlightBox.isVisible = true;
      } else {
        this.highlightBox.isVisible = false;
      }

      if (this.isWorldLoaded) {
        if (!this._chunkUnloadTimer) this._chunkUnloadTimer = 0;
        this._chunkUnloadTimer++;
        if (this._chunkUnloadTimer > 60) {
          this._chunkUnloadTimer = 0;
          this.unloadDistantChunks();
        }
      }
    });

    this._pointerObserver = this.scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type !== PointerEventTypes.POINTERDOWN) return;
      if (!this.isWorldLoaded) return;
      if (document.pointerLockElement !== this.canvas) return;

      const isLeft = pointerInfo.event.button === 0;
      const isRight = pointerInfo.event.button === 2;
      
      if (!isLeft && !isRight) return;

      this.camera.getForwardRayToRef(_scratchRay, 1);
      const origin = _scratchRay.origin;
      const direction = _scratchRay.direction;
      const pickInfo = this.ddaRaycast(origin, direction, 6);

      if (pickInfo.hit) {
        if (isLeft) {
          if (!pickInfo.isGround) {
            const inSpawnSafeZone = Math.abs(pickInfo.x) <= 1 && Math.abs(pickInfo.z + 5) <= 1;
            if (inSpawnSafeZone && pickInfo.y <= 4) {
              return;
            }
            this.onBlockChange(pickInfo.x, pickInfo.y, pickInfo.z, null);
            const debugLastAction = document.getElementById("debugLastAction");
            if (debugLastAction) debugLastAction.textContent = `Deleted block @ ${pickInfo.x},${pickInfo.y},${pickInfo.z}`;
          }
        } else if (isRight) {
          const x = pickInfo.x + pickInfo.normalX;
          const y = pickInfo.y + pickInfo.normalY;
          const z = pickInfo.z + pickInfo.normalZ;

          if (y >= 0 && y < 20 && Math.abs(x) < 50 && Math.abs(z) < 50) {
            const camPos = this.camera.position;
            const blockCenterX = x + 0.5;
            const blockCenterY = y + 0.5;
            const blockCenterZ = z + 0.5;
            const horizontalDist = Math.sqrt(Math.pow(camPos.x - blockCenterX, 2) + Math.pow(camPos.z - blockCenterZ, 2));
            const verticalDist = camPos.y - blockCenterY;

            if (horizontalDist < 0.8 && verticalDist > -0.7 && verticalDist < 2.1) {
              return;
            }

            const inSpawnSafeZone = Math.abs(x) <= 1 && Math.abs(z + 5) <= 1;
            if (inSpawnSafeZone && y > 4) {
              return;
            }

            this.onBlockChange(x, y, z, this.activeMaterial);
            const debugLastAction = document.getElementById("debugLastAction");
            if (debugLastAction) debugLastAction.textContent = `Placed ${this.activeMaterial} @ ${x},${y},${z}`;
          }
        }
      }
    });

    this._onKeyDown = (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
        return;
      }
      
      if (e.code === "Space") {
        if (!this._spaceReleased) return;
        this._spaceReleased = false;
        e.preventDefault();

        if (this.isWorldLoaded && this.isPlayerGrounded()) {
          this.verticalVelocity = 0.22;
          const debugLastAction = document.getElementById("debugLastAction");
          if (debugLastAction) debugLastAction.textContent = "Jumped";
          if (this.audioSynth) {
            this.audioSynth.playJump();
          }
        }
      } else if (e.code === "KeyF") {
        e.preventDefault();
        if (this.flashlight) {
          this.flashlight.intensity = this.flashlight.intensity > 0 ? 0.0 : 1.5;
          const debugLastAction = document.getElementById("debugLastAction");
          if (debugLastAction) {
            debugLastAction.textContent = `Flashlight ${this.flashlight.intensity > 0 ? "ON" : "OFF"}`;
          }
        }
      }
    };

    this._onKeyUp = (e) => {
      if (e.code === "Space") {
        this._spaceReleased = true;
      }
    };

    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
  }

  unloadDistantChunks() {
    const px = this.camera.position.x;
    const py = this.camera.position.y;
    const pz = this.camera.position.z;
    const maxDistSq = 120 * 120;

    for (const [key, chunk] of this.chunks.entries()) {
      const [cx, cy, cz] = key.split(",").map(Number);
      const centerX = cx * 16 + 8;
      const centerY = cy * 16 + 8;
      const centerZ = cz * 16 + 8;
      const dx = centerX - px;
      const dy = centerY - py;
      const dz = centerZ - pz;
      
      if (dx*dx + dy*dy + dz*dz > maxDistSq) {
        this.chunks.delete(key);
        const chunkMeshesMap = this.chunkMeshes.get(key);
        if (chunkMeshesMap) {
          for (const mesh of chunkMeshesMap.values()) {
            mesh.dispose();
          }
          this.chunkMeshes.delete(key);
        }
        
        // Clean up flowers inside this culled chunk
        for (const [flowerKey, instance] of this.flowerInstances.entries()) {
          const [fx, fy, fz] = flowerKey.split(",").map(Number);
          const fcx = Math.floor(fx / 16);
          const fcy = Math.floor(fy / 16);
          const fcz = Math.floor(fz / 16);
          if (fcx === cx && fcy === cy && fcz === cz) {
            instance.dispose();
            this.flowerInstances.delete(flowerKey);
          }
        }
      }
    }
  }

  selectMaterial(materialName) {
    if (this.materials[materialName]) {
      this.activeMaterial = materialName;
    }
  }

  setBlock(x, y, z, materialName) {
    const key = `${x},${y},${z}`;
    const id = MATERIAL_TO_ID[materialName] || 0;
    
    this.setBlockId(x, y, z, id);
    
    if (id === 9 || id === 10) {
      if (this.flowerInstances.has(key)) {
        this.flowerInstances.get(key).dispose();
      }
      const baseMesh = this.templateMeshes[materialName];
      if (baseMesh) {
        const instance = baseMesh.createInstance("flower_" + key);
        instance.scaling.set(0.4, 0.6, 0.4);
        instance.position.set(x + 0.5, y + 0.3, z + 0.5);
        instance.checkCollisions = false;
        instance.isPickable = true;
        instance.computeWorldMatrix(true);
        instance.freezeWorldMatrix();
        this.flowerInstances.set(key, instance);
      }
    } else {
      if (this.flowerInstances.has(key)) {
        this.flowerInstances.get(key).dispose();
        this.flowerInstances.delete(key);
      }
    }
    
    if (!this._isBulkLoading) {
      this.rebuildChunkAndNeighbors(x, y, z);
    }
  }

  loadWorld(blocksData) {
    this._isBulkLoading = true;
    
    for (const chunkMeshesMap of this.chunkMeshes.values()) {
      for (const mesh of chunkMeshesMap.values()) {
        mesh.dispose();
      }
    }
    this.chunkMeshes.clear();

    for (const mesh of this.flowerInstances.values()) {
      mesh.dispose();
    }
    this.flowerInstances.clear();
    
    this.chunks.clear();

    const size = 24;
    for (let x = -size; x <= size; x++) {
      for (let z = -size; z <= size; z++) {
        const h = this.getHeight(x, z);
        const inSpawnSafeZone = Math.abs(x) <= 1 && Math.abs(z + 5) <= 1;
        for (let y = 0; y <= h; y++) {
          let type = "stone";
          if (inSpawnSafeZone) {
            if (y === 4) {
              type = "glass";
            } else {
              type = "stone";
            }
          } else {
            if (y === h) {
              type = "grass";
            } else if (y === h - 1) {
              type = "dirt";
            }
          }
          this.setBlock(x, y, z, type);
        }
        
        if (inSpawnSafeZone) {
          for (let y = 5; y <= 19; y++) {
            this.setBlock(x, y, z, null);
          }
        }
        
        const isNearSpawn = Math.abs(x) < 8 && z >= -12 && z <= 4;
        if (!isNearSpawn) {
          const treeSeed = getTreeSeed(x, z);
          if (treeSeed < 0.015) {
            const trunkH = 4 + Math.floor(treeSeed * 200) % 3;
            for (let ty = 1; ty <= trunkH; ty++) {
              this.setBlock(x, h + ty, z, "wood");
            }
            const canopyCenterY = h + trunkH + 1;
            for (let lx = -2; lx <= 2; lx++) {
              for (let lz = -2; lz <= 2; lz++) {
                for (let ly = -2; ly <= 2; ly++) {
                  const distSq = lx*lx + ly*ly + lz*lz;
                  if (distSq <= 6) {
                    const leafX = x + lx;
                    const leafY = canopyCenterY + ly;
                    const leafZ = z + lz;
                    if (leafX === x && leafZ === z && leafY <= h + trunkH) {
                      continue;
                    }
                    this.setBlock(leafX, leafY, leafZ, "leaves");
                  }
                }
              }
            }
          } else if (treeSeed < 0.06) {
            const flowerType = (Math.floor(treeSeed * 1000) % 2 === 0) ? "flower-red" : "flower-yellow";
            this.setBlock(x, h + 1, z, flowerType);
          }
        }
      }
    }

    for (const [key, val] of Object.entries(blocksData)) {
      const [xStr, yStr, zStr] = key.split(",");
      const x = parseInt(xStr, 10);
      const y = parseInt(yStr, 10);
      const z = parseInt(zStr, 10);
      
      const inSpawnSafeZone = Math.abs(x) <= 1 && Math.abs(z + 5) <= 1;
      if (inSpawnSafeZone) {
        continue;
      }
      
      if (val === null || val.type === null) {
        this.setBlock(x, y, z, null);
      } else if (val && val.type) {
        this.setBlock(x, y, z, val.type);
      }
    }

    this._isBulkLoading = false;
    
    for (const key of this.chunks.keys()) {
      const [cx, cy, cz] = key.split(",").map(Number);
      this.rebuildChunkMesh(cx, cy, cz);
    }

    const px = this.camera.position.x;
    const pz = this.camera.position.z;
    const terrainH = this.getHeight(px, pz);
    let highestBlockY = terrainH;
    for (let tempY = 255; tempY > terrainH; tempY--) {
      if (this.getBlockId(Math.round(px), tempY, Math.round(pz)) > 0) {
        highestBlockY = tempY;
        break;
      }
    }
    this.camera.position.y = highestBlockY + 2.6;
    this.spawnPosition.y = this.camera.position.y;
    this.verticalVelocity = 0.0;

    this.scene.createOrUpdateSelectionOctree();
    this.isWorldLoaded = true;
    
    const loadingOverlay = document.getElementById("loadingOverlay");
    if (loadingOverlay) {
      loadingOverlay.classList.add("hidden");
    }
  }

  // Remote player managers
  updatePlayer(id, username, color, position, rotation) {
    if (!position || !rotation) return;
    if (!this.otherPlayers.has(id)) {
      this.createPlayerAvatar(id, username, color);
    }

    const player = this.otherPlayers.get(id);
    if (player) {
      if (!player.playout) {
        player.playout = {
          buffer: [],
          addPacket(pos, rotY) {
            this.buffer.push({
              time: performance.now(),
              position: new Vector3(pos.x, pos.y, pos.z),
              yaw: rotY
            });
            if (this.buffer.length > 4) {
              this.buffer.shift();
            }
          }
        };
      }
      
      player.playout.addPacket(position, rotation.y);
      
      if (!player.initialized) {
        player.root.position.set(position.x, position.y, position.z);
        player.root.rotation.y = rotation.y;
        player.initialized = true;
      } else {
        // Reset playout buffer on large sudden position jump (teleport) to prevent rapid sliding/snapping
        const buffer = player.playout.buffer;
        if (buffer.length >= 2) {
          const lastPacket = buffer[buffer.length - 2];
          const dx = position.x - lastPacket.position.x;
          const dy = position.y - lastPacket.position.y;
          const dz = position.z - lastPacket.position.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          if (distSq > 9.0) { // distance > 3 units
            player.playout.buffer = [buffer[buffer.length - 1]];
            player.root.position.set(position.x, position.y, position.z);
            player.root.rotation.y = rotation.y;
          }
        }
      }
      
      if (!player.renderObservable) {
        player.renderObservable = this.scene.onBeforeRenderObservable.add(() => {
          const now = performance.now();
          const playTime = now - 100;
          
          const buffer = player.playout.buffer;
          if (buffer.length === 0) return;
          
          let i = 0;
          for (; i < buffer.length - 1; i++) {
            if (buffer[i].time <= playTime && playTime <= buffer[i + 1].time) {
              break;
            }
          }
          
          if (playTime > buffer[buffer.length - 1].time) {
            const last = buffer[buffer.length - 1];
            if (buffer.length >= 2) {
              const prev = buffer[buffer.length - 2];
              const dt = last.time - prev.time;
              if (dt > 0) {
                const elapsed = playTime - last.time;
                const decay = Math.max(0, 1 - elapsed / 300);
                const velocityX = (last.position.x - prev.position.x) / dt;
                const velocityY = (last.position.y - prev.position.y) / dt;
                const velocityZ = (last.position.z - prev.position.z) / dt;
                
                player.root.position.set(
                  last.position.x + velocityX * elapsed * decay,
                  last.position.y + velocityY * elapsed * decay,
                  last.position.z + velocityZ * elapsed * decay
                );
                player.root.rotation.y = last.yaw;
              }
            } else {
              player.root.position.copyFrom(last.position);
              player.root.rotation.y = last.yaw;
            }
            return;
          }
          
          if (playTime < buffer[0].time) {
            player.root.position.copyFrom(buffer[0].position);
            player.root.rotation.y = buffer[0].yaw;
            return;
          }
          
          const p1 = buffer[i];
          const p2 = buffer[i + 1];
          const dt = p2.time - p1.time;
          const t = dt > 0 ? (playTime - p1.time) / dt : 1.0;
          
          let diff = p2.yaw - p1.yaw;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;
          player.root.rotation.y = p1.yaw + diff * t;
          
          if (buffer.length >= 4 && i >= 1 && i < buffer.length - 2) {
            const p0 = buffer[i - 1];
            const p3 = buffer[i + 2];
            
            p2.position.subtractToRef(p0.position, _interpolateTangent1);
            _interpolateTangent1.scaleInPlace(0.5);
            
            p3.position.subtractToRef(p1.position, _interpolateTangent2);
            _interpolateTangent2.scaleInPlace(0.5);
            
            Vector3.HermiteToRef(p1.position, _interpolateTangent1, p2.position, _interpolateTangent2, t, player.root.position);
          } else {
            Vector3.LerpToRef(p1.position, p2.position, t, player.root.position);
          }
        });
      }
    }
  }

  createPlayerAvatar(id, username, color) {
    const root = new TransformNode("player_root_" + id, this.scene);
    
    // Body box
    const body = MeshBuilder.CreateBox("player_body_" + id, { width: 0.6, height: 1.0, depth: 0.4 }, this.scene);
    body.position.y = -1.1;
    body.parent = root;

    const bodyMat = new StandardMaterial("player_body_mat_" + id, this.scene);
    bodyMat.diffuseColor = Color3.FromHexString(color);
    bodyMat.specularColor = new Color3(0.1, 0.1, 0.1);
    body.material = bodyMat;

    // Head box
    const head = MeshBuilder.CreateBox("player_head_" + id, { width: 0.4, height: 0.4, depth: 0.4 }, this.scene);
    head.position.y = -0.4;
    head.parent = root;

    const headMat = new StandardMaterial("player_head_mat_" + id, this.scene);
    headMat.diffuseColor = new Color3(0.9, 0.8, 0.7); // standard skin-like tone
    headMat.specularColor = new Color3(0.05, 0.05, 0.05);
    head.material = headMat;

    // Name label billboard
    const namePlane = MeshBuilder.CreatePlane("name_plane_" + id, { width: 1.8, height: 0.45 }, this.scene);
    namePlane.position.y = 0.1;
    namePlane.parent = root;
    namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL; // always face camera

    const nameTexture = new DynamicTexture("name_tex_" + id, { width: 256, height: 64 }, this.scene, true);
    const ctx = nameTexture.getContext();
    ctx.fillStyle = "rgba(15, 23, 42, 0.6)"; // Sleek dark overlay
    ctx.fillRect(0, 0, 256, 64);
    
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, 256, 64);
    
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px Outfit";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(username, 128, 32);
    nameTexture.update();

    const nameMat = new StandardMaterial("name_mat_" + id, this.scene);
    nameMat.diffuseTexture = nameTexture;
    nameMat.opacityTexture = nameTexture;
    namePlane.material = nameMat;

    // Add player avatar to shadows
    if (this.shadowGenerator) {
      this.shadowGenerator.addShadowCaster(body, true);
      this.shadowGenerator.addShadowCaster(head, true);
    }
    body.receiveShadows = true;
    head.receiveShadows = true;

    this.otherPlayers.set(id, {
      root,
      body,
      head,
      namePlane,
      targetPosition: new Vector3(0, 1.5, 0),
      targetRotationY: 0,
      initialized: false,
      renderObservable: null
    });
  }

  removePlayer(id) {
    if (this.otherPlayers.has(id)) {
      const player = this.otherPlayers.get(id);
      
      // Clean up renderer observables
      if (player.renderObservable) {
        this.scene.onBeforeRenderObservable.remove(player.renderObservable);
      }
      
      // Dispose materials & textures
      if (player.body.material) player.body.material.dispose();
      if (player.head.material) player.head.material.dispose();
      if (player.namePlane.material) {
        if (player.namePlane.material.diffuseTexture) player.namePlane.material.diffuseTexture.dispose();
        player.namePlane.material.dispose();
      }

      // Dispose meshes
      player.body.dispose();
      player.head.dispose();
      player.namePlane.dispose();
      player.root.dispose();
      
      this.otherPlayers.delete(id);
    }
  }

  getPlayerState() {
    return {
      position: {
        x: parseFloat(this.camera.position.x.toFixed(3)),
        y: parseFloat(this.camera.position.y.toFixed(3)),
        z: parseFloat(this.camera.position.z.toFixed(3))
      },
      rotation: {
        y: parseFloat(this.camera.rotation.y.toFixed(3))
      }
    };
  }


  dispose() {
    if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
    if (this._onKeyDown) window.removeEventListener("keydown", this._onKeyDown);
    if (this._onKeyUp) window.removeEventListener("keyup", this._onKeyUp);
    
    if (this._physicsObserver) this.scene.onBeforeRenderObservable.remove(this._physicsObserver);
    if (this._biomeObserver) this.scene.onBeforeRenderObservable.remove(this._biomeObserver);
    if (this._renderObserver) this.scene.onBeforeRenderObservable.remove(this._renderObserver);
    if (this._pointerObserver) this.scene.onPointerObservable.remove(this._pointerObserver);
    
    if (this.engine) this.engine.stopRenderLoop();
    
    for (const id of Array.from(this.otherPlayers.keys())) {
      this.removePlayer(id);
    }
    this.otherPlayers.clear();
    
    for (const chunkMeshesMap of this.chunkMeshes.values()) {
      for (const mesh of chunkMeshesMap.values()) {
        mesh.dispose();
      }
    }
    this.chunkMeshes.clear();

    for (const mesh of this.flowerInstances.values()) {
      mesh.dispose();
    }
    this.flowerInstances.clear();
    
    this.chunks.clear();
    
    for (const name in this.templateMeshes) {
      if (this.templateMeshes[name]) {
        this.templateMeshes[name].dispose();
      }
    }
    this.templateMeshes = {};
    
    if (this.highlightBox) this.highlightBox.dispose();
    if (this.ground) this.ground.dispose();
    if (this.skySphere) this.skySphere.dispose();
    
    for (const name in this.materials) {
      if (this.materials[name]) {
        if (this.materials[name].diffuseTexture) {
          this.materials[name].diffuseTexture.dispose();
        }
        this.materials[name].dispose();
      }
    }
    this.materials = {};
    
    if (this.scene) this.scene.dispose();
    if (this.engine) this.engine.dispose();
  }
}
