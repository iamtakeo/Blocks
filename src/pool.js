import { Vector3, Color3 } from "@babylonjs/core";

/**
 * A highly optimized, safe pool for Vector3 objects.
 * Designed to minimize GC pressure on low-end devices.
 */
class Vector3PoolInstance {
  constructor(initialSize = 100) {
    this._pool = [];
    this._activeSet = new Set(); // Tracks active vectors for double-release checks and leak detection
    this.debugMode = false; // Enables safety checks

    // Pre-allocate instances
    for (let i = 0; i < initialSize; i++) {
      this._pool.push(new Vector3(0, 0, 0));
    }
  }

  /**
   * Acquires a Vector3 from the pool, initialized to the given coordinates.
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   * @returns {Vector3}
   */
  acquire(x = 0, y = 0, z = 0) {
    let vec;
    if (this._pool.length > 0) {
      vec = this._pool.pop();
      vec.set(x, y, z);
    } else {
      // Dynamic expansion if pool is exhausted
      vec = new Vector3(x, y, z);
      if (this.debugMode) {
        console.warn("Vector3Pool: Pool exhausted. Dynamic allocation occurred.");
      }
    }

    if (this.debugMode) {
      this._activeSet.add(vec);
    }
    return vec;
  }

  /**
   * Releases a Vector3 back into the pool.
   * @param {Vector3} vec 
   */
  release(vec) {
    if (!vec) return;

    if (this.debugMode) {
      if (!this._activeSet.has(vec)) {
        console.error("Vector3Pool: Attempted to release a Vector3 that is not active or already released!", vec);
        return;
      }
      this._activeSet.delete(vec);
    }

    if (this._pool.includes(vec)) return;

    // Reset properties to default state
    vec.set(0, 0, 0);
    this._pool.push(vec);
  }

  /**
   * Helper to copy values from a source Vector3 to a pooled instance.
   * @param {Vector3} source 
   * @returns {Vector3}
   */
  acquireCopy(source) {
    return this.acquire(source.x, source.y, source.z);
  }

  /**
   * Get metrics for performance auditing
   */
  getMetrics() {
    return {
      poolSize: this._pool.length,
      activeCount: this._activeSet.size,
    };
  }
}

/**
 * A highly optimized, safe pool for Color3 objects.
 */
class Color3PoolInstance {
  constructor(initialSize = 50) {
    this._pool = [];
    this._activeSet = new Set();
    this.debugMode = false;

    for (let i = 0; i < initialSize; i++) {
      this._pool.push(new Color3(0, 0, 0));
    }
  }

  /**
   * Acquires a Color3 from the pool, initialized to r, g, b.
   * @param {number} r 
   * @param {number} g 
   * @param {number} b 
   * @returns {Color3}
   */
  acquire(r = 0, g = 0, b = 0) {
    let color;
    if (this._pool.length > 0) {
      color = this._pool.pop();
      color.set(r, g, b);
    } else {
      color = new Color3(r, g, b);
      if (this.debugMode) {
        console.warn("Color3Pool: Pool exhausted. Dynamic allocation occurred.");
      }
    }

    if (this.debugMode) {
      this._activeSet.add(color);
    }
    return color;
  }

  /**
   * Acquires a Color3 and populates it from a Hex color string without allocations.
   * @param {string} hex 
   * @returns {Color3}
   */
  acquireFromHex(hex) {
    const color = this.acquire(0, 0, 0);
    this.hexToColor3(hex, color);
    return color;
  }

  /**
   * Releases a Color3 back into the pool.
   * @param {Color3} color 
   */
  release(color) {
    if (!color) return;

    if (this.debugMode) {
      if (!this._activeSet.has(color)) {
        console.error("Color3Pool: Attempted to release a Color3 that is not active or already released!", color);
        return;
      }
      this._activeSet.delete(color);
    }

    if (this._pool.includes(color)) return;

    color.set(0, 0, 0);
    this._pool.push(color);
  }

  /**
   * Parses a Hex color string directly into a target Color3, preventing GC allocations.
   * @param {string} hex 
   * @param {Color3} targetColor3 
   * @returns {Color3}
   */
  hexToColor3(hex, targetColor3) {
    let h = hex;
    if (h.startsWith("#")) h = h.slice(1);
    
    let r = 0, g = 0, b = 0;
    if (h.length === 3) {
      r = parseInt(h[0] + h[0], 16) / 255;
      g = parseInt(h[1] + h[1], 16) / 255;
      b = parseInt(h[2] + h[2], 16) / 255;
    } else if (h.length === 6) {
      r = parseInt(h.slice(0, 2), 16) / 255;
      g = parseInt(h.slice(2, 4), 16) / 255;
      b = parseInt(h.slice(4, 6), 16) / 255;
    }
    
    targetColor3.set(r, g, b);
    return targetColor3;
  }

  getMetrics() {
    return {
      poolSize: this._pool.length,
      activeCount: this._activeSet.size,
    };
  }
}

// Singletons for global usage
export const Vector3Pool = new Vector3PoolInstance(100);
export const Color3Pool = new Color3PoolInstance(50);
