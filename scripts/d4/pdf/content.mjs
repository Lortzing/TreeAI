/**
 * D4 PDF fixture generator — fixture content definitions (B1 acceptance set).
 *
 * Every fixture carries real, meaningful bilingual programming/learning notes
 * (TreeAI's content theme). Content is pure data + a per-fixture build()
 * driving the shared LayoutDoc flow engine; nothing here hand-writes offsets
 * or canonical text — that is always derived by layout + the pinned reading
 * order.
 *
 * Font roles used by fixtures:
 *   songti  CID subset of /System/Library/Fonts/Supplemental/Songti.ttc (#0)
 *   stheiti CID subset of /System/Library/Fonts/STHeiti Light.ttc (#0)
 *           (combining marks, Ext-A, Ext-B astral, U+3007, U+F8FF)
 *   arialu  CID subset of /System/Library/Fonts/Supplemental/Arial Unicode.ttf
 *           (U+FFFD; the only probed system font with a glyph there)
 *   helv / helv-bold / courier  base-14 Type1 (WinAnsiEncoding)
 */

const ZH_BODY = { font: "songti", size: 12, lineStep: 20, spaceAfter: 8 };
const ZH_SUB = { font: "songti", size: 14, lineStep: 22 };
const EN_BODY = { font: "helv", size: 11, lineStep: 16.5, spaceAfter: 7 };

