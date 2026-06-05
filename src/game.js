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
  DynamicTexture,
  Mesh,
  TransformNode,
  Ray,
  PointerEventTypes,
  ShadowGenerator,
  PointLight
} from "@babylonjs/core";

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

export class Game {
  constructor(canvasId, onBlockChange) {
    this.canvas = document.getElementById(canvasId);
    this.onBlockChange = onBlockChange; // callback(x, y, z, materialName | null)
    
    // Core engine & scene
    this.engine = new Engine(this.canvas, true, {
      adaptToDeviceRatio: true,
      limitDeviceRatio: 2.0
    });
    this.scene = new Scene(this.engine);
    
    // Configs
    this.activeMaterial = "grass";
    this.blocks = new Map(); // key ("x,y,z") -> Mesh
    this.blocksArray = []; // optimized flat array for fast circular culling
    this.otherPlayers = new Map(); // id -> { root, body, head, label }
    
    // Kinematic physics state
    this.verticalVelocity = 0.0;
    this._spaceReleased = true;
    this.lastCamGridX = null;
    this.lastCamGridZ = null;
    this._isBulkLoading = false;
    
    this.initScene();
    this.initLights();
    this.initSkyDome();
    this.initGround();
    this.initMaterials();
    this.initPlayerCamera();
    this.initHighlight();
    this.initInteraction();
    
    // Handle window resize
    this._resizeHandler = () => {
      this.engine.resize();
    };
    window.addEventListener("resize", this._resizeHandler);

    // Start rendering loop
    this.engine.runRenderLoop(() => {
      this.scene.render();
    });
  }

