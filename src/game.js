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
  Mesh
} from "@babylonjs/core";

export class Game {
  constructor(canvasId, onBlockChange) {
    this.canvas = document.getElementById(canvasId);
    this.onBlockChange = onBlockChange; // callback(x, y, z, materialName | null)
    
    // Core engine & scene
    this.engine = new Engine(this.canvas, true);
    this.scene = new Scene(this.engine);
    
    // Configs
    this.activeMaterial = "grass";
    this.blocks = new Map(); // key ("x,y,z") -> Mesh
    this.otherPlayers = new Map(); // id -> { root, body, head, label }
    
    this.initScene();
    this.initLights();
    this.initGround();
    this.initMaterials();
    this.initPlayerCamera();
    this.initHighlight();
    this.initInteraction();
    
    // Handle window resize
    window.addEventListener("resize", () => {
      this.engine.resize();
    });

    // Start rendering loop
    this.engine.runRenderLoop(() => {
      this.scene.render();
    });
  }

  initScene() {
    // Enable collisions & gravity
    this.scene.collisionsEnabled = true;
    this.scene.gravity = new Vector3(0, -0.4, 0); // moderate gravity
    
    // Clean background / ambient color
    this.scene.clearColor = new Color3(0.02, 0.04, 0.1); // dark space blue
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
  }

