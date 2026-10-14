import { ZH_BODY, ZH_SUB, EN_BODY } from "./typography.mjs";

/** B1 fixture definitions pdf-04 through pdf-06; literal build() routines preserved. */
export const FIXTURE_GROUP = [
  /* ------------------------------------------------------------------ */
  {
    id: "pdf-04",
    title: "代码清单：递归版 Fibonacci 与记忆化",
    coverage: ["code"],
    fonts: ["courier", "songti"],
    expectPages: 2,
    build(d) {
      d.heading("代码清单：递归版 Fibonacci 与记忆化", { font: "songti", size: 18, spaceBefore: 0 });
      d.para("下面是一份可以直接运行的 TypeScript 片段。先用朴素的递归实现，再展示记忆化版本，两者恰好构成“指数复杂度到线性复杂度”的对照。代码行保持原始缩进，中文注释行与代码行同处一个清单。", ZH_BODY);
      d.codeBlock([
        { text: "// naive-recursive.ts", indent: 0 },
        { text: "export function fibNaive(n: number): number {", indent: 0 },
        { text: "  // 递归终止条件：n <= 1 时直接返回 n", indent: 2, font: "songti" },
        { text: "  if (n <= 1) return n;", indent: 2 },
        { text: "  return fibNaive(n - 1) + fibNaive(n - 2);", indent: 2 },
        { text: "}", indent: 0 },
        { text: "", indent: 0 },
        { text: "// memoized.ts", indent: 0 },
        { text: "export function fibMemo(n: number, memo = new Map<number, number>()): number {", indent: 0 },
        { text: "  if (n <= 1) return n;", indent: 2 },
        { text: "  const hit = memo.get(n);", indent: 2 },
        { text: "  if (hit !== undefined) return hit;", indent: 2 },
        { text: "  const value = fibMemo(n - 1, memo) + fibMemo(n - 2, memo);", indent: 2 },
        { text: "  memo.set(n, value);", indent: 2 },
        { text: "  return value;", indent: 2 },
        { text: "}", indent: 0 },
      ], { spaceAfter: 10 });
      d.para("朴素版本对每个 n 重复计算子问题，调用树按指数增长；记忆化版本把已算出的答案存进 Map，使每个 n 只真正计算一次。二者代码只差几行，性能却差着数量级，这正是“递归 + 缓存”组合的经典教材案例。", ZH_BODY);
      d.para("值得注意的细节：memo 作为默认参数挂在函数签名里，调用方不需要知道缓存的存在；TypeScript 的类型标注同时约束了键与值的类型。把实现换成数组缓存或 BigInt 版本，接口保持不变。", ZH_BODY);
      d.heading("复杂度对照", ZH_SUB);
      d.codeBlock([
        { text: "fibNaive(35)  // ~ 150 ms   O(2^n)  exponential", indent: 0 },
        { text: "fibMemo(35)   // < 1 ms    O(n)    linear", indent: 0 },
        { text: "fibNaive(20)  // ~ 1 ms    still exponential", indent: 0 },
        { text: "fibMemo(500)  // < 2 ms    linear, fits in double", indent: 0 },
      ], { spaceAfter: 10 });
      d.para("测试时建议把 fibNaive 的参数控制在 35 以内，否则等待时间会明显干扰断言与超时设置。记忆化版本则可以轻松算到 fibMemo(500)，再往上就需要 BigInt 防止精度丢失。", ZH_BODY);
      d.heading("第二条清单：调用栈观察器", ZH_SUB);
      d.para("调试递归时，缩进日志比断点单步高效得多。下面的帮助函数在进入与返回时各打印一行，缩进随深度变化，肉眼即可看到调用树的结构。", ZH_BODY);
      d.codeBlock([
        { text: "export function traced<T>(label: string, depth: number, run: () => T): T {", indent: 0 },
        { text: "  const pad = \"  \".repeat(depth);", indent: 2 },
        { text: "  console.log(`${pad}-> ${label}`);", indent: 2 },
        { text: "  const result = run();", indent: 2 },
        { text: "  console.log(`${pad}<- ${label} = ${String(result)}`);", indent: 2 },
        { text: "  return result;", indent: 2 },
        { text: "}", indent: 0 },
        { text: "// traced(\"fib(4)\", 0, () => fibNaive(4));", indent: 0 },
      ], { spaceAfter: 10 });
      d.para("把 traced 套在 fibNaive 外层即可观察到整棵调用树；套在 fibMemo 外层则会看到树被缓存压扁的过程。同样的观察器也能用在目录遍历与树遍历上，是排查递归逻辑的第一工具。本清单到此收束。", ZH_BODY);
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: "pdf-05",
    title: "重复词样本：递归、递归、递归",
    coverage: ["repeated-words", "zh"],
    fonts: ["songti"],
    expectPages: 2,
    build(d) {
      d.heading("重复词样本：递归、递归、递归", { font: "songti", size: 18, spaceBefore: 0 });
      d.para("这份笔记刻意让“递归”一词反复出现，用来测试选区定位是否真的命中指定的那一处，而不是偷偷退回到第一次出现的位置。递归不是关键词密度的练习，但重复词样本必须如此构造：每次出现都该是一句完整、可读的话。", ZH_BODY);
      d.para("第一处递归出现之后，我们立刻引入第二处递归：递归的可靠性来自归纳，而不是来自祈祷。当递归调用的参数严格向基线条件收敛时，递归是可证明的；当递归参数原地踏步时，递归就是死循环的另一种写法。", ZH_BODY);
      d.para("第三处递归出现在这里。调试递归的技巧是打印缩进：进入函数时输出一段前缀加参数，返回时输出结果。肉眼观察递归的进出节奏，比在调试器里单步两百次有效得多。递归的调用树一旦可视化，理解就完成了一半。", ZH_BODY);
      d.heading("中段：重复词的分布", ZH_SUB);
      d.para("到目前为止，递归出现了不止五次，分布在不同段落、不同页面。选区系统若要支持“第二处、第五处、第八处”这样的定位语义，就必须在这些重复出现之间做出准确区分。本页之后还有更多递归在等待。", ZH_BODY);
      d.para("递归与迭代的互相改写是有边界的：任何尾递归都能机械地改写成循环，但分治型递归（如归并排序）需要显式栈辅助，改写之后可读性往往下降。递归在这里的价值是表达力，不是性能。性能敏感的路径可以先用递归想清楚，再用迭代落地。", ZH_BODY);
      d.para("继续计数：这是又一个自然段里的递归。树遍历、JSON 解析、正则引擎、数据库查询计划，工业界代码里递归的身影远比课堂练习里多。递归并不幼稚，幼稚的是不加终止检查的递归。每一段都在把同一个词放进不同的语境，这正是重复词样本的构造方式。", ZH_BODY);
      d.para("再补一段方法论：阅读陌生的递归函数时，先找基线条件，再找分解点，最后才看返回值如何组合。三步走完，函数的行为就定型了。递归的阅读顺序与书写顺序恰好相反：写的时候先想分解，读的时候先找出口。", ZH_BODY);
      d.para("补充一个观察：团队里最常被争论的不是要不要用递归，而是递归的深度预算给多少。解析用户输入的递归，预算通常是一百层；遍历受控数据结构的递归，预算可以放宽到一万层。预算定下来之后，护栏就该出现在代码里，而不是出现在事后复盘里。递归配上预算，才算是工程决策。", ZH_BODY);
      d.para("重复词样本的构造说明也顺带记录在此：needle 至少出现八次，位置分布在标题、段首、段中与段尾；每一处都必须是完整句子的一部分。递归这个词在这里的密度是刻意的，换到真实笔记里，正常密度大约是每千字一次。", ZH_BODY);
      d.heading("尾段：接近样本的末尾", ZH_SUB);
      d.para("第八处递归大约应该出现在这一页附近。为了让重复词样本更接近真实材料，这里的每句话仍然是完整、有信息量的句子，而不是把同一个词机械堆在一起。递归的学习应当顺着这条线走下去：先信归纳，再读调用栈，最后写一个属于自己的递归小程序。", ZH_BODY);
      d.para("从工程视角再看一眼递归：任何递归实现都应当配一个深度上限或规模护栏，尤其是处理外部输入的解析器。递归下降解析器遇到恶意深嵌套的输入时，没有护栏的递归会把进程直接打穿。递归优雅，防护也不能少。", ZH_BODY);
      d.para("最后再安排两处递归：一句在段首（本句），一句在段尾。样本到此收束，递归的讨论将在长文样本里继续。选区断言若全部命中，说明重复词定位的语义已经闭合。", ZH_BODY);
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: "pdf-06",
    title: "双栏对照：递归与迭代",
    coverage: ["two-column"],
    fonts: ["songti"],
    expectPages: 2,
    build(d) {
      d.heading("双栏对照：递归与迭代", { font: "songti", size: 18, spaceBefore: 0 });
      d.para("本页为双栏排版：左栏讲递归，右栏讲迭代。规范阅读顺序是先读完左栏全部内容，再读右栏，页与页之间同样适用。两栏的宽度一致，起点分别在左带与右带。", ZH_BODY);
      d.setColumns([
        { x: 72, width: 228 },
        { x: 312, width: 228 },
      ]);
      // Page 1, left column
      d.heading("左：递归视角", { font: "songti", size: 13, spaceBefore: 4, spaceAfter: 6 });
      d.para("递归是自顶向下的思考：先声明大问题的答案由小问题的答案组合而成，再把“组合”写成一行代码。递归版本通常更短，因为控制流交给了调用栈，函数体只剩下问题的本质结构。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("递归代码的三个检查点：基线条件是否存在、参数是否严格缩小、返回值组合是否正确。三者齐备，递归就是归纳法；缺一个，递归就是事故。检查点的顺序也有讲究：先确认出口，再确认收敛，最后核对组合。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("递归最自然的舞台是树形结构：文件系统、DOM、抽象语法树。在树上，递归的形状与数据的形状同构，改写成循环反而别扭。树的递归遍历几乎是默认解，这一点在任何语言里都成立。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("性能方面，递归的每层调用都有栈帧开销，深度受限；重复子问题若不缓存，复杂度可能爆炸。递归不是免费的抽象，它是用栈空间换表达力的交易。深度可达百万的场景，这笔交易不划算。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("递归的可读性优势在回溯搜索里最明显：八皇后、数独求解、正则匹配，回溯框架天然是递归的。尝试、递归、撤销三步曲写成递归一目了然，写成显式栈则处处是脚手架。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("左栏小结：递归把“如何组合子答案”放在聚光灯下，把“如何调度子问题”交给运行时。它买来的是思维的经济性，代价是栈与深度的约束。右栏将给出镜像的论述。", { ...ZH_BODY, spaceAfter: 6 });
      // Column break: the left column ends here on purpose; the iteration
      // section starts at the top of the right band (two-column semantics).
      d.columnBreak();
      // Page 1, right column
      d.heading("右：迭代视角", { font: "songti", size: 13, spaceBefore: 4, spaceAfter: 6 });
      d.para("迭代是自底向上的推进：从最小的已知情形出发，用循环变量把答案一路滚到目标规模。迭代版本通常更长，但每一步都摊在纸面上，状态转移清晰可见。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("迭代代码的三个检查点：初始状态是否正确、每轮推进是否保持不变量、终止条件是否可达。这与递归的检查点一一对应，只是叙述方向相反：递归谈出口，迭代谈终点。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("迭代最自然的舞台是线性结构：数组、链表、计数循环。在顺序数据上，循环语句与数据的形状同构。滑动窗口、双指针、前缀和，全部以迭代为第一形态。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("性能方面，迭代没有调用栈负担，深度不受语言限制，缓存局部性也更好。代价是表达分治时需要手工维护显式栈，并且循环不变量往往比递归假设更难一眼验证。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("迭代的可读性优势在状态机里最明显：词法分析、协议解析、游戏循环。状态转移写成 while 加 switch，配合一张状态表，任何人都能按图索骥。同样的逻辑硬写递归，反而要绕一层解释。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("右栏小结：迭代把“状态如何推进”放在聚光灯下，调度成本为零。它买来的是确定性的资源画像，代价是把结构性的美让位给工程性的稳。两栏合起来才是完整的工具箱。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("第二页继续用同样的双栏结构，讨论互相改写的具体手法与各自的边界条件。", { ...ZH_BODY, spaceAfter: 6 });
      // Page 2, left column
      d.heading("改写手法（左）", { font: "songti", size: 13, spaceBefore: 4, spaceAfter: 6 });
      d.para("递归转迭代的第一步是识别尾位置：若递归调用是最后动作，直接换成 while 循环累积结果即可。阶乘、累加、链表反转的尾递归版都能这样机械转换，转换后行为完全等价。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("分治型递归则需要把子任务压进显式栈，用循环模拟调度：弹出一个任务，若可直接求解则求解，否则把更小的子任务压回栈中。归并排序的迭代版就是这个套路，只是循环体取代了调用栈。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("改写完成后，务必用同一组测试对照两种实现：递归版本负责当参照系，迭代版本负责通过性能门槛。只改不测的改写不算完成，边界输入尤其要覆盖：空输入、单元素、以及触发最大深度的极端规模。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("实践中更常见的选择是混合：外层用迭代控制轮次，内层用递归处理树形子结构。编译器、构建工具、打包器几乎都是这种混合体。双栏样本的左栏到此完成它的排版使命。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("左栏末句：递归的深处自有秩序，秩序的名字叫归纳。", { ...ZH_BODY, spaceAfter: 6 });
      d.columnBreak();
      // Page 2, right column
      d.heading("改写手法（右）", { font: "songti", size: 13, spaceBefore: 4, spaceAfter: 6 });
      d.para("迭代转递归是逆操作：把循环变量变成函数参数，把不变量写进递归假设，把终止条件改称基线条件。机械但可靠，常用于教学演示，也用于给老代码补形式化的解释。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("注意语言边界：没有尾调用优化的运行时里，深层递归仍会爆栈，此时迭代不仅是风格选择，而是必要条件。JavaScript 正属于此类，ES2015 的尾调用规范至今没有主流实现。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("混合形态在右栏同样成立：以迭代驱动主循环，遇到嵌套结构就切换到局部递归。数据库的查询计划求值器、序列化框架的深拷贝，都是这种写法的受益者。", { ...ZH_BODY, spaceAfter: 6 });
      d.para("最后一句留给右栏：迭代的前方步步为营，每一步都踩在不变量上。双栏对照样本到此全部收束，感谢逐栏读完的你。", { ...ZH_BODY, spaceAfter: 6 });
    },
  },


];
