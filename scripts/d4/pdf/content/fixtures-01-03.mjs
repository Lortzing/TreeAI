import { ZH_BODY, ZH_SUB, EN_BODY } from "./typography.mjs";

/** B1 fixture definitions pdf-01 through pdf-03; literal build() routines preserved. */
export const FIXTURE_GROUP = [
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


];
