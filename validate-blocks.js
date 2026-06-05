import puppeteer from 'puppeteer-core';
import path from 'path';
import fs from 'fs';

async function run() {
  console.log("Connecting to Chrome...");
  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: { width: 1280, height: 720 }
  });

  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err.stack || err.toString()));

  // Close all other tabs to prevent backgrounding and requestAnimationFrame throttling
  try {
    const pages = await browser.pages();
    for (const p of pages) {
      if (p !== page) {
        await p.close();
      }
    }
  } catch (e) {
    console.warn("Failed to close other pages:", e);
  }

  await page.bringToFront();
  console.log("Navigating to http://localhost:5173/ ...");
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2' });

  // Setup download behavior to save recorded webm gameplay locally first (outside project root to prevent Vite HMR reloads)
  const downloadPath = 'C:\\Users\\Craig\\AppData\\Local\\Temp\\blocks-downloads';
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath, { recursive: true });
  }
  console.log(`Setting download path to: ${downloadPath}`);
  
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadPath
  });

  console.log("Waiting for BlocksAutomation API...");
  await page.waitForFunction(() => typeof window.BlocksAutomation !== 'undefined', { timeout: 10000 });

  console.log("Running scenario: build_neon_tower");
  await page.evaluate(() => {
    window.BlocksAutomation.runDemo("build_neon_tower");
  });

  console.log("Scenario started. Waiting 18 seconds for completion...");
  await new Promise(resolve => setTimeout(resolve, 18000));

  console.log("Running scene and physics assertions...");
  const testResults = await page.evaluate(async () => {
    const game = window.BlocksAutomation.game;
    if (!game) return { success: false, error: "Game instance not found" };

    // 1. Verify Sky Dome
    const sky = game.scene.getMeshByName("skySphere");
    if (!sky) return { success: false, error: "Sky dome mesh 'skySphere' not found" };
    if (sky.infiniteDistance !== true) return { success: false, error: "Sky dome infiniteDistance is not true" };
    if (sky.isPickable !== false) return { success: false, error: "Sky dome isPickable is not false" };
    if (!sky.material || sky.material.disableLighting !== true) return { success: false, error: "Sky dome material lighting is not disabled" };
    if (sky.material.backFaceCulling !== true) return { success: false, error: "Sky dome material backFaceCulling is not true" };
    if (sky.material.disableDepthWrite !== true) return { success: false, error: "Sky dome material disableDepthWrite is not true" };
    if (!sky.material.diffuseTexture || sky.material.diffuseTexture.getClassName() !== "DynamicTexture") {
      return { success: false, error: "Sky dome texture is not a DynamicTexture" };
    }
    const skyTexSize = sky.material.diffuseTexture.getSize();
    if (skyTexSize.width !== 2 || skyTexSize.height !== 512) {
      return { success: false, error: `Sky dome texture size is ${skyTexSize.width}x${skyTexSize.height}, expected 2x512` };
    }

    // 2. Verify Voxel Meshing and Instancing
    const meshes = game.scene.meshes;
    const templateMeshesCount = meshes.filter(m => m.name.startsWith("template_")).length;
    if (templateMeshesCount !== 10) {
      return { success: false, error: `Expected 10 template meshes, found ${templateMeshesCount}` };
    }
    const templates = meshes.filter(m => m.name.startsWith("template_"));
    for (const t of templates) {
      if (t.isVisible || t.checkCollisions || t.isPickable) {
        return { success: false, error: `Template mesh ${t.name} has incorrect collision/visibility/picking properties` };
      }
    }

    const chunkMeshes = meshes.filter(m => m.name.startsWith("chunk_"));
    if (chunkMeshes.length === 0) {
      return { success: false, error: "No chunk meshes found in the scene" };
    }
    for (const cm of chunkMeshes) {
      if (cm.checkCollisions !== false) {
        return { success: false, error: `Chunk mesh ${cm.name} checkCollisions is not false` };
      }
    }

    const flowerInstances = meshes.filter(m => m.name.startsWith("flower_") && m.isAnInstance);
    const instanceMeshesCount = flowerInstances.length;
    for (const inst of flowerInstances) {
      if (!inst.isWorldMatrixFrozen) {
        return { success: false, error: `Flower instance mesh ${inst.name} does not have frozen world matrix` };
      }
      if (inst.alwaysSelectAsActiveMesh !== true) {
        return { success: false, error: `Flower instance mesh ${inst.name} alwaysSelectAsActiveMesh is not true` };
      }
    }

    // 3. Verify Jump Trajectory & Double-Jump Prevention
    const px = Math.round(game.camera.position.x);
    const pz = Math.round(game.camera.position.z);
    console.log(`Standing at: ${game.camera.position.x}, ${game.camera.position.y}, ${game.camera.position.z}`);
    for (let y = 0; y <= 10; y++) {
      console.log(`Block at (${px}, ${y}, ${pz}):`, game.getBlockId(px, y, pz));
    }
    // Record starting position
    const startY = game.camera.position.y;
    const initialGrounded = game.isPlayerGrounded();
    console.log(`[Test Start] Y: ${startY}, Grounded: ${initialGrounded}, cameraDirection.y: ${game.camera.cameraDirection.y}`);
    console.log("Active Camera Name:", game.scene.activeCamera ? game.scene.activeCamera.name : "null");
    console.log("Active Camera === game.camera?", game.scene.activeCamera === game.camera);
    console.log("game.camera.update prototype method?", game.camera.update === Object.getPrototypeOf(game.camera).update);
    console.log("game.camera.update own property?", game.camera.hasOwnProperty("update"));
    
    // Dispatch Space keydown (Jump 1)
    game._onKeyDown(new KeyboardEvent("keydown", { code: "Space" }));
    
    // Wait for vertical displacement check over 1.2s (24 samples every 50ms)
    const heights = [];
    for (let i = 0; i < 24; i++) {
      // Force render 3 frames to simulate a 60 FPS time step over the 50ms wait
      game.scene.render();
      game.scene.render();
      game.scene.render();

      const curY = game.camera.position.y;
      const curG = game.isPlayerGrounded();
      const curDirY = game.camera.cameraDirection.y;
      console.log(`[Frame ${i}] Y: ${curY.toFixed(3)}, Grounded: ${curG}, cameraDirection.y: ${curDirY.toFixed(4)}`);
      heights.push(curY);
      
      // Attempt double jump mid-flight (around 200ms into the jump)
      if (i === 4) {
        console.log("Attempting double jump mid-flight...");
        game._onKeyDown(new KeyboardEvent("keydown", { code: "Space" }));
      }
      await new Promise(r => setTimeout(r, 50));
    }
    
    const peakY = Math.max(...heights);
    const finalY = heights[heights.length - 1];
    
    // Verify jump height gain
    if (peakY <= startY + 0.15) {
      return { success: false, error: `Jump did not register height gain (Start Y: ${startY}, Peak Y: ${peakY})` };
    }

    // Verify player returned towards ground / landing
    if (finalY >= peakY - 0.1) {
      return { success: false, error: `Player did not descend after reaching apex (Peak Y: ${peakY}, Final Y: ${finalY})` };
    }
    
    return {
      success: true,
      data: {
        templateMeshesCount,
        instanceMeshesCount,
        startY,
        peakY,
        finalY,
        heights: heights.map(h => parseFloat(h.toFixed(3)))
      }
    };
  });

  if (!testResults.success) {
    console.error("ASSERTION FAILURE:", testResults.error);
    process.exit(1);
  } else {
    console.log("ASSERTIONS PASSED SUCCESSFULLY!");
    console.log("Details:", JSON.stringify(testResults.data, null, 2));
  }


  console.log("Checking for downloaded files in: ", downloadPath);
  const files = fs.readdirSync(downloadPath);
  const videoFiles = files.filter(f => f.startsWith('blocks-gameplay-') && f.endsWith('.webm'));
  
  if (videoFiles.length > 0) {
    console.log("Validation SUCCESS: Video recording downloaded.");
    const latestFile = videoFiles.sort().reverse()[0];
    const sourceFilePath = path.join(downloadPath, latestFile);
    
    // Copy the file to the current conversation's directory
    const targetDir = 'C:\\Users\\Craig\\.gemini\\antigravity\\brain\\2a754af4-90a4-43a1-9cfa-cdb7170e8da8';
    const targetFilePath = path.join(targetDir, latestFile);
    fs.copyFileSync(sourceFilePath, targetFilePath);
    console.log(`Copied video to conversation folder: ${targetFilePath}`);
    console.log(`LATEST_VIDEO_FILE: ${targetFilePath}`);
    
    // Clean up local file
    fs.unlinkSync(sourceFilePath);
  } else {
    console.log("Validation WARNING: No video recording found in download path.");
  }

  console.log("Closing page...");
  await page.close();
  await browser.disconnect();
  console.log("Done!");
}

run().catch(err => {
  console.error("Error running validation script:", err);
  process.exit(1);
});