  getHeight(x, z) {
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
    flowerRed.specularColor = new Color3(0, 0, 0);
    this.materials["flower-red"] = flowerRed;

    // 10. Flower Yellow
    const flowerYellow = new StandardMaterial("mat_flower-yellow", this.scene);
    flowerYellow.diffuseTexture = this.createVoxelTexture("transparent", "#fbbf24", "flower-yellow");
    flowerYellow.diffuseTexture.hasAlpha = true;
    flowerYellow.useAlphaFromDiffuseTexture = true;
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

  isPlayerGrounded() {
    const offsets = [
      new Vector3(0, 0, 0),
      new Vector3(0.3, 0, 0),
      new Vector3(-0.3, 0, 0),
      new Vector3(0, 0, 0.3),
      new Vector3(0, 0, -0.3)
    ];
    
    const feetY = this.camera.position.y + this.camera.ellipsoidOffset.y - 2 * this.camera.ellipsoid.y;
    for (const offset of offsets) {
      const origin = new Vector3(this.camera.position.x + offset.x, feetY + 0.05, this.camera.position.z + offset.z);
      const ray = new Ray(origin, new Vector3(0, -1, 0), 0.2);
      const pick = this.scene.pickWithRay(ray, (mesh) => {
        return mesh === this.ground || (mesh.name && mesh.name.startsWith("block_"));
      });
      
      if (pick && pick.hit) {
        return true;
      }
    }
    return false;
  }

  initPlayerCamera() {
    // Set up FPS camera
    const spawnH = this.getHeight(0, -5);
    this.camera = new UniversalCamera("playerCam", new Vector3(0, spawnH + 2.1, -5), this.scene);
    this.camera.setTarget(new Vector3(0, spawnH + 2.1, 0));
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

    // Enable player physics / size
    this.camera.checkCollisions = true;
    this.camera.applyGravity = false; // Disable built-in gravity
    
    // Player size hitbox (height is approx 1.8 units, width is 0.8 units)
    this.camera.ellipsoid = new Vector3(0.4, 0.9, 0.4);
    this.camera.ellipsoidOffset = new Vector3(0, 0.2, 0); // Centers eye height near top of ellipsoid

    // Set reasonable walking speed and responsiveness
    this.camera.inertia = 0.8;
    this.camera.speed = 0.3;

    // Prevent camera zooming/looking under ground
    this.camera.minZ = 0.1;

    // Custom gravity and physics solver
    this._physicsObserver = this.scene.onBeforeRenderObservable.add(() => {
      const isGrounded = this.isPlayerGrounded();
      
      if (isGrounded && this.verticalVelocity <= 0) {
        this.verticalVelocity = 0.0;
      } else {
        // Apply downward gravity acceleration
        this.verticalVelocity -= 0.012;
        // Cap terminal velocity
        if (this.verticalVelocity < -0.3) {
          this.verticalVelocity = -0.3;
        }
      }
      
      if (Math.abs(this.verticalVelocity) > 0.0001) {
        this.camera.cameraDirection.y = this.verticalVelocity;
      }
    });

    // Dynamic cave biome detector (fade light and fog under y=2)
    this._biomeObserver = this.scene.onBeforeRenderObservable.add(() => {
      const playerY = this.camera.position.y;
      const targetInCave = playerY < 2.0;
      
      // Target settings
      const targetFogColor = targetInCave ? new Color3(0.01, 0.02, 0.05) : Color3.FromHexString("#bae6fd");
      const targetClearColor = targetInCave ? new Color3(0.01, 0.02, 0.05) : Color3.FromHexString("#bae6fd");
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
    // Every frame, check what block the player is pointing at to position the highlight box
    this._renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      // Update basic canvas & DPR debug info
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

      // Circular Horizon Culling on movement boundaries
      const camGridX = Math.floor(this.camera.position.x);
      const camGridZ = Math.floor(this.camera.position.z);
      
      if (camGridX !== this.lastCamGridX || camGridZ !== this.lastCamGridZ) {
        this.lastCamGridX = camGridX;
        this.lastCamGridZ = camGridZ;
        this.updateCulling();
      }

      // Screen-space independent Ray picking
      const ray = this.camera.getForwardRay(6);
      const pickInfo = this.scene.pickWithRay(ray, (mesh) => {
        return mesh === this.ground || (mesh.name && mesh.name.startsWith("block_"));
      });

      const debugRayHit = document.getElementById("debugRayHit");
      const debugRayDist = document.getElementById("debugRayDist");
      const debugPickedMesh = document.getElementById("debugPickedMesh");
      const debugBlockTarget = document.getElementById("debugBlockTarget");

      if (pickInfo.hit && pickInfo.distance < 6 && (pickInfo.pickedMesh === this.ground || pickInfo.pickedMesh.name.startsWith("block_"))) {
        let x, y, z;
        if (pickInfo.pickedMesh === this.ground) {
          x = Math.round(pickInfo.pickedPoint.x);
          y = 0; // First layer of blocks is at y = 0
          z = Math.round(pickInfo.pickedPoint.z);
        } else {
          // It's a block
          const pos = pickInfo.pickedMesh.position;
          x = pos.x;
          y = pos.y;
          z = pos.z;
        }
        
        // Match the highlight box position to the true block grid coord (including flowers)
        const gridX = Math.round(x);
        const gridY = Math.round(y + (pickInfo.pickedMesh.name && pickInfo.pickedMesh.name.includes("flower") ? 0.2 : 0));
        const gridZ = Math.round(z);
        
        this.highlightBox.position.set(gridX, gridY, gridZ);
        this.highlightBox.isVisible = true;

        if (debugRayHit) {
          debugRayHit.textContent = "True";
          debugRayHit.style.color = "#10b981";
        }
        if (debugRayDist) debugRayDist.textContent = pickInfo.distance.toFixed(2);
        if (debugPickedMesh) debugPickedMesh.textContent = pickInfo.pickedMesh.name;
        if (debugBlockTarget) debugBlockTarget.textContent = `${gridX}, ${gridY}, ${gridZ}`;
      } else {
        this.highlightBox.isVisible = false;

        if (debugRayHit) {
          debugRayHit.textContent = "False";
          debugRayHit.style.color = "#ef4444";
        }
        if (debugRayDist) debugRayDist.textContent = pickInfo.hit ? `${pickInfo.distance.toFixed(2)} (Out of Range)` : "-";
        if (debugPickedMesh) debugPickedMesh.textContent = pickInfo.hit ? pickInfo.pickedMesh.name : "-";
        if (debugBlockTarget) debugBlockTarget.textContent = "-";
      }
    });

    // Pointer clicks
    this._pointerObserver = this.scene.onPointerObservable.add((pointerInfo) => {
      // Filter out pointer move/up, only respond on pointer down
      if (pointerInfo.type !== PointerEventTypes.POINTERDOWN) return;

      // 0: left click, 2: right click
      const isLeft = pointerInfo.event.button === 0;
      const isRight = pointerInfo.event.button === 2;
      
      if (!isLeft && !isRight) return;

      const ray = this.camera.getForwardRay(6);
      const pickInfo = this.scene.pickWithRay(ray, (mesh) => {
        return mesh === this.ground || (mesh.name && mesh.name.startsWith("block_"));
      });

      // Verify we picked something close enough (max 6 units range)
      if (pickInfo.hit && pickInfo.distance < 6) {
        const mesh = pickInfo.pickedMesh;
        const normal = pickInfo.getNormal(true);

        if (isLeft) {
          // Left Click: Delete Block
          if (mesh && mesh !== this.ground && mesh.name.startsWith("block_")) {
            const pos = mesh.position;
            const gridX = Math.round(pos.x);
            const gridY = Math.round(pos.y + (mesh.name.includes("flower") ? 0.2 : 0));
            const gridZ = Math.round(pos.z);
            
            this.onBlockChange(gridX, gridY, gridZ, null);
            const debugLastAction = document.getElementById("debugLastAction");
            if (debugLastAction) debugLastAction.textContent = `Deleted block @ ${gridX},${gridY},${gridZ}`;
          }
        } else if (isRight) {
          // Right Click: Place Block
          let x, y, z;
          if (mesh === this.ground) {
            x = Math.round(pickInfo.pickedPoint.x);
            y = 0;
            z = Math.round(pickInfo.pickedPoint.z);
          } else {
            const pos = mesh.position;
            const gridX = Math.round(pos.x);
            const gridY = Math.round(pos.y + (mesh.name.includes("flower") ? 0.2 : 0));
            const gridZ = Math.round(pos.z);
            
            x = Math.round(gridX + normal.x);
            y = Math.round(gridY + normal.y);
            z = Math.round(gridZ + normal.z);
          }

          // Bound placement range to prevent building out of bounds or in player face
          if (y >= 0 && y < 20 && Math.abs(x) < 50 && Math.abs(z) < 50) {
            // Check if player would collide with placing block
            const camPos = this.camera.position;
            // Player height spans roughly camPos.y - 1.2 to camPos.y + 0.2. Prevent blocking player body
            const horizontalDist = Math.sqrt(Math.pow(camPos.x - x, 2) + Math.pow(camPos.z - z, 2));
            const verticalDist = camPos.y - y;

            if (horizontalDist < 0.7 && verticalDist > -0.5 && verticalDist < 1.3) {
              // Too close to player body, skip placing
              return;
            }

            this.onBlockChange(x, y, z, this.activeMaterial);
            const debugLastAction = document.getElementById("debugLastAction");
            if (debugLastAction) debugLastAction.textContent = `Placed ${this.activeMaterial} @ ${x},${y},${z}`;
          }
        }
      }
    });

    // Keyboard bindings for jumping and flashlight
    this._onKeyDown = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
        return;
      }
      
      if (e.code === "Space") {
        if (!this._spaceReleased) return; // Prevent key repeat jumps
        this._spaceReleased = false;
        e.preventDefault();

        if (this.isPlayerGrounded()) {
          this.verticalVelocity = 0.22;
          const debugLastAction = document.getElementById("debugLastAction");
          if (debugLastAction) debugLastAction.textContent = "Jumped";
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

  // Material selection from hotbar
  selectMaterial(materialName) {
    if (this.materials[materialName]) {
      this.activeMaterial = materialName;
    }
  }

  isBlockExposed(x, y, z) {
    const neighbors = [
      [x + 1, y, z],
      [x - 1, y, z],
      [x, y + 1, z],
      [x, y - 1, z],
      [x, y, z + 1],
      [x, y, z - 1]
    ];
    for (const [nx, ny, nz] of neighbors) {
      const key = `${nx},${ny},${nz}`;
      const neighbor = this.blocks.get(key);
      if (!neighbor) {
        return true; // Missing block neighbor -> exposed
      }
      // If neighbor is translucent or a flower, the current block is still exposed
      if (neighbor.materialName === "glass" || neighbor.materialName.startsWith("flower")) {
        return true;
      }
    }
    return false; // All 6 neighbors are opaque blocks -> culled (hidden)
  }

  updateBlockExposure(x, y, z) {
    const key = `${x},${y},${z}`;
    const mesh = this.blocks.get(key);
    if (mesh) {
      mesh.isExposed = this.isBlockExposed(x, y, z);
    }
  }

  updateExposureAround(x, y, z) {
    const coords = [
      [x, y, z],
      [x + 1, y, z],
      [x - 1, y, z],
      [x, y + 1, z],
      [x, y - 1, z],
      [x, y, z + 1],
      [x, y, z - 1]
    ];
    for (const [cx, cy, cz] of coords) {
      this.updateBlockExposure(cx, cy, cz);
    }
  }

  updateCulling() {
    const camX = this.camera.position.x;
    const camZ = this.camera.position.z;
    const renderDistSq = 36 * 36;
    
    const arr = this.blocksArray || [];
    const len = arr.length;
    for (let i = 0; i < len; i++) {
      const mesh = arr[i];
      const dx = mesh.position.x - camX;
      const dz = mesh.position.z - camZ;
      mesh.isVisible = (dx * dx + dz * dz <= renderDistSq) && mesh.isExposed;
    }
  }

  // Update world block meshes
  setBlock(x, y, z, materialName) {
    const key = `${x},${y},${z}`;
    
    // Clear existing block instance
    if (this.blocks.has(key)) {
      const instance = this.blocks.get(key);
      if (instance) {
        instance.dispose();
      }
      this.blocks.delete(key);
    }
    
    // Create new block instance using hardware instancing
    if (materialName) {
      const baseMesh = this.templateMeshes[materialName];
      if (baseMesh) {
        const instance = baseMesh.createInstance("block_" + key);
        instance.materialName = materialName;
        
        // Custom scale and position adjustment for flowers
        if (materialName.startsWith("flower")) {
          instance.scaling.set(0.4, 0.6, 0.4);
          instance.position.set(x, y - 0.2, z);
          instance.checkCollisions = false;
        } else {
          instance.position.set(x, y, z);
          instance.checkCollisions = true;
        }
        
        instance.isPickable = true;
        instance.alwaysSelectAsActiveMesh = true; // Bypass frustum culling to avoid GPU buffer rebuilds
        instance.computeWorldMatrix(true); // Force compute before freeze
        instance.freezeWorldMatrix(); // Optimize rendering for static blocks
        instance.isExposed = true;
        this.blocks.set(key, instance);
      }
    }
    
    if (!this._isBulkLoading) {
      this.blocksArray = Array.from(this.blocks.values());
      this.updateExposureAround(x, y, z);
      this.updateCulling();
    }
  }

  // Multi-block bulk loading (on connect)
  loadWorld(blocksData) {
    this._isBulkLoading = true;
    
    // 1. Clear all existing blocks first
    for (const [key, mesh] of this.blocks.entries()) {
      if (mesh) mesh.dispose();
    }
    this.blocks.clear();

    // 2. Generate procedural baseline terrain [-24, 24]
    const size = 24;
    for (let x = -size; x <= size; x++) {
      for (let z = -size; z <= size; z++) {
        const h = this.getHeight(x, z);
        for (let y = 0; y <= h; y++) {
          let type = "stone";
          if (y === h) {
            type = "grass";
          } else if (y === h - 1) {
            type = "dirt";
          }
          this.setBlock(x, y, z, type);
        }
        
        // Procedural trees & flowers placement
        const isNearSpawn = Math.abs(x) < 5 && Math.abs(z + 5) < 5;
        if (!isNearSpawn) {
          const treeSeed = getTreeSeed(x, z);
          if (treeSeed < 0.015) { // 1.5% chance for a tree
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
          } else if (treeSeed < 0.06) { // 4.5% chance for a flower
            const flowerType = (Math.floor(treeSeed * 1000) % 2 === 0) ? "flower-red" : "flower-yellow";
            this.setBlock(x, h + 1, z, flowerType);
          }
        }
      }
    }

    // 3. Apply server deltas overlay
    for (const [key, val] of Object.entries(blocksData)) {
      const [xStr, yStr, zStr] = key.split(",");
      const x = parseInt(xStr, 10);
      const y = parseInt(yStr, 10);
      const z = parseInt(zStr, 10);
      
      if (val === null || val.type === null) {
        const hashKey = `${x},${y},${z}`;
        if (this.blocks.has(hashKey)) {
          const instance = this.blocks.get(hashKey);
          if (instance) instance.dispose();
          this.blocks.delete(hashKey);
        }
      } else if (val && val.type) {
        this.setBlock(x, y, z, val.type);
      }
    }

    this._isBulkLoading = false;
    
    // Process single-pass optimizations
    this.blocksArray = Array.from(this.blocks.values());
    
    // Compute exposure for all blocks
    for (const [key, mesh] of this.blocks.entries()) {
      const [x, y, z] = key.split(",").map(Number);
      mesh.isExposed = this.isBlockExposed(x, y, z);
    }
    
    // Run culling update once
    this.updateCulling();

    // Teleport local player to surface on first world load to prevent falling through empty space before server blocks load
    const px = this.camera.position.x;
    const pz = this.camera.position.z;
    const terrainH = this.getHeight(px, pz);
    let highestBlockY = terrainH;
    for (let tempY = 19; tempY > terrainH; tempY--) {
      if (this.blocks.has(`${Math.round(px)},${tempY},${Math.round(pz)}`)) {
        highestBlockY = tempY;
        break;
      }
    }
    this.camera.position.y = highestBlockY + 2.1;
    this.verticalVelocity = 0.0;

    // 4. Update selection octree for high-performance spatial culling
    this.scene.createOrUpdateSelectionOctree();
  }

  // Remote player managers
  updatePlayer(id, username, color, position, rotation) {
    if (!this.otherPlayers.has(id)) {
      this.createPlayerAvatar(id, username, color);
    }

    const player = this.otherPlayers.get(id);
    if (player) {
      player.targetPosition = new Vector3(position.x, position.y, position.z);
      player.targetRotationY = rotation.y;
      
      if (!player.initialized) {
        player.root.position.copyFrom(player.targetPosition);
        player.root.rotation.y = player.targetRotationY;
        player.initialized = true;
      }
      
      if (!player.renderObservable) {
        player.renderObservable = this.scene.onBeforeRenderObservable.add(() => {
          Vector3.LerpToRef(player.root.position, player.targetPosition, 0.15, player.root.position);
          
          let diff = player.targetRotationY - player.root.rotation.y;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;
          player.root.rotation.y += diff * 0.2;
        });
      }
    }
  }

  createPlayerAvatar(id, username, color) {
    const root = new TransformNode("player_root_" + id, this.scene);
    
    // Body box
    const body = MeshBuilder.CreateBox("player_body_" + id, { width: 0.6, height: 1.0, depth: 0.4 }, this.scene);
    body.position.y = 0.5;
    body.parent = root;

    const bodyMat = new StandardMaterial("player_body_mat_" + id, this.scene);
    bodyMat.diffuseColor = Color3.FromHexString(color);
    bodyMat.specularColor = new Color3(0.1, 0.1, 0.1);
    body.material = bodyMat;

    // Head box
    const head = MeshBuilder.CreateBox("player_head_" + id, { width: 0.4, height: 0.4, depth: 0.4 }, this.scene);
    head.position.y = 1.2;
    head.parent = root;

    const headMat = new StandardMaterial("player_head_mat_" + id, this.scene);
    headMat.diffuseColor = new Color3(0.9, 0.8, 0.7); // standard skin-like tone
    headMat.specularColor = new Color3(0.05, 0.05, 0.05);
    head.material = headMat;

    // Name label billboard
    const namePlane = MeshBuilder.CreatePlane("name_plane_" + id, { width: 1.8, height: 0.45 }, this.scene);
    namePlane.position.y = 1.7;
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

  teleportPlayer(x, y, z, rotationY) {
    const terrainH = this.getHeight(x, z);
    let highestBlockY = terrainH;
    for (let tempY = 19; tempY > terrainH; tempY--) {
      if (this.blocks.has(`${Math.round(x)},${tempY},${Math.round(z)}`)) {
        highestBlockY = tempY;
        break;
      }
    }
    this.camera.position.set(x, highestBlockY + 2.1, z);
    if (rotationY !== undefined) {
      this.camera.rotation.y = rotationY;
    }
  }

  dispose() {
    // 1. Remove window event listeners
    if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
    if (this._onKeyDown) window.removeEventListener("keydown", this._onKeyDown);
    if (this._onKeyUp) window.removeEventListener("keyup", this._onKeyUp);
    
    // 2. Remove observers
    if (this._physicsObserver) this.scene.onBeforeRenderObservable.remove(this._physicsObserver);
    if (this._biomeObserver) this.scene.onBeforeRenderObservable.remove(this._biomeObserver);
    if (this._renderObserver) this.scene.onBeforeRenderObservable.remove(this._renderObserver);
    if (this._pointerObserver) this.scene.onPointerObservable.remove(this._pointerObserver);
    
    // 3. Stop rendering loop
    if (this.engine) this.engine.stopRenderLoop();
    
    // 4. Dispose other player avatars
    for (const id of Array.from(this.otherPlayers.keys())) {
      this.removePlayer(id);
    }
    this.otherPlayers.clear();
    
    // 5. Dispose block meshes
    for (const mesh of this.blocks.values()) {
      if (mesh) mesh.dispose();
    }
    this.blocks.clear();
    this.blocksArray = [];
    
    // 6. Dispose template meshes
    for (const name in this.templateMeshes) {
      if (this.templateMeshes[name]) {
        this.templateMeshes[name].dispose();
      }
    }
    this.templateMeshes = {};
    
    // 7. Dispose highlightBox, ground, skySphere
    if (this.highlightBox) this.highlightBox.dispose();
    if (this.ground) this.ground.dispose();
    if (this.skySphere) this.skySphere.dispose();
    
    // 8. Dispose materials and their textures
    for (const name in this.materials) {
      if (this.materials[name]) {
        if (this.materials[name].diffuseTexture) {
          this.materials[name].diffuseTexture.dispose();
        }
        this.materials[name].dispose();
      }
    }
    this.materials = {};
    
    // 9. Dispose scene & engine
    if (this.scene) this.scene.dispose();
    if (this.engine) this.engine.dispose();
  }
}
