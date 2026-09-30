/**
 * D4-8 大规模树导航 —— 确定性 PRNG（b6/b9 冻结规格的「同 b6 规则」实现）。
 *
 * 规格（tests/fixtures/d4/b9-nav/spec.json → determinism.prng）：
 * 「每个生成步骤使用以 seed + 步骤名初始化的确定性 PRNG（如 xorshift128+
 * 或 node:crypto 的 createHash 派生序列），禁止 Math.random() 与时间戳」。
 *
 * 实现：xorshift128（Marsaglia 32 位 × 4 字状态）。状态由
 * SHA-256(`${seed}:${step}`) 派生为四个 32 位字（全零状态按规格拒绝——
 * SHA-256 派生下实际不可达，防御性保留）。因此：
 *  - 同一 (seed, step) 永远产出同一序列；不同 step 互相独立；
 *  - 以实体 id 嵌入 step（如 `answer:b9-big-n0007`）时，单条派生值与
 *    生成顺序无关——结构真值的每一片段都可独立复算；
 *  - 全部输出为 32 位无符号整数及其确定性派生（区间整数/概率/选取），
 *    无浮点舍入路径，无 Math.random()，无时间戳。
 */

import { createHash } from "node:crypto";

/** 32 位无符号乘法（xorshift 内部位运算辅助）。 */
function u32(x: number): number {
  return x >>> 0;
}

/** 确定性随机数发生器（xorshift128；seed + 步骤名派生状态）。 */
export class DeterministicRng {
  readonly seed: string;
  readonly step: string;
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;
  #drawn: number;

  private constructor(seed: string, step: string, words: readonly [number, number, number, number]) {
    this.seed = seed;
    this.step = step;
    this.#s0 = words[0];
    this.#s1 = words[1];
    this.#s2 = words[2];
    this.#s3 = words[3];
    this.#drawn = 0;
  }

  /** 以 seed + 步骤名初始化（状态 = SHA-256(seed:step) 的前 16 字节按大端切 4 字）。 */
  static forStep(seed: string, step: string): DeterministicRng {
    const digest = createHash("sha256").update(`${seed}:${step}`, "utf8").digest();
    const words: [number, number, number, number] = [
      digest.readUInt32BE(0),
      digest.readUInt32BE(4),
      digest.readUInt32BE(8),
      digest.readUInt32BE(12),
    ];
    if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0) {
      // 防御性拒绝零状态（SHA-256 派生下不可达）；换第 17..20 字节重派生。
      const fallback: [number, number, number, number] = [
        digest.readUInt32BE(16),
        digest.readUInt32BE(20),
        digest.readUInt32BE(24),
        digest.readUInt32BE(28),
      ];
      return new DeterministicRng(seed, step, fallback);
    }
    return new DeterministicRng(seed, step, words);
  }

  /** 下一个 32 位无符号整数（xorshift128 核心步进）。 */
  nextUint32(): number {
    let t = this.#s3;
    this.#s3 = this.#s2;
    this.#s2 = this.#s1;
    this.#s1 = this.#s0;
    t = u32(t ^ (t << 11));
    t = u32(t ^ (t >>> 8));
    this.#s0 = u32(t ^ this.#s0 ^ (this.#s0 >>> 19));
    this.#drawn += 1;
    return this.#s0;
  }

  /** 已抽取的 32 位字数（诊断/测试用；确定性派生量）。 */
  get drawn(): number {
    return this.#drawn;
  }

  /** [minInclusive, maxInclusive] 内的确定性整数（无偏拒绝采样）。 */
  int(minInclusive: number, maxInclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxInclusive)) {
      throw new Error(`DeterministicRng.int: bounds must be integers (${String(minInclusive)}..${String(maxInclusive)})`);
    }
    if (maxInclusive < minInclusive) {
      throw new Error(`DeterministicRng.int: empty range ${String(minInclusive)}..${String(maxInclusive)}`);
    }
    const span = maxInclusive - minInclusive + 1;
    if (span > 0x100000000) {
      throw new Error(`DeterministicRng.int: range too wide (${String(span)})`);
    }
    if (span === 0x100000000) {
      // 全域 2^32：任何 32 位值都合法，无需拒绝采样。
      return minInclusive + this.nextUint32();
    }
    // 拒绝采样消除模偏：丢弃落在最后一个不完整桶里的值。
    const buckets = Math.floor(0x100000000 / span);
    const limit = buckets * span;
    for (;;) {
      const value = this.nextUint32();
      if (value < limit) {
        return minInclusive + (value % span);
      }
    }
  }

  /** 以概率 1/n 为真（确定性；n ≥ 1）。 */
  oneIn(n: number): boolean {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`DeterministicRng.oneIn: n must be a positive integer (got ${String(n)})`);
    }
    if (n === 1) return true;
    return this.int(1, n) === 1;
  }

  /** 从非空数组确定性选取一个元素。 */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error("DeterministicRng.pick: items must be non-empty");
    }
    return items[this.int(0, items.length - 1)]!;
  }
}
