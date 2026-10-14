/** Original material/text range implementations, with a fresh constructor per suite. */
interface RangeDocument<N, E> {
 root: E | null;
 flattenedText(): string;
 textStartOf(node: N): number;
 subtreeTextLength(node: N): number;
}
export function createStubRange<TNode extends { parentElement: TElement | null }, TElement extends TNode & { children: TNode[] }, TText extends TNode>(Text: new (data: string) => TText) {
class StubRange {
  private readonly doc: RangeDocument<TNode, TElement>;
  startContainer: TNode;
  startOffset: number;
  endContainer: TNode;
  endOffset: number;

  constructor(
    doc: RangeDocument<TNode, TElement>,
    startContainer: TNode,
    startOffset: number,
    endContainer: TNode,
    endOffset: number,
  ) {
    this.doc = doc;
    this.startContainer = startContainer;
    this.startOffset = startOffset;
    this.endContainer = endContainer;
    this.endOffset = endOffset;
  }

  get commonAncestorContainer(): TNode {
    const startPath: TNode[] = [];
    let cur: TNode | null = this.startContainer;
    while (cur !== null) {
      startPath.push(cur);
      cur = cur.parentElement;
    }
    let end: TNode | null = this.endContainer;
    while (end !== null) {
      if (startPath.includes(end)) return end;
      end = end.parentElement;
    }
    return this.doc.root!;
  }

  cloneRange(): StubRange {
    return new StubRange(this.doc, this.startContainer, this.startOffset, this.endContainer, this.endOffset);
  }

  selectNodeContents(element: TElement): void {
    this.startContainer = element;
    this.startOffset = 0;
    this.endContainer = element;
    this.endOffset = element.children.length;
  }

  setEnd(container: TNode, offset: number): void {
    this.endContainer = container;
    this.endOffset = offset;
  }

  toString(): string {
    const from = this.documentPosition(this.startContainer, this.startOffset);
    const to = this.documentPosition(this.endContainer, this.endOffset);
    return this.doc.flattenedText().slice(Math.min(from, to), Math.max(from, to));
  }

  /** 边界 → 全文档扁平文本位置：文本节点 = 节点文本起点 + offset；元素
      offset k = 前 k 个子树的文本之后（0 = 子树起点，children.length =
      子树终点——selectNodeContents 的两处用法）。 */
  private documentPosition(container: TNode, offset: number): number {
    if (container instanceof Text) {
      return this.doc.textStartOf(container) + offset;
    }
    let position = this.doc.textStartOf(container);
    for (let i = 0; i < offset && i < (container as unknown as TElement).children.length; i += 1) {
      position += this.doc.subtreeTextLength((container as unknown as TElement).children[i]!);
    }
    return position;
  }
}
 return StubRange;
}
export function createStubTextRange<TNode, TText extends TNode & { data: string }, TElement>() {
class StubTextRange {
  private start: number;
  private end: number;
  private readonly textNode: TText;

  constructor(textNode: TText, start: number, end: number) {
    this.textNode = textNode;
    this.start = start;
    this.end = end;
  }

  get commonAncestorContainer(): TText {
    return this.textNode;
  }

  get startContainer(): TText {
    return this.textNode;
  }

  get startOffset(): number {
    return this.start;
  }

  selectNodeContents(element: TElement): void {
    void element; /* 覆盖元素全部内容 = 整个文本节点（场景内即真实用法） */
    this.start = 0;
    this.end = this.textNode.data.length;
  }

  setEnd(container: TNode, offset: number): void {
    const ownNode: TNode = this.textNode;
    if (container !== ownNode) {
      throw new Error("StubTextRange.setEnd: container must be the range's own text node");
    }
    this.end = offset;
  }

  toString(): string {
    const from = Math.min(this.start, this.end);
    const to = Math.max(this.start, this.end);
    return this.textNode.data.slice(from, to);
  }

  cloneRange(): StubTextRange {
    return new StubTextRange(this.textNode, this.start, this.end);
  }
}
 return StubTextRange;
}