export const FIXTURES = [
  /* ------------------------------------------------------------------ */
  {
    id: "pdf-01",
    title: "递归学习笔记",
    coverage: ["zh"],
    fonts: ["songti"],
    expectPages: 2,
    build(d) {
      d.heading("递归学习笔记", { font: "songti", size: 18, spaceBefore: 0 });
      d.para("递归是一种把大问题分解成同构小问题的思考方式。写递归函数时，最重要的不是立刻追踪每一层调用，而是先回答两个问题：分解规则是什么，基线条件是什么。只要这两件事想清楚了，剩下的就交给调用栈。", ZH_BODY);
      d.para("很多人第一次读递归代码时会忍不住在脑子里展开整个调用过程，展开三层之后就会迷失。更有效的方法是相信递归假设：假设函数对更小规模的输入已经正确，只验证“缩小规模之后正确使用其结果”这一步。这就是归纳法在程序里的样子。", ZH_BODY);
      d.heading("1. 分解与基线", ZH_SUB);
      d.para("递归函数的第一行几乎总是基线条件（base case）。基线条件回答：输入小到什么程度时，答案可以直接给出？例如阶乘函数里 n 为 0 或 1 时直接返回 1；目录遍历里，当前路径不是目录时直接处理文件本身。", ZH_BODY);
      d.para("分解规则（recursive case）则回答：如何把规模为 n 的问题拆成规模更小的同构子问题。关键约束是每次分解都必须向基线条件靠近，否则调用栈会一直加深，最终以栈溢出收场。", ZH_BODY);
      d.para("写完这两个部分之后，还应当检查终止性：是否存在一条输入路径，使分解永远不触达基线？对负数输入求阶乘就是经典反例，因此健壮的实现会先把非法输入挡在门外。", ZH_BODY);
      d.heading("2. 调用栈与栈帧", ZH_SUB);
      d.para("每一次递归调用都会在调用栈上压入一个新的栈帧，保存参数、局部变量和返回地址。递归深度就是同时存在的栈帧数量。理解这一点之后，“递归太深会爆栈”就不再神秘：栈空间是有限的，深度超过上限就会抛出错误。", ZH_BODY);
      d.para("把递归改写成迭代，本质上是自己维护一个显式的栈，把系统隐式提供的服务变成可见的数据结构。改写之后空间占用未必更小，但深度上限从语言栈限制变成了堆内存限制，通常宽裕得多。", ZH_BODY);
      d.heading("3. 递归与归纳", ZH_SUB);
      d.para("数学归纳法与递归互为镜像：归纳法从小结论走向大结论，递归从大问题调用小解法。证明归纳时我们验证基例与归纳步，写递归时我们验证基线条件与分解规则。两者的可靠性来自同一个源头，因此递归不是玄学，而是可以逐步验证的工程结构。", ZH_BODY);
      d.para("练习建议：先写三遍阶乘，再写两遍目录遍历，最后写一次汉诺塔。三者的难度递增，但检查点完全一致。写完之后试着向别人解释一遍；解释不通的地方，就是理解没有闭合的地方。", ZH_BODY);
      d.heading("4. 尾递归的启示", ZH_SUB);
      d.para("如果一个递归调用是函数体的最后一个动作，且返回值不再参与后续计算，就称其为尾递归。尾递归理论上可以被优化成循环，因为旧栈帧不再被需要。可惜主流 JavaScript 引擎并没有实现尾调用优化，这个概念更多是理解“哪些递归容易被改写成循环”的思维工具。", ZH_BODY);
      d.para("递归不是炫技，它是处理树形结构、分治算法和回溯搜索时最自然的表达。下一份笔记里，我们会用递归遍历一棵真正的树，并把每一次调用都画在纸上。", ZH_BODY);
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: "pdf-02",
    title: "Recursion Study Notes",
    coverage: ["en"],
    fonts: ["helv"],
    expectPages: 2,
    build(d) {
      d.heading("Recursion Study Notes", { font: "helv", size: 18, spaceBefore: 0 });
      d.para("Recursion is a way of thinking about problems: solve a large instance by solving smaller instances of the same problem. When you write a recursive function, do not try to trace every call in your head. Instead, answer two questions first: what is the decomposition rule, and what is the base case? Once those are settled, the call stack does the rest.", EN_BODY);
      d.para("Beginners often try to mentally expand the whole recursion, lose track after three levels, and conclude that recursion is hard. A better habit is the recursive leap of faith: assume the function already works for smaller inputs, and verify only the step that combines results. This is induction, expressed as code.", EN_BODY);
      d.heading("1. Decomposition and base cases", { font: "helv", size: 14 });
      d.para("The first line of a recursive function is almost always the base case. It answers the question: at what scale can the answer be returned directly? For factorial, the answer is immediate when n is 0 or 1. For directory traversal, a plain file is handled on the spot.", EN_BODY);
      d.para("The recursive case answers a different question: how do we carve a problem of size n into strictly smaller subproblems? The crucial constraint is progress. Every call must move toward the base case, or the stack grows forever and the program dies with a stack overflow.", EN_BODY);
      d.para("After writing both parts, check termination explicitly. Is there an input path that never reaches a base case? Factorial of a negative number is the classic counterexample, so robust implementations reject invalid input before recursing.", EN_BODY);
      d.heading("2. The call stack", { font: "helv", size: 14 });
      d.para("Every recursive call pushes a new stack frame holding parameters, local variables, and the return address. Recursion depth is the number of frames alive at once. Once you internalize this, stack overflow stops being mysterious: the stack is a bounded resource, and depth past the limit aborts the program.", EN_BODY);
      d.para("Rewriting recursion as iteration means maintaining an explicit stack of your own. You trade an invisible mechanism provided by the runtime for a visible data structure on the heap. The space cost is often similar, but the depth limit moves from the stack to memory, which is usually far more generous.", EN_BODY);
      d.heading("3. Recursion and induction", { font: "helv", size: 14 });
      d.para("Induction and recursion are mirror images. A proof by induction checks a base case and an inductive step; a recursive function checks a base case and a decomposition rule. The certainty you feel about induction is the certainty you are allowed to feel about recursion, no more and no less.", EN_BODY);
      d.para("A useful exercise: write factorial three times, then directory traversal twice, then the Tower of Hanoi once. Difficulty rises, but the checklist never changes. When you can explain your Hanoi solution out loud without notes, the concept has clicked.", EN_BODY);
      d.heading("4. What tail calls teach us", { font: "helv", size: 14 });
      d.para("A recursive call is a tail call when it is the final action of the function and its result is returned unchanged. Tail calls can in principle be compiled into a jump, reusing the current frame. Mainstream JavaScript engines never shipped this optimization, so treat tail position as a design smell that a loop is easy to write, not as a performance promise.", EN_BODY);
      d.para("Recursion is not a trick. It is the most natural notation for trees, divide and conquer, and backtracking search. The next note applies it to a real tree traversal, and draws every call on paper.", EN_BODY);
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: "pdf-03",
    title: "闭包与作用域：中英对照笔记",
    coverage: ["zh", "en"],
    fonts: ["songti", "helv"],
    expectPages: 2,
    build(d) {
      d.heading("闭包与作用域：中英对照笔记", { font: "songti", size: 18, spaceBefore: 0 });
      d.para("A closure is a function bundled together with the environment it captured at birth. In JavaScript, every function keeps a live reference to the scope where it was defined, so it can still read those variables long after the outer call has returned. This is the mechanism behind counters, memoization caches, and module patterns.", EN_BODY);
      d.para("闭包（closure）是函数与其出生时词法环境的组合体。JavaScript 里的每个函数都持有定义它时的作用域引用，因此外层调用返回之后，内层函数仍能读写那些变量。计数器、缓存与模块模式都建立在这个机制上。", ZH_BODY);
      d.heading("1. 词法作用域 lexical scope", ZH_SUB);
      d.para("Scope in JavaScript is lexical: it is decided by where code is written, not by where the function is called from. When the engine looks up a name, it walks the chain of enclosing scopes outward until it finds a binding. That chain is fixed at parse time, which is why closures capture variables, not values.", EN_BODY);
      d.para("作用域是词法的：由代码书写的位置决定，而不是由调用位置决定。引擎查找名字时，会沿着定义位置向外层作用域逐级寻找，直到命中绑定。这条链在解析期就固定了，所以闭包捕获的是变量本身，而不是当时的值快照。", ZH_BODY);
      d.para("一个经典陷阱：在循环里用 var 声明循环变量，回调函数捕获的是同一个绑定，因此所有回调读到的都是循环结束后的值。把 var 换成 let，每次迭代都会建立新的绑定，问题随之消失。理解这一点，比背下答案更重要。", ZH_BODY);
      d.heading("2. Practical closure patterns", { font: "helv", size: 14 });
      d.para("Memoize wraps a function with a cache keyed by arguments; the cache lives in the wrapper's closure and stays private. Once hooks resolve an initializer exactly one time. Both patterns rely on the same property: hidden mutable state with a controlled interface.", EN_BODY);
      d.para("记忆化（memoization）用一个以参数为键的缓存包裹函数，缓存藏在闭包里，外界碰不到；一次性开关（once）则保证初始化逻辑只执行一次。这两个惯用法共享同一性质：把可变状态藏进闭包，只暴露受控接口。", ZH_BODY);
      d.para("Closures are not free. A captured scope keeps every binding in it alive as long as the inner function is reachable, which is a common source of accidental memory retention. Capture narrowly: take what you need, let the rest go.", EN_BODY);
      d.heading("3. 闭包的代价与边界", ZH_SUB);
      d.para("闭包的代价是生命周期：只要内层函数还可达，被捕获的作用域连同其中的所有绑定就都不能回收。大型对象被无意间捕获，是最常见的内存滞留原因。审查代码时值得专门检查一次：回调究竟捕获了什么？", ZH_BODY);
      d.para("边界守则：捕获要窄。把真正需要的外部值收进局部常量，再让闭包捕获这个常量；不需要的引用不要顺手带进闭包。守则简单，却能把大多数滞留问题挡在设计期。", ZH_BODY);
      d.para("最后用一句话收束：闭包让函数拥有记忆，而工程师的工作是决定它记住什么、忘记什么。中英对照的这份笔记到此结束，两套表述描述的是同一个机制。", ZH_BODY);
    },
  },

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

  /* ------------------------------------------------------------------ */
  {
    id: "pdf-07",
    title: "页眉页脚样本：问题分解手记",
    coverage: ["header-footer"],
    fonts: ["songti"],
    expectPages: 4,
    build(d) {
      const B = { ...ZH_BODY, lineStep: 22 };
      d.setChrome({
        header: () => ({ text: "问题分解手记 · 第 1 章 分解", font: "songti", size: 10, x: 72, y: 812 }),
        footer: (pageNo) => ({ text: `第 ${String(pageNo)} 页`, font: "songti", size: 10, align: "center", y: 44 }),
      });
      d.heading("页眉页脚样本：问题分解手记", { font: "songti", size: 18, spaceBefore: 0 });
      d.para("本文档的每一页都带同一条页眉（运行标题）与居中的页码页脚。解析器把页眉页脚当作普通行处理：它们只是恰好位于页面顶部与底部的文本行，没有任何特殊标记。提取顺序遵循既定的栏带规则，页眉在顶部，页脚自成一带。", B);
      d.para("第一章讨论如何把一个模糊的大任务拆成可执行的小任务。拆分的第一刀永远切在“可以独立验证”的缝隙上：能写出断言的子任务才有资格成为任务。", B);
      d.heading("1. 页眉的角色", ZH_SUB);
      d.para("页眉重复出现，正好充当“重复词第二处”的测试材料：同一个标题在每一页的顶端一字不差地出现，选区系统必须能按出现序号精确区分第二页的页眉与第一页的页眉。", B);
      d.para("页脚的页码则每页不同：第 1 页、第 2 页、第 3 页、第 4 页。它们是天然的唯一短词，适合当作页内定位的锚点。页码变化也让“最后一页”拥有了可识别的签名。", B);
      d.para("穿插一段正文，让页面自然流动：分解的第一步是命名。给子任务起一个动词开头的名字，“校验输入格式”比“输入部分”更能指导实现。名字起对了，接口就定了一半。", B);
      d.heading("2. 分解的三个原则", ZH_SUB);
      d.para("原则一：子任务必须比父任务小，且小得可度量。原则二：子任务之间的接口必须先于实现确定，否则合并时会返工。原则三：为每个子任务准备一个失败样本，失败样本比成功样本更能暴露边界。", B);
      d.para("把三条原则套到“写一个解析器”上：先切出分词器、再切出语法检查、最后切出语义还原。每一块都能单独构造输入输出对，分解就此完成。", B);
      d.para("第二章开始之前，插入一段较长的过渡文字，让正文自然流到下一页，从而让页眉页脚在多个页面上重复出现。过渡的内容不必华丽，但必须完整：一本好的手记不靠注水凑页数，而是把每个概念讲透。分解之外还有排序：子任务的执行顺序应当尊重依赖关系，无依赖的可以并行，有依赖的必须排队。把依赖画成一张小图，环立刻现形；有环就回到命名那一步，说明切分还不够细。", B);
      d.heading("3. 第二章：验证", ZH_SUB);
      d.para("验证不是写完之后的补丁，而是分解的一部分。每个子任务在诞生时就带着它的验证方式，这决定了它可以独立完成、独立合并。验证方式说不出口的子任务，应当回到分解阶段重新切。", B);
      d.para("验证的层次从轻到重：类型检查、单元断言、属性测试、端到端回放。层次越重，覆盖越接近真实，但反馈越慢。把重的留给每日一次，把轻的留给每一次保存。", B);
      d.para("失败样本的写法：取一个必然越界的输入、一个空集合、一个刚好压线的规模。三个样本配一组断言，边界行为就有了行为学证据。修复回归时，先把失败样本写进测试，再动实现。", B);
      d.para("验证的常见陷阱一：只测快乐路径。快乐路径证明程序能跑，不证明程序正确；错误处理、重试与回滚才是验证的主战场。陷阱二：断言写得太松，只要不抛异常就算过——这种测试删除之后反而节省维护成本。", B);
      d.para("陷阱三：验证依赖执行顺序。测试之间共享可变状态，本地全绿、CI 全红。让每个验证单元自带装配与拆卸，顺序无关是最起码的纪律。这三条陷阱每章自查一遍，比引入任何测试框架都有用。", B);
      d.para("本章末尾再次强调页眉的重复性：到这里，页眉已经出现了多次。若选区请求指向第三次出现，正确答案是本页顶部的这一条，而不是任何前页的。页脚页码同理：第 3 页的页码只属于本页。", B);
      d.heading("4. 实例演练：拆一个日志解析器", ZH_SUB);
      d.para("现在把前两章的原则套到一个具体任务上：从一份混合格式的服务器日志里统计每分钟的错误数。整块吞下显然不现实，先找可以独立验证的缝隙。日志有三种行格式，切分的第一刀就落在格式边界上。", B);
      d.para("子任务一：行格式识别。输入一行字符串，输出格式标签。验证方式是一组已知行，每种格式五条，外加三条故意畸形的行。这个子任务可以独立完成，因为它不依赖任何后续环节。", B);
      d.para("子任务二：字段抽取。输入带标签的行，输出结构化记录。验证方式是“标签加记录”的对照表。它与子任务一的接口是格式标签枚举，接口先于实现敲定，两边可以并行开工。", B);
      d.para("子任务三：时间归桶与计数。输入记录流，输出每分钟错误数的序列。验证方式是手工构造的十分钟样本，其中包含跨小时的边界。三个子任务合并之后，端到端回放作为最后一道检查。", B);
      d.para("演练的结论：真正的分解发生在“验证方式可以独立描述”的地方。写不出验证方式的任务边界，就是切错位置的信号。返回命名那一步重新来，比带着裂缝往下走便宜得多。", B);
      d.para("顺带记录一个反例：最初把“读取文件”也列为子任务，后来发现它的验证方式与格式识别完全重叠，于是并了回去。子任务不是越多越好，切分的准绳始终是可验证性，不是颗粒度。", B);
      d.heading("5. 第三章：估算", ZH_SUB);
      d.para("分解完成之后先估时间，再动手。估算的单位用“半天”，粒度再细就是自欺。估算时记下信心值：高、中、低；信心低的任务，把它再切一刀——切不动的低信心任务就是风险本体。", B);
      d.para("估算的校准靠记录：把估计值与实际值并排写下来，每章复盘一次。三个月后，你的“半天”就有了个人化的含义，比任何方法论都准。", B);
      d.para("预算的另一面是停止条件：每个子任务在开始前写下“做到什么程度就算完”。没有停止条件的任务会吸走所有相邻任务的时间，这是分解纪律的第一破口。", B);
      d.para("估算的三个来源按优先级排列：历史记录最可靠，同类比照次之，拍脑袋垫底。没有历史记录时，先花一天做一个竖切原型，把最不确定的子任务提前标价，其余的估算会跟着变准。", B);
      d.para("第三章的小结：估算不是承诺，是度量。承诺在排期表上，度量的误差留在手记里，两本账不要混。混淆这两本账，是手记变成检讨书的常见起点。", B);
      d.heading("6. 收束", ZH_SUB);
      d.para("手记正文到此结束。最后一页的页脚仍然是页码，解析器应当如实输出它，而不是把它误认为正文的一部分而丢弃。收束句：分解、排序、验证、估算，四步闭环，一章手记。", B);
      d.para("附录提示：本手记的页眉页脚结构将被固定为验收样本，任何解析器提取本文件时，都应得到与真值文件完全一致的页文本，包括每一页的页眉与页脚行。", B);
      d.para("定稿前的复核清单：每一节的停止条件重读一遍，凡是读不出边界的，补一句具体的完成判据；每一节的失败样本至少一条，没有失败样本的验证都是 optimism。", B);
      d.para("归档约定：手记以版本号收尾，改动记录写在文末；与代码不同，手记的 diff 不需要评审，但需要日期。翻旧账时，日期比记忆可靠。", B);
      d.para("本页之后没有正文了，只剩页脚的页码。愿每一次分解都比上一次更快找到第一刀的位置。手记最终页，完。", B);
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: "pdf-08",
    title: "算法学习手记",
    coverage: ["multipage"],
    fonts: ["songti", "courier"],
    expectPages: 10,
    build(d) {
      const B = { ...ZH_BODY, lineStep: 22 };
      d.heading("算法学习手记", { font: "songti", size: 18, spaceBefore: 0 });
      d.para("这是一份贯穿十章的学习手记：从数组与链表出发，经过栈、队列、哈希表、树、堆、图，最后以排序与复杂度回顾收束。内容按章节顺序流动，跨页不回头；终章回顾在第十章等待。每章以要点开头，以代码或对照表收尾，全部例子都可以直接跑在 Node 24 上。", B);
      d.heading("第 1 节 数组", ZH_SUB);
      d.para("数组是最朴素的容器：连续内存、常数下标访问、缓存友好。它的弱点同样出名：中间插入与删除需要搬移元素，代价与长度成正比。选容器时先问访问模式，再问修改模式，答案多半自己浮现。", B);
      d.para("动态数组（如 JavaScript 的 Array）在容量不足时按倍率扩容并把旧元素复制过去。摊还分析说明：尽管单次扩容是 O(n)，连续 n 次追加的总代价仍是 O(n)。倍率是空间与时间的折中：太小则频繁复制，太大则浪费内存。", B);
      d.para("手记习惯：写数组循环时先问一句“遍历方向重要吗”。正向与反向不只是风格差异，在删除元素的场景里直接决定正确性。边遍历边删除是最常见的自伤动作，倒序遍历或先标记后压缩才是稳妥做法。", B);
      d.para("数组还有一个常被忽视的性质：它是几乎所有高级结构的地基。字符串是字符数组，堆是藏在数组里的完全二叉树，哈希表是桶数组加链表。理解数组的行为，就理解了一半的数据结构课。", B);
      d.para("索引的语义值得专门一提：下标是偏移量而不是序号，第一个元素在偏移零处。把这一点内化之后，半开区间 [0, n) 的循环写法就不再需要背：起点是偏移零，终点是偏移 n，恰好不含 n。", B);
      d.para("多维数组并不神秘：它是数组的数组，行的地址连续，列的地址分散。按行遍历与按列遍历的性能差距，全部来自这条地址规律。写嵌套循环时把大步长放在外层，缓存会谢谢你。", B);
      d.para("稀疏数组是常被忽略的中间形态：绝大多数位置为空时，用坐标对加值的映射代替全量网格，空间从平方降到线性。棋盘、表格、时间轴，都是稀疏化的受益者。判断标准很简单：非空占比低于一成，就值得换表示。", B);
      d.para("数组与字符串的关系在 JavaScript 里格外密切：字符串不可变、按码单元索引，行为像一个冻结的数组。理解了这一点，slice、indexOf、includes 的语义就与数组完全对齐，两套 API 只需记一套。", B);
      d.para("环形缓冲是数组的高级变体：固定长度，头尾指针取模推进，写满即覆盖最旧。音频采样、日志滚动、限流窗口都靠它。理解环形缓冲之后，第 3 节的队列可以用它实现一个无锁版本。", B);
      d.para("数组题的第一直觉清单：能否排序、能否双指针、能否前缀和、能否哈希补一维。四连问下来，八成的数组题都有了下手处。清单本身不值钱，值钱的是每次都真的问一遍。", B);
      d.codeBlock([
        { text: "// dynamic array growth, amortized O(1) push", indent: 0 },
        { text: "class Vec { constructor(){ this.a = []; }", indent: 0 },
        { text: "  push(v) { this.a.push(v); }  // engine doubles capacity", indent: 2 },
        { text: "  get(i) { return this.a[i]; } // O(1) random access", indent: 2 },
        { text: "  insert(i, v) { this.a.splice(i, 0, v); } } // O(n)", indent: 2 },
      ], { spaceAfter: 8 });
      d.heading("第 2 节 链表", ZH_SUB);
      d.para("链表用指针换连续性：插入删除只改两个指针，但随机访问必须从头走起。单链表只能向前，双链表付出每节点一个额外指针的代价换来双向遍历。环形链表则把尾部接回头部，用于轮转调度。", B);
      d.para("链表的经典错误是断链：修改指针前没有保存后继，节点从此失联。稳妥的写法是先画图再动笔，先改新节点的指针，再改旧节点。虚拟头节点能消灭“头结点特殊吗”这一整类判断。", B);
      d.para("快慢指针是链表的配套技巧：判断环、找中点、找倒数第 k 个，都靠两个速度不同的指针完成。快指针每次两步，慢指针每次一步，环中相遇即有环；走完未相遇即无环。", B);
      d.para("链表与数组的对照可以浓缩成一张表：访问、插入、删除、内存三列，各写一行。把这张表画在笔记第一页，之后所有结构都照此格式记录，复习时一目了然。", B);
      d.para("工程视角的补充：语言运行时几乎从不裸用链表，队列与栈由数组实现即可覆盖绝大多数场景。链表的价值在教学与面试：它把指针操作逼到你眼前，练的是手感，不是选型。", B);
      d.para("逆序是链表练习的必修课：三指针滚动，prev、curr、next 各司其职，循环一轮挪一个。写完正向逆序，再写区间逆序与 k 个一组逆序，前者是后者的地基。", B);
      d.para("合并两个有序链表是另一门基本功：双指针各牵一条，谁小取谁，尾插推进。归并排序的合并阶段与它完全同构，练熟这一题，第 8 节的归并就只剩切分要写。", B);
      d.para("链表的哨兵技巧再怎么强调都不过分：dummy 头让“删除头节点”与“删除中间节点”合二为一，dummy 尾让“追加”免去判空。两个哨兵，消灭一整类分支，面试与评审都受益。", B);
      d.para("链表的内存代价常被低估：每个节点除了数据还要背一个指针，双链表背两个。批量分配时节点散落各处，缓存命中率远低于数组。学习阶段画图即可，工程阶段先测量再拍板。", B);
      d.para("有序链表的插入有讲究：从头找位当然对，维护一个跳表可以更快。跳表用空间换高度，把有序链表的查找拉到对数级别，是 Redis 有序集合的选择。它属于第 5 节的树思想在链表上的投影。", B);
      d.codeBlock([
        { text: "// fast/slow pointers detect a cycle in O(n)", indent: 0 },
        { text: "function hasCycle(head) {", indent: 0 },
        { text: "  let slow = head, fast = head;", indent: 2 },
        { text: "  while (fast && fast.next) {", indent: 2 },
        { text: "    slow = slow.next; fast = fast.next.next;", indent: 4 },
        { text: "    if (slow === fast) return true; }", indent: 4 },
        { text: "  return false; }", indent: 2 },
      ], { spaceAfter: 8 });
      d.heading("第 3 节 栈与队列", ZH_SUB);
      d.para("栈是后进先出的单车道，函数调用、括号匹配、撤销栈都是它的舞台。队列是先进先出的排队机，广度优先搜索离开它寸步难行。两者都只暴露两端的操作，约束越强，用途越明确。", B);
      d.para("用两个栈实现队列是经典练习：入队压进 A 栈，出队时若 B 栈为空就把 A 栈全部倒入 B 栈再弹出。倒栈的时机是全部关键，元素顺序恰好被翻转两次而复原。摊还代价仍是常数。", B);
      d.para("优先队列则给排队机装上了插队规则：堆顶永远是优先级最高者。任务调度、Dijkstra 的松弛候选、合并 k 个有序流，背后都是同一个堆。下一节展开堆本身。", B);
      d.para("括号匹配是栈的教科书案例：左括号入栈，右括号弹栈比对。把三种括号混在一起，栈照样工作；把引号与转义也混进来，就需要状态机接力——这也是“栈够用到哪里”的天然分界线。", B);
      d.para("单调栈是栈的进阶用法：栈内元素保持单调，遇到破坏单调的元素就弹栈并结算。下一个更大元素、柱状图最大矩形，都是这个套路。识别信号是题目里出现“最近的”“下一个更大的”。", B);
      d.para("栈与递归的关系值得点破：递归就是隐式的栈，系统替你压帧弹帧；显式栈就是手写的递归。深度优先搜索两种写法都行，选择标准是深度是否可控、中途是否需要保存现场。", B);
      d.para("队列的变体同样实用：双端队列两端都能进出，滑动窗口最大值靠它维持候选；延迟队列给元素配一个可见时间，到点才出队。结构上的小改动，换来语义上的大不同。", B);
      d.para("栈与队列的对称性在遍历里最漂亮：深度优先配栈、广度优先配队列，一行之差改变整个搜索的形状。第 7 节的图遍历会再次用到这对组合，届时值得回来重读这段。", B);
      d.para("函数调用栈是栈概念的活教材：调用即压栈，返回即弹栈，异常则一路弹到接住它的那一层。调试器里的调用栈窗口，就是本章概念的可视化现场，值得打开看一次。", B);
      d.codeBlock([
        { text: "// two-stack queue, amortized O(1)", indent: 0 },
        { text: "class Queue { push(v){a.push(v);} shift(){", indent: 0 },
        { text: "  if (!b.length) while (a.length) b.push(a.pop());", indent: 2 },
        { text: "  return b.pop(); } }", indent: 0 },
      ], { spaceAfter: 8 });
      d.heading("第 4 节 哈希表", ZH_SUB);
      d.para("哈希表用散列函数把键映射到桶数组，平均 O(1) 的读写换来的是对散列质量的依赖。冲突处理有两条路：拉链法把冲突者串成链表，开放寻址让后来者另寻空位。负载因子的警戒线通常画在四分之三。", B);
      d.para("负载因子超过阈值时扩容重散列：新桶数组翻倍，所有键重新落位。重散列期间性能抖动明显，实时系统里要提前预热或分批迁移。渐进式重散列是工业级哈希表的标配。", B);
      d.para("键的设计要点是稳定：相等的对象必须有相等的散列值，否则昨天的缓存今天就取不出来。不可变对象天然适合做键；可变对象做键等于埋雷。", B);
      d.para("哈希表不维护顺序，需要有序遍历时就退场让位给平衡树或跳表。把“快”与“有序”都想要的场景，先问一句顺序是否真的必需，多数时候答案是否。", B);
      d.para("散列攻击是服务端的现实威胁：构造一串散列到同一桶的键，能把一次哈希查找拖成链表遍历。带随机种子的散列与限长键，是防御的两块砖。学习结构时顺手了解攻防，理解会深一层。", B);
      d.para("计数器是哈希表最常见的出场：遍历一次，边走边加。词频统计、两数之和的去重、图的邻接压缩，第一行代码几乎都是 const map = new Map()。", B);
      d.para("缓存是哈希表的第二战场：以参数为键、以结果为值，递归加缓存等于记忆化。缓存的三问——命中键是什么、失效条件是什么、上限是多少——在写第一行之前就要回答。", B);
      d.para("集合运算的加速也靠哈希：判存在从 O(n) 的扫描降为 O(1) 的探测，两个数组的交集因此变成线性。把“先建集合再查询”当成条件反射，一半的暴力解法会自动消失。", B);
      d.para("哈希表与数组可以互相成全：桶排序把值域切桶，每桶一个小数组，本质是用数组模拟哈希；计数排序更是把哈希键退化成下标。两个结构在本节和第 8 节之间来回借力。", B);
      d.para("弱引用映射是哈希表的内存友好形态：键不再被外部持有时，表项自动可回收。缓存类场景里，WeakMap 比手写淘汰策略省心，代价是“何时清”不再受你控制。", B);
      d.codeBlock([
        { text: "// grouping with a Map: O(n) instead of O(n^2)", indent: 0 },
        { text: "function groupBy(items, keyOf) {", indent: 0 },
        { text: "  const groups = new Map();", indent: 2 },
        { text: "  for (const it of items) {", indent: 2 },
        { text: "    const k = keyOf(it);", indent: 4 },
        { text: "    if (!groups.has(k)) groups.set(k, []);", indent: 4 },
        { text: "    groups.get(k).push(it); }", indent: 4 },
        { text: "  return groups; }", indent: 2 },
      ], { spaceAfter: 8 });
      d.heading("第 5 节 二叉树与遍历", ZH_SUB);
      d.para("二叉树的遍历有四个基本顺序：前序、中序、后序与层序。前三个用递归三行写完，层序借助队列逐层展开。前序复制树，中序读搜索树，后序释放树，各司其职。", B);
      d.para("递归在这里如鱼得水：树的定义本身就是递归的。中序遍历二叉搜索树得到升序序列，这一性质是验证与调试的利器。写完平衡操作之后跑一次中序，序列不升序就说明旋转写错了。", B);
      d.para("平衡性决定性能：最坏情况下的二叉搜索树退化成链表，查找跌到 O(n)。红黑树与 AVL 树用旋转维持平衡，把最坏情况压回 O(log n)。红黑以近似平衡换更少的旋转，工程上更常见。", B);
      d.para("线索化、Morris 遍历、迭代器写法，都是在“不用栈不用递归”的约束下遍历树的手段。约束本身未必必要，但实现它们能加深对树结构的理解，值得练一次。", B);
      d.para("前缀树（Trie）把树用在字符串上：公共前缀共享路径，查找代价只与词长有关。输入提示、拼写检查、路由表，都是它的驻地。前缀树是“结构为数据形状服务”的最佳例证。", B);
      d.para("递归深度等于树高：平衡树的对数高度让递归安全，退化树的高度让递归危险。带着这条等式回头看第 2 节的快慢指针找中点，两套工具就串成了一条线。", B);
      d.para("最近公共祖先是树上查询的代表题：自底向上回溯，遇到两侧都有命中的节点即为答案。它与中序遍历一样，考察的都是“信息自下而上聚合”的树直觉。", B);
      d.para("序列化与反序列化把树压平成字符串再还原：前序加空标记是最简方案，层序加计数是另一种。两题互为逆运算，一起写完，对树结构的掌握就闭环了。", B);
      d.para("树的路径问题是一族：自顶向下求路径和、自底向上求直径、带转折的最长链。套路都是“左右子树各报一个数，父节点聚合”。会一道，就会一串。", B);
      d.para("二叉搜索树的操作全靠一个不变量：左小右大，对每个节点成立。查找、插入、删除、验证，四件事都从不变量出发推。删除带两个子节点时的“找后继”步骤，是不变量最精巧的一次应用。", B);
      d.codeBlock([
        { text: "// three depth-first orders, one skeleton", indent: 0 },
        { text: "function walk(n, out) {", indent: 0 },
        { text: "  if (!n) return;", indent: 2 },
        { text: "  out.push(n.v); walk(n.l, out); walk(n.r, out); // pre", indent: 2 },
        { text: "  // walk(n.l); out.push(n.v); walk(n.r);   // in", indent: 2 },
        { text: "  // walk(n.l); walk(n.r); out.push(n.v);   // post", indent: 2 },
        { text: "}", indent: 0 },
      ], { spaceAfter: 8 });
      d.heading("第 6 节 堆", ZH_SUB);
      d.para("堆是用数组存的完全二叉树：父节点下标 i，子节点 2i+1 与 2i+2。最大堆里父不小于子，堆顶即全局最大。数组下标与树形的互译是堆的第一课。", B);
      d.para("上浮与下沉是堆的两个基本动作：新元素从尾部上浮到正确位置，堆顶弹出后让尾部元素下沉重建堆序。建堆可以自底向上 O(n) 完成，优于逐个插入的 O(n log n)。", B);
      d.para("堆排序就地完成：建堆后反复弹顶放到数组尾部，总复杂度 O(n log n)，但缓存局部性不如快排，实际常数偏大。Top-K 问题用小顶堆维护前 k 大，是堆最实用的出场方式。", B);
      d.para("堆不维护全序：兄弟之间没有可比性，中序遍历堆没有意义。需要“第 k 大”之外的顺序问题时，堆让位给排序或平衡树。分清“部分序够用”与“全序必需”，是选型的分水岭。", B);
      d.para("建堆的 Floyd 手法值得单独记一笔：从最后一个非叶节点倒着下沉到底，一轮下来整棵树成堆。它的 O(n) 常数大于逐个插入的 O(n log n) 听起来反直觉，证明的关键是多数节点离叶很近。", B);
      d.para("优先级的动态更新是堆的软肋：元素入队后优先级变了，堆找不到它。给元素存句柄、配合位置索引表，才能支持升键降键——这也是为什么调度器宁可自己写双叉堆也不通用的原因。", B);
      d.para("中位数维护是双堆的招牌应用：小顶堆存较大的一半，大顶堆存较小的一半，两堆顶夹出中位数。数据流场景下每个元素只花对数时间，面试与工程都常见。", B);
      d.para("堆的变体谱系顺便收录：二项堆支持高效合并，斐波那契堆把删边摊还压得更低，配对堆以实践性能著称。工程里二叉堆够用，知道谱系是为了读论文时不迷路。", B);
      d.codeBlock([
        { text: "// heapify-down, the heart of a binary heap", indent: 0 },
        { text: "function down(a, i) { for(;;) { const l=2*i+1, r=l+1; let m=i;", indent: 0 },
        { text: "  if (l < a.length && a[l] > a[m]) m = l;", indent: 2 },
        { text: "  if (r < a.length && a[r] > a[m]) m = r;", indent: 2 },
        { text: "  if (m === i) return; [a[i], a[m]] = [a[m], a[i]]; i = m; } }", indent: 2 },
      ], { spaceAfter: 8 });
      d.heading("第 7 节 图的表示", ZH_SUB);
      d.para("图的两种主流表示：邻接矩阵用 n×n 的布尔阵，查边 O(1) 但空间 O(n^2)；邻接表每点挂一条邻居链表，空间 O(n+e)，遍历邻居高效。稀疏图选表，稠密图选阵。", B);
      d.para("遍历两件套：深度优先沿一条路走到底再回头，天然适配递归与显式栈；广度优先逐圈扩散，配队列使用，最先触达的距离即最短路（无权图）。", B);
      d.para("拓扑排序把有向无环图压成线性序：反复摘掉入度为零的点。若中途无点可摘而图中仍有剩余，说明环存在，依赖关系无法满足。构建系统的依赖解析就是每天在跑的拓扑排序。", B);
      d.para("带权图交给 Dijkstra 与 Bellman-Ford：前者贪心加堆，后者允许负边并负责检测负环。两者的共同前提是理解松弛操作——尝试经由 u 让 v 的距离估计更短。", B);
      d.para("连通分量与并查集是图论里的另一半世界：不问最短，只问“是否连着”。并查集按秩合并加路径压缩，单步摊还近似常数，联通判定快得不像图算法。", B);
      d.para("网格图是图的第一应用现场：每个格子是一个点，四邻是边，深度优先染一遍就是洪泛填充。把二维下标压成一维编号，邻接表就退化为四个偏移量，代码短得不像图算法。", B);
      d.para("二分图判定用染色法：从一个点出发交替染两色，冲突即非二分。匹配问题的入口大多在这里，任务与工人、课程与时段，先判定二分再谈分配。", B);
      d.para("图的存储还有第三条路：边集数组，只存边的两端与权。遍历效率最低，但对 Kruskal 这类按边排序的算法反而是最自然的输入。结构没有优劣，只有与算法的契合度。", B);
      d.para("最短路的实际工程版是 A 星：给 Dijkstra 加一个到目标的估计函数，估计不高估就能保持正确，估计准就能少走弯路。游戏寻路与地图导航都是它的日常现场。", B);
      d.codeBlock([
        { text: "// BFS on an adjacency list; distances in one pass", indent: 0 },
        { text: "function bfs(adj, s) {", indent: 0 },
        { text: "  const dist = new Map([[s, 0]]);", indent: 2 },
        { text: "  for (const q = [s]; q.length;) {", indent: 2 },
        { text: "    const u = q.shift();", indent: 4 },
        { text: "    for (const v of adj.get(u) ?? [])", indent: 4 },
        { text: "      if (!dist.has(v)) { dist.set(v, dist.get(u)+1); q.push(v); } }", indent: 6 },
        { text: "  return dist; }", indent: 2 },
      ], { spaceAfter: 8 });
      d.heading("第 8 节 排序", ZH_SUB);
      d.para("排序算法的三问：平均复杂度、最坏复杂度、是否稳定。快排平均 O(n log n) 最坏 O(n^2)；归并稳定但需要辅助数组；堆排序最坏有保障但不稳定。三问答完，选型自动完成。", B);
      d.para("工程实现从不只用一种：小段落切换插入排序（常数小），大段落递归切分，深度超限切换堆排序。这种混合策略就是多数标准库的实际形态。", B);
      d.para("稳定性影响的是并列元素的相对次序：按两个键排序时，第二次排序若不稳定，第一次的结果就会被部分打乱。数据库的多列排序因此全部依赖稳定算法。", B);
      d.para("比较排序的下界是 O(n log n)，来自决策树高度的论证。计数排序、基数排序绕开比较，在线性时间内完成，代价是对键值域的假设。知道下界在哪里，才知道什么时候该换赛道。", B);
      d.para("快排的基准选择决定命运：固定取首元素在有序输入上退化为平方，三数取中让最坏概率骤降，随机取则把期望锁死在对数级。第 4 节的散列攻击与这里是同一个道理：对手会瞄准你的确定性。", B);
      d.codeBlock([
        { text: "// ten sorts; master three first: quick, merge, heap", indent: 0 },
        { text: "quickSort(data, 0, data.length - 1);", indent: 0 },
        { text: "mergeSort(data, temp, 0, data.length - 1);", indent: 0 },
        { text: "heapSort(data);", indent: 0 },
      ], { spaceAfter: 8 });
      d.heading("第 9 节 复杂度回顾", ZH_SUB);
      d.para("复杂度分析的目的是预测规模增长时的行为曲线，而不是精确计时。常数因子交给实测，增长趋势交给大 O。两套工具各管一段，混用就会得出“哈希永远最快”之类的错误结论。", B);
      d.para("摊还分析值得单独一节：动态数组追加、并查集按秩合并，单步可能昂贵，序列整体便宜。看总账，不看单步。把这一条与第 1 节、第 7 节对上，三处摊还案例互为印证。", B);
      d.para("对数的感觉要专门培养：一百万个元素的平衡树查找只有二十层，一千万也只有二十三层。规模涨十倍，对数只涨三步——这就是分治结构敢于面对大数据的底气。", B);
      d.para("空间复杂度的三个常见来源：递归栈、辅助数组、输出本身。前两个可以优化（改迭代、原地交换），第三个是题目自带的，别错怪自己。把三栏并排写在第 9 节笔记边上，复查时一目了然。", B);
      d.para("第九节收束。下页的术语对照表是全书的浓缩版，复习时先默写右列，再回读左列。", B);
      d.codeBlock([
        { text: "// glossary: term, English, one-line note", indent: 0 },
        { text: "数组       array      O(1) index, O(n) insert", indent: 0, font: "songti" },
        { text: "链表       list       O(1) splice after a node", indent: 0, font: "songti" },
        { text: "栈         stack      LIFO; call frames live here", indent: 0, font: "songti" },
        { text: "队列       queue      FIFO; BFS walks with it", indent: 0, font: "songti" },
        { text: "哈希表     hash map   average O(1); watch keys", indent: 0, font: "songti" },
        { text: "平衡树     balanced tree  O(log n); rotations", indent: 0, font: "songti" },
        { text: "堆         heap       partial order; top only", indent: 0, font: "songti" },
        { text: "邻接表     adjacency list  sparse graphs", indent: 0, font: "songti" },
        { text: "拓扑排序   topo sort  DAG to linear order", indent: 0, font: "songti" },
        { text: "摊还       amortized  total cost over sequence", indent: 0, font: "songti" },
      ], { spaceAfter: 8 });
      d.heading("第 10 节 终章回顾", ZH_SUB);
      d.para("终章回顾整条学习线：数组与链表给了线性结构，栈与队列给了访问次序，哈希表给了平均常数，树与堆给了对数台阶，图把一切连成网络，排序与拓扑排序提供了加工手段。", B);
      d.para("终章回顾的意义在于收束：十个章节不是十个孤岛，而是同一门手艺的十次打磨。下次再遇到新结构，先问它落在哪一层台阶上，多数问题就有了答案。", B);
      d.para("回顾的另一个收获是看见呼应：数组的摊还、并查集的摊还、快排的随机化、哈希的随机化，同一思想在不同章节各出场一次。手记读到第二遍，主线才会浮出来。", B);
      d.para("给后来者的练习清单放在最后：数组原地去重、链表逆序、两栈队列、LRU 缓存、二叉树层序、Top-K、课程表拓扑排序、颜色分类三指针。八道题对应八个章节，做不出来就回读对应章节。", B);
      d.para("练习的验收标准：不看题解写出、用随机数据对拍、给边界各造一个失败样本。三步全过才算掌握，只过第一步的属于“眼会手不会”。", B);
      d.para("写手记这件事本身也值得一句回顾：每章“要点加代码加反例”的三段式，让复习时间压到初读的三分之一。结构化不是为了好看，是为了将来能快速找回。", B);
      d.para("下一轮学习的入口已经想好：把本手记的八个练习各写一遍测试，让每一题都留下可回归的资产。从读到写的跨越，才是手记真正的终点。", B);
      d.para("手记完。愿每次终章回顾都比上一次更快。", B);
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: "pdf-09",
    title: "字符编码样本：组合字符与全角",
    coverage: ["combining", "full-width"],
    fonts: ["stheiti", "songti"],
    expectPages: 2,
    build(d) {
      const CAFE = "cafe\u0301"; // c a f e + COMBINING ACUTE ACCENT (decomposed)
      const NAIVE = "naive\u0308"; // ... e + COMBINING DIAERESIS (decomposed)
      const ARING = "A\u030a"; // A + COMBINING RING ABOVE (decomposed)
      d.heading("字符编码样本：组合字符与全角", { font: "songti", size: 18, spaceBefore: 0 });
      d.para("本页集中摆放 Unicode 边角样本：分解式组合字符、全角字母数字、中文标点与全角空格。规范文本不做任何归一化，分解式与预组合式各自保留原样，选区必须按代码单元精确处理。", { ...ZH_BODY, font: "songti" });
      d.heading("1. 分解式组合字符（NFD）", ZH_SUB);
      d.para(`${CAFE} 由四个基本拉丁字母加一个组合重音（U+0301 COMBINING ACUTE ACCENT）组成：cafe 加上末尾的组合锐音符。它在 UTF-16 里占六个代码单元，比预组合形态多出一个，二者是不同的字节序列。`, { ...ZH_BODY, font: "stheiti" });
      d.para(`${NAIVE} 的末尾是 e 加组合分音符（U+0308）；同样，${ARING} 是 A 加组合圆圈（U+030A）。三者都以分解形式（NFD）书写，规范文本原样保留，不做任何归一化。`, { ...ZH_BODY, font: "stheiti" });
      d.para(`组合序列清单：${CAFE}、${NAIVE}、${ARING}、以及 o 加分音符与 u 加上标符的组合。每个样本的基字符与组合记号都是独立的代码点，宽度计算与选区切分都不能把它们当成单字符。`, { ...ZH_BODY, font: "stheiti" });
      d.para("选区系统若在规范文本上做子串匹配，必须逐代码单元比较：分解式样本的末尾是 e 加组合符两个单元，截在中间会把字符撕开。这是组合字符样本存在的第一理由。", { ...ZH_BODY, font: "stheiti" });
      d.heading("2. 全角字母数字与中文标点", ZH_SUB);
      d.para("全角字母：ＡＢＣＤＥＦＧ；全角数字：１２３４５６７８９０。它们与半角 ASCII 是不同的码位，宽度为一个汉字位。混排时全角与半角之间的空隙处理不当，版面会出现难看的裂缝。", { ...ZH_BODY, font: "songti" });
      d.para("中文标点集合：逗号，句号。顿号、分号；冒号：问号？叹号！引号「」『』括号（）书名号《》方头括号【】。每个标点都有独立的码位与全角宽度，断行规则也各不相同。", { ...ZH_BODY, font: "songti" });
      d.para("全角空格演示：句一　句二　句三。相邻两句之间的间隔就是全角空格 U+3000，宽度等于一个汉字，与半角空格不同码位，不可混用替换。", { ...ZH_BODY, font: "songti" });
      d.para("半角与全角的转换不是简单加减码位：Ａ（U+FF21）与 A（U+0041）相隔甚远。文本比较若想忽略宽度差异，必须显式做映射，规范文本本身绝不代劳。", { ...ZH_BODY, font: "songti" });
      d.heading("3. 混排收尾", ZH_SUB);
      d.para("把组合字符、全角字母与中文标点放进同一份材料，是为了让解析与选区在真实的“不干净”文本上工作。规范文本一旦被悄悄归一化，分解式样本就会变成预组合式，选区断言将立刻失败。这是本样本存在的意义。", { ...ZH_BODY, font: "stheiti" });
      d.para(`最后一条混合句：全角数字 ２０２６ 与半角数字 2026 并排出现，句尾再放一个分解式 ${ARING}。若你在两处看到相近的字形，说明渲染器各自处理了宽度与组合；即便字形一致，代码单元的计数仍然不同。`, { ...ZH_BODY, font: "stheiti" });
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: "pdf-10",
    title: "字体混排样本 Font Sampler",
    coverage: ["fonts"],
    fonts: ["helv", "helv-bold", "songti", "courier"],
    expectPages: 2,
    build(d) {
      d.heading("Font Sampler", { font: "helv-bold", size: 18, spaceBefore: 0 });
      d.heading("字体混排样本", { font: "songti", size: 16, spaceBefore: 2, spaceAfter: 10 });
      d.para("This page mixes four font faces: a bold sans-serif title, a serif CJK body, a monospace code listing, and regular sans-serif paragraphs like this one. Each visual line keeps exactly one font; the reading order rule is unaffected by font changes, because a line's font never changes its x position or its band.", EN_BODY);
      d.para("本页混合四种字体：粗体无衬线标题、衬线中文正文、等宽代码与常规无衬线段落。每个视觉行只使用一种字体；字体切换不改变行与栏的阅读顺序规则，因为字体从不改变一行的横坐标与栏带归属。", ZH_BODY);
      d.heading("Section headings in a second font", { font: "helv-bold", size: 14, spaceBefore: 8, spaceAfter: 6 });
      d.para("小节标题使用第二字体（粗体）渲染。标题字号大于正文，解析器不应把字号差异当作内容边界——只有换行符决定行边界，字号只是字形属性。", ZH_BODY);
      d.para("Typographically, a bold heading carries weight without growing in point size; a size jump changes rhythm instead. The sampler deliberately shows both: bold at constant size, and regular at increased size, in the next section.", EN_BODY);
      d.heading("中文小节标题", ZH_SUB);
      d.para("中文小节标题用宋体渲染，字号同样大于正文。到此为止，页面已经出现三种字号的文本：18pt 主标题、14pt 小节、12pt 正文。选区与摘录不感知字号，只感知文本与位置。", ZH_BODY);
      d.para("同一行内的混排被有意避免：中文与西文分处不同的行，各自使用一种字体。这让“一行一个 Tj”的规范保持简单，也让提取器的解码路径单一可靠。", ZH_BODY);
      d.heading("Code in Courier", { font: "helv-bold", size: 14, spaceBefore: 8, spaceAfter: 6 });
      d.codeBlock([
        { text: "const sampler = { faces: 4, rule: \"one font per line\" };", indent: 0 },
        { text: "console.log(sampler.faces); // 4", indent: 0 },
        { text: "for (const face of [\"bold\", \"serif\", \"mono\", \"sans\"]) {", indent: 0 },
        { text: "  console.log(face.padEnd(8), sampler.rule);", indent: 2 },
        { text: "}", indent: 0 },
      ], { spaceAfter: 8 });
      d.para("等宽字体行保持原有缩进语义，行首空格是内容的一部分，不会被折叠。代码行与正文行共享同一套栏带规则。", ZH_BODY);
      d.para("Mixed closing paragraph: 字体混排到此收尾。四种字体、三种字号、两种书写系统，同一套阅读顺序规则全部适用。若选区在任何一行上失准，问题不会出在字体上——去查偏移数学。", ZH_BODY);
      d.para("Final paragraph in regular sans: font variety is a rendering concern, not a text concern. The canonical text records characters, not faces; a highlight spans glyphs the parser never measured. Goodbye from the sampler.", EN_BODY);
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: "pdf-11",
    title: "长文样本：三十节编程笔记",
    coverage: ["long-tail", "zh"],
    fonts: ["songti"],
    expectPages: 30,
    build(d) {
      const sections = [
        ["变量与常量", "变量是可变的绑定，常量是不可变的绑定。选择 const 优先：把可变性留给真正需要变化的量，读者就能少担一半的心。提升（hoisting）只移动声明，不移动赋值。"],
        ["类型系统", "动态类型把检查推迟到运行时，静态类型把检查提前到编译期。两者不是对立，TypeScript 的渐进类型系统就站在中间：需要时标注，不需要时推断。"],
        ["函数是一等公民", "函数可以被赋值给变量、当参数传递、当返回值返回。回调、高阶函数、闭包，全都建立在这个性质上。一等公民的身份是函数式风格的门票。"],
        ["闭包", "闭包让函数记住出生地。计数器、缓存、模块模式都依赖它；它也让被捕获的作用域长生不老，内存泄漏常常从这里开始。"],
        ["原型与继承", "JavaScript 的对象靠原型链共享属性。查找沿链向上，找到即止。class 语法只是原型的糖衣，理解链比理解关键字更重要。"],
        ["this 的四种绑定", "默认绑定、隐式绑定、显式绑定、new 绑定。优先级从低到高依次排列，箭头函数则完全跳出这套规则，捕获定义处的 this。"],
        ["事件循环", "调用栈清空之后，任务队列才开始出队。宏任务一次一个，微任务在宏任务之间清空。理解这个次序，定时器的怪异行为全部变得可解释。"],
        ["Promise 状态机", "Promise 只有三种状态：pending、fulfilled、rejected，且一旦落定不可更改。then 返回新 Promise，链式调用因此天然支持串行异步。"],
        ["async 与 await", "async 函数把 Promise 链写成同步形状，await 挂起当前函数而不阻塞线程。错误处理回到 try/catch，可读性是最大的收益。"],
        ["错误处理", "错误处理的第一原则：能恢复就恢复，不能恢复就快速失败。捕获之后静默吞掉，比不捕获更糟糕，因为它把线索也一起吞了。"],
        ["模块化", "模块把命名空间切成小岛。导入是显式依赖，导出是公开接口。CommonJS 的运行时加载与 ES Module 的静态结构，决定了后者可以摇树优化。"],
        ["作用域链", "嵌套函数一层层向外找名字，找不到就抛 ReferenceError。链在定义期固定，在调用期行走。词法作用域是这一切的地基。"],
        ["尾调用", "尾调用是函数的最后动作。理论上可以复用栈帧，实际上主流引擎未实现。把它当思维模型：尾位置的递归最容易改写成循环。"],
        ["高阶函数", "接收函数或返回函数的函数叫高阶函数。map、filter、reduce 是三件套：映射、筛选、折叠。组合它们，多数数据处理都能流式表达。"],
        ["纯函数", "同样的输入永远得到同样的输出，且不碰外部世界。纯函数可缓存、可并行、可测试。副作用不是罪恶，但应该被推到边界处集中管理。"],
        ["不可变数据", "不可变数据的修改不是原地改动，而是派生新值。结构共享让拷贝廉价。不可变性换来了可追溯的历史与放心的共享。"],
        ["惰性求值", "惰性求值把计算推迟到需要的那一刻。生成器是 JavaScript 里的惰性序列：next 一次，走一步。无限序列因此可以安全存在。"],
        ["记忆化", "记忆化用空间换时间：把算过的答案存起来。递归加缓存，指数变线性。它只对纯函数有效，副作用会让缓存悄悄腐烂。"],
        ["时间复杂度", "大 O 描述增长趋势。O(1)、O(log n)、O(n)、O(n log n)、O(n^2)，每上一级台阶，规模翻倍时代价翻几倍。看趋势，别看常数。"],
        ["空间复杂度", "空间复杂度数的是额外内存。递归深度是隐藏的空间成本，栈帧也是内存。优化空间的常用手段是复用缓冲区与就地交换。"],
        ["二分查找", "二分查找要求数组有序，每次比较淘汰一半。三处易错：边界含不含、中点溢出、死循环。写对一次不难，难的是每次都写对。"],
        ["哈希表", "哈希表用散列函数定位桶。设计键时保证两点：相等对象散列相等，散列过程稳定。满足这两点，平均读写就是常数。"],
        ["链表", "链表插入删除只动指针，随机访问却要一步步走。画图是链表调试的第一工具：先画后改，指针不乱。"],
        ["栈与队列", "栈后进先出，队列先进先出。函数调用用栈，广度优先用队列。两个反了，程序照样能跑，只是结果全错。"],
        ["树的遍历", "前序、中序、后序、层序。中序遍历二叉搜索树得到升序序列，这是最常用的验证手段。递归在树上如鱼得水。"],
        ["图的表示", "邻接矩阵查边快、占空间多；邻接表省空间、遍历快。稀疏用表，稠密用阵，选型先看边的密度。"],
        ["字符串算法", "字符串匹配从暴力到 KMP：暴力法每个位置都试一次，KMP 用已匹配前缀的信息跳过重复比较。失配表的本质是“部分匹配时下一步该回退到哪”。"],
        ["动态规划与递归", "动态规划是带着记账本的递归：把子问题的答案存进表格，每题只解一次。状态定义、转移方程、初始条件，三件套齐了，剩下的都是填表。"],
        ["递归的边界", "递归的三个检查点：基线条件存在、参数严格缩小、组合方式正确。任何一条不满足，递归就从归纳法退化为事故现场。本节是第二十九节，长文的尾巴从这里开始。"],
        ["递归学习总结", "第三十节，也就是最后一节：递归是表达树形思维的默认语法。先信归纳，再读栈帧，最后用测试钉死边界。长文样本至此收束。"],
      ];
      d.heading("长文样本：三十节编程笔记", { font: "songti", size: 18, spaceBefore: 0 });
      d.para("本样本共三十节，每节独占一页，页首是节标记。重复词“递归”集中在第二十七节之后出现。", { ...ZH_BODY, spaceAfter: 6 });
      for (let i = 0; i < sections.length; i += 1) {
        const [topic, body] = sections[i];
        if (i > 0) d.pageBreak();
        d.heading(`第 ${String(i + 1)} 节 ${topic}`, { font: "songti", size: 15, spaceBefore: 0, spaceAfter: 8 });
        d.para(body, { ...ZH_BODY, spaceAfter: 6 });
        d.para(`本节要点回顾：${topic}的核心在于建立正确的模型，先保证正确，再谈优化。第 ${String(i + 1)} 节到此结束。`, { ...ZH_BODY, spaceAfter: 6 });
      }
    },
  },

  /* ------------------------------------------------------------------ */
  {
    id: "pdf-12",
    title: "宽字符样本：扩展区与代理对",
    coverage: ["unicode", "astral"],
    fonts: ["stheiti", "arialu"],
    expectPages: 2,
    build(d) {
      d.heading("宽字符样本：扩展区与代理对", { font: "stheiti", size: 18, spaceBefore: 0 });
      d.para("本页收容 BMP 之外的罕见样本：CJK 扩展 A 区、扩展 B 区（须代理对编码）以及 BMP 末端的替换字符。字体来自系统的黑体子集与 Arial Unicode，两套 CID 字体并行嵌入同一文档。", { ...ZH_BODY, font: "stheiti" });
      d.heading("1. CJK 扩展 B 区（U+20000 起）", { ...ZH_SUB, font: "stheiti" });
      d.para("扩展 B 区样例一：𠀋𠀖𠀪𠀲𠁆。这五个字都位于 U+20000 区段，在 UTF-16 里每个字占两个代码单元，构成一个代理对：高代理 D840 打头，低代理收尾。", { ...ZH_BODY, font: "stheiti" });
      d.para("扩展 B 区样例二：𠀗𠀡𠀧𠀫𠀳𠁀𠁂。同一区段的另一组字符，用于第二处选区断言。两组样例的码位互不重叠。", { ...ZH_BODY, font: "stheiti" });
      d.para("代理对的含义：𠀋 在 UTF-16 中写作一个高代理加一个低代理，共两个代码单元。任何按代码单元计算偏移的选区都必须避免把这对代理拆开；拆开的选区在语义上无效，应当被拒绝而不是被静默取整。", { ...ZH_BODY, font: "stheiti" });
      d.para("再补一组扩展 B 字符作为缓冲：𠀾𠁑𠁔𠀿𠁎。它们的字形罕见，但在规范文本里与常用汉字享有完全平等的地位。", { ...ZH_BODY, font: "stheiti" });
      d.heading("2. CJK 扩展 A 区（U+3400 起）", { ...ZH_SUB, font: "stheiti" });
      d.para("扩展 A 区样例：㐀㐅㒙㓟䶵。它们仍在 BMP 内，单个代码单元即可表示，但字形同样罕见。扩展 A 与扩展 B 的分界就是代理对是否出现的分界。", { ...ZH_BODY, font: "stheiti" });
      d.para("附加符号：〇（U+3007，数字零）与私用区字形（U+F8FF）也一并收进本样本。它们证明样本字体对 BMP 的覆盖并不止于常用区。", { ...ZH_BODY, font: "stheiti" });
      d.heading("3. BMP 末端", { ...ZH_SUB, font: "stheiti" });
      d.para("替换字符样本：U+FFFD 显示为 �。它是 UTF-16 编码空间末端附近少数字体真正覆盖的字符之一，用来兜住无法解码的字节。本行由 Arial Unicode 渲染。", { ...ZH_BODY, font: "arialu" });
      d.para("相邻区位的说明：代理区紧邻的 U+D7FF 与 U+E000 在系统字体中没有可用字形，本样本不冒领这两处覆盖，改以扩展 B 区与 U+FFFD 承担代理对与末端的语义。", { ...ZH_BODY, font: "stheiti" });
      d.heading("4. 收束", { ...ZH_SUB, font: "stheiti" });
      d.para("宽字符样本到此收束：扩展区、代理对与末端字符共处一份材料，任何归一化或代理对拆分都会在这里留下痕迹。若选区断言全部命中，宽字符定位的语义即告闭合。", { ...ZH_BODY, font: "stheiti" });
      d.para("最后一行留给混合：本行以黑体渲染，前一行的替换字符以 Arial Unicode 渲染，两种字体在规范文本里没有留下任何痕迹——字体从来不是文本的一部分。", { ...ZH_BODY, font: "stheiti" });
    },
  },
];
