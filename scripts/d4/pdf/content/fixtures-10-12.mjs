import { ZH_BODY, ZH_SUB, EN_BODY } from "./typography.mjs";

/** B1 fixture definitions pdf-10 through pdf-12; literal build() routines preserved. */
export const FIXTURE_GROUP = [
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
