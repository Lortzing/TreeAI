/**
 * 编译期类型断言工具（仅测试使用，非契约导出面）。
 */
export type Expect<T extends true> = T;

/** 严格双向相等（比 extends 更严：能区分 Brand 与底层类型）。 */
export type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

export type NotEqual<X, Y> = Equal<X, Y> extends true ? false : true;