  initGround() {
    // Create a large flat ground plane just below block coordinate zero (y = -0.5)
    this.ground = MeshBuilder.CreateGround("ground", { width: 100, height: 100 }, this.scene);
    this.ground.position.y = -0.5;
    this.ground.checkCollisions = true;

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

  initMaterials() {
    this.materials = {};

    // 1. Grass
    const grass = new StandardMaterial("mat_grass", this.scene);
    grass.diffuseColor = new Color3(0.06, 0.72, 0.34); // Active green
    grass.specularColor = new Color3(0.05, 0.05, 0.05);
    this.materials["grass"] = grass;

    // 2. Dirt
    const dirt = new StandardMaterial("mat_dirt", this.scene);
    dirt.diffuseColor = new Color3(0.47, 0.21, 0.06); // Warm brown
    dirt.specularColor = new Color3(0, 0, 0);
    this.materials["dirt"] = dirt;

    // 3. Wood
    const wood = new StandardMaterial("mat_wood", this.scene);
    wood.diffuseColor = new Color3(0.85, 0.47, 0.02); // Rich amber wood
    wood.specularColor = new Color3(0.05, 0.05, 0.05);
    this.materials["wood"] = wood;

    // 4. Stone
    const stone = new StandardMaterial("mat_stone", this.scene);
    stone.diffuseColor = new Color3(0.61, 0.64, 0.69); // Slate grey
    stone.specularColor = new Color3(0.1, 0.1, 0.1);
    this.materials["stone"] = stone;

    // 5. Glass
    const glass = new StandardMaterial("mat_glass", this.scene);
    glass.diffuseColor = new Color3(0.7, 0.9, 1.0); // Translucent blue-cyan
    glass.alpha = 0.45;
    glass.specularColor = new Color3(0.5, 0.5, 0.5);
    this.materials["glass"] = glass;

    // 6. Neon Red
    const neonRed = new StandardMaterial("mat_neon_red", this.scene);
    neonRed.diffuseColor = new Color3(0.96, 0.25, 0.38); // Rose red
    neonRed.emissiveColor = new Color3(0.8, 0.15, 0.25); // Glowing Red
    neonRed.specularColor = new Color3(0.1, 0.1, 0.1);
    this.materials["neon-red"] = neonRed;

    // 7. Neon Blue
    const neonBlue = new StandardMaterial("mat_neon_blue", this.scene);
    neonBlue.diffuseColor = new Color3(0.02, 0.71, 0.83); // Cyan
    neonBlue.emissiveColor = new Color3(0.01, 0.45, 0.6); // Glowing Cyan
    neonBlue.specularColor = new Color3(0.1, 0.1, 0.1);
    this.materials["neon-blue"] = neonBlue;
  }

  initPlayerCamera() {
    // Set up FPS camera
    this.camera = new UniversalCamera("playerCam", new Vector3(0, 1.5, -5), this.scene);
    this.camera.setTarget(new Vector3(0, 1.5, 0));
    this.camera.attachControl(this.canvas, true);

    // WASD and arrow key bindings for walking
    this.camera.keysUp.push(87);    // W
    this.camera.keysDown.push(83);  // S
    this.camera.keysLeft.push(65);  // A
    this.camera.keysRight.push(68); // D

    // Enable player physics / size
    this.camera.checkCollisions = true;
    this.camera.applyGravity = true;
    
    // Player size hitbox (height is approx 1.8 units, width is 0.8 units)
    this.camera.ellipsoid = new Vector3(0.4, 0.9, 0.4);
    this.camera.ellipsoidOffset = new Vector3(0, 0.1, 0);

    // Prevent camera zooming/looking under ground
    this.camera.minZ = 0.1;
  }

  initHighlight() {
    // Wireframe cube overlay to show which block is targeted
    this.highlightBox = MeshBuilder.CreateBox("highlightBox", { size: 1.02 }, this.scene);
    
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
    this.scene.onBeforeRenderObservable.add(() => {
      const pickInfo = this.scene.pick(
        this.engine.getRenderWidth() / 2,
        this.engine.getRenderHeight() / 2
      );

      if (pickInfo.hit && pickInfo.distance < 6 && (pickInfo.pickedMesh === this.ground || pickInfo.pickedMesh.name.startsWith("block_"))) {
        const normal = pickInfo.getNormal(true);
        
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
        
        this.highlightBox.position.set(x, y, z);
        this.highlightBox.isVisible = true;
      } else {
        this.highlightBox.isVisible = false;
      }
    });

    // Pointer clicks
    this.scene.onPointerObservable.add((pointerInfo) => {
      // 0: left click, 2: right click
      const isLeft = pointerInfo.event.button === 0;
      const isRight = pointerInfo.event.button === 2;
      
      if (!isLeft && !isRight) return;

      const pickInfo = this.scene.pick(
        this.engine.getRenderWidth() / 2,
        this.engine.getRenderHeight() / 2
      );

      // Verify we picked something close enough (max 6 units range)
      if (pickInfo.hit && pickInfo.distance < 6) {
        const mesh = pickInfo.pickedMesh;
        const normal = pickInfo.getNormal(true);

        if (isLeft) {
          // Left Click: Delete Block
          if (mesh && mesh !== this.ground && mesh.name.startsWith("block_")) {
            const pos = mesh.position;
            this.onBlockChange(pos.x, pos.y, pos.z, null);
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
            x = Math.round(pos.x + normal.x);
            y = Math.round(pos.y + normal.y);
            z = Math.round(pos.z + normal.z);
          }

          // Bound placement range to prevent building out of bounds or in player face
          if (y >= 0 && y < 20 && Math.abs(x) < 50 && Math.abs(z) < 50) {
            // Check if player would collide with placing block
            const camPos = this.camera.position;
            const distToBlock = Vector3.Distance(new Vector3(x, y, z), camPos);
            // Player height spans roughly camPos.y - 1.2 to camPos.y + 0.2. Prevent blocking player body
            const horizontalDist = Math.sqrt(Math.pow(camPos.x - x, 2) + Math.pow(camPos.z - z, 2));
            const verticalDist = camPos.y - y;

            if (horizontalDist < 0.7 && verticalDist > -0.5 && verticalDist < 1.3) {
              // Too close to player body, skip placing
              return;
            }

            this.onBlockChange(x, y, z, this.activeMaterial);
          }
        }
      }
    });

    // Spacebar triggers camera jump (using standard Babylon camera check)
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        // Simple jump calculation: if camera is touching ground
        // Note: UniversalCamera applyGravity handles falling, we can nudge y upwards if camera isn't falling quickly
        // A simple jump physics: check camera y coordinate offset
        // We'll simulate a jump by setting camera position slightly up or velocity if physics was active.
        // For standard camera collisions, adding a momentary impulse works by modifying position directly:
        // We ensure player is close to a block/ground (relative y coordinate is near integer or ground).
        // Let's do a simple raycast downwards to see if we are standing on a mesh.
        const ray = new BABYLON.Ray(this.camera.position, new Vector3(0, -1, 0), 1.6);
        const pick = this.scene.pickWithRay(ray);
        if (pick.hit) {
          // Jump impulse: modify camera position upwards quickly, gravity will pull us back down
          this.camera.position.y += 0.8;
        }
      }
    });
  }

  // Material selection from hotbar
  selectMaterial(materialName) {
    if (this.materials[materialName]) {
      this.activeMaterial = materialName;
    }
  }

  // Update world block meshes
  setBlock(x, y, z, materialName) {
    const key = `${x},${y},${z}`;
    
    // Clear existing block
    if (this.blocks.has(key)) {
      const mesh = this.blocks.get(key);
      mesh.dispose();
      this.blocks.delete(key);
    }
    
    // Create new block
    if (materialName) {
      const mesh = MeshBuilder.CreateBox("block_" + key, { size: 1.0 }, this.scene);
      mesh.position.set(x, y, z);
      mesh.checkCollisions = true;
      mesh.material = this.materials[materialName];
      
      this.blocks.set(key, mesh);
    }
  }

  // Multi-block bulk loading (on connect)
  loadWorld(blocksData) {
    // Clear all existing blocks first
    for (const [key, mesh] of this.blocks.entries()) {
      mesh.dispose();
    }
    this.blocks.clear();

    // Spawn new ones
    for (const [key, val] of Object.entries(blocksData)) {
      const [xStr, yStr, zStr] = key.split(",");
      const x = parseInt(xStr, 10);
      const y = parseInt(yStr, 10);
      const z = parseInt(zStr, 10);
      
      if (val && val.type) {
        this.setBlock(x, y, z, val.type);
      }
    }
  }

  // Remote player managers
  updatePlayer(id, username, color, position, rotation) {
    if (!this.otherPlayers.has(id)) {
      this.createPlayerAvatar(id, username, color);
    }

    const player = this.otherPlayers.get(id);
    if (player) {
      // Direct update for simple rendering, or lerp in rendering loop
      // Let's store target position/rotation for smooth interpolation
      player.targetPosition = new Vector3(position.x, position.y, position.z);
      player.targetRotationY = rotation.y;
      
      // If first position, snap immediately
      if (!player.initialized) {
        player.root.position.copyFrom(player.targetPosition);
        player.root.rotation.y = player.targetRotationY;
        player.initialized = true;
      }
      
      // Update lerp loop (registered inside scene)
      if (!player.renderObservable) {
        player.renderObservable = this.scene.onBeforeRenderObservable.add(() => {
          player.root.position = Vector3.Lerp(player.root.position, player.targetPosition, 0.15);
          
          // Interpolate rotation
          let diff = player.targetRotationY - player.root.rotation.y;
          // Normalize rotation difference
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
}
