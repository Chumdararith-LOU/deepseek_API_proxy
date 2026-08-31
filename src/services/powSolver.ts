/*
 * File: powSolver.ts
 * Proof-of-work solver for DeepSeek's chat completion endpoint.
 *
 * DeepSeek gates `POST /api/v0/chat/completion` behind a proof-of-work header
 * (`x-ds-pow-response`). The PoW algorithm ("DeepSeekHashV1") is shipped as a
 * WebAssembly module the website loads from its own CDN
 * (fe-static.deepseek.com/.../sha3_wasm_bg.wasm). Rather than reimplement its
 * exact float64 hashing logic, we run DeepSeek's own module — the same code the
 * browser runs — inside the WASM environment.
 */

export interface PowChallenge {
  salt: string;
  expire_at: number;
  difficulty: number;
  challenge: string;
  algorithm: string;
  signature: string;
  target_path?: string;
}

class DeepSeekPowSolver {
  private _inst: WebAssembly.Instance | null = null;
  private _memory: WebAssembly.Memory | null = null;
  private _solve: Function | null = null;
  private _malloc: Function | null = null;
  private _add_to_stack: Function | null = null;

  constructor() {
    // WASM module is loaded on first use
    console.log("PoW solver initialized");
  }

  /**
   * Initializes the WebAssembly module and extracts required exports
   * This function should be called before solving any challenges.
   */
  async initialize(): Promise<void> {
    if (this._inst !== null) return; // Already initialized

    try {
      const wasmPath = "./deepseek/sha3_wasm_bg.wasm";
      const wasmBytes = await Bun.file(wasmPath).arrayBuffer();
      const wasmModule = new WebAssembly.Module(wasmBytes);
      const wasmInstance = new WebAssembly.Instance(wasmModule, {});

      // Extract required exports
      this._inst = wasmInstance;
      this._memory = wasmInstance.exports.memory as WebAssembly.Memory;
      this._solve = wasmInstance.exports.wasm_solve as Function;
      this._malloc = wasmInstance.exports.__wbindgen_export_0 as Function;
      this._add_to_stack = wasmInstance.exports.__wbindgen_add_to_stack_pointer as Function;

      console.log("PoW solver WASM module initialized successfully");
    } catch (error) {
      console.error("Failed to initialize PoW solver WASM module:", error);
      throw new Error("Could not load WebAssembly module for PoW solver");
    }
  }

  /**
   * Allocates memory in the WASM module and copies a UTF-8 string into it
   * Returns [pointer, length] tuple
   */
  private _writeStr(text: string): [number, number] {
    if (!this._malloc || !this._memory) {
      throw new Error("WASM module not initialized");
    }

    const data = new TextEncoder().encode(text);
    const ptr = this._malloc(data.byteLength, 1); // malloc(size, align)
    const base = new Uint8Array(this._memory.buffer);

    for (let i = 0; i < data.byteLength; i++) {
      base[ptr + i] = data[i];
    }

    return [ptr, data.byteLength];
  }

  /**
   * Solves a PoW challenge by finding a nonce that produces a hash with the required difficulty.
   * Returns the nonce if successful, or null if no solution is found.
   */
  async solve(challenge: string, prefix: string, difficulty: number): Promise<number | null> {
    // Ensure WASM module is initialized
    await this.initialize();

    if (!this._solve || !this._memory || !this._add_to_stack) {
      throw new Error("Required WASM exports not found");
    }

    // Allocate 16-byte return slot on the shadow stack - mimics Python wasmtime pattern
    const retptr = this._add_to_stack(-16);

    try {
      const [c_ptr, c_len] = this._writeStr(challenge);
      const [p_ptr, p_len] = this._writeStr(prefix);

      // Call wasm_solve according to expected signature:
      // wasm_solve(retptr, challenge_ptr, challenge_len, prefix_ptr, prefix_len, difficulty)
      this._solve(retptr, c_ptr, c_len, p_ptr, p_len, difficulty);

      // Read result from memory - status at +0, answer at +8 (16 bytes total)
      const mem = new Uint8Array(this._memory.buffer);
      const status = new Int32Array(mem.buffer, retptr, 1)[0];

      if (status === 0) {
        return null; // No solution found
      }

      // Read the actual answer from +8 bytes offset
      const value = new Float64Array(mem.buffer, retptr + 8, 1)[0];
      return Math.floor(value);
    } finally {
      // Clean up stack pointer
      this._add_to_stack(16);
    }
  }

  /**
   * Build the base64 `x-ds-pow-response` header value from a challenge dict.
   */
  async makeHeader(challenge: PowChallenge): Promise<string> {
    const prefix = `${challenge.salt}_${challenge.expire_at}_`;
    const answer = await this.solve(challenge.challenge, prefix, challenge.difficulty);

    if (answer === null) {
      throw new Error("PoW solver returned no answer (challenge expired?)");
    }

    const payload = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer: answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    };

    return Buffer.from(JSON.stringify(payload)).toString("base64");
  }
}

// Export the solver instance
export const powSolver = new DeepSeekPowSolver();
