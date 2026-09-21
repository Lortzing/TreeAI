/**
 * 品牌类型工具（纯类型，无运行时成本）。
 *
 * TreeAI 领域标识（ForestId/RunId/...）与 Pi 稳定标识（PiSessionId/PiEntryId）
 * 底层都是字符串，但语义不可互换。品牌类型让混用在编译期报错，
 * 同时不引入任何运行时表示差异。
 */
export type Brand<T, B extends string> = T & {
  readonly __brand: B;
};
