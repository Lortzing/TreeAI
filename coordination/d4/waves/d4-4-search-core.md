# D4-4 找回既有思考 —— 搜索引擎内核（wip/d4-4-search-core）

登记：2026-09-30；分支 `wip/d4-4-search-core`（基于 main `a6f411d`，独立
worktree `.claude/worktrees/d4-4-search-core`）。本文件是波次交接说明：交付面、
刻意不做面、设计决策与集成清单。

## 交付内容（本分支仅三处新增，零修改既有文件）

1. `apps/studio/src/search/search-engine.ts` —— `LocalSearchEngine`：
   本地确定性全文检索引擎**纯内核**（零 npm 依赖、零 IO、零框架绑定）。
   - 匹配：中文子串/词语（无分词依赖）；英文/代码整词（`tree` 不命中
     `street`/`trees`，大小写按确定性 toLowerCase 折算）；两档——
     phrase（整串精确，英文两端词边界）优先于 segments（中文段+英文词
     全部在场、不要求连续）；无任何 Unicode 归一化（全角/组合字符按原
     码位，与 B1 fixture 纪律同源）。
   - 排序全序（文件头有完整论证）：phrase 档 → 来源类型
     （annotation < return < turn < material）→ 命中次数 → createdAt
     降序 → refId 升序（终极稳定锚，与输入顺序无关）。
   - 倒排：中文一元+相邻二元 gram（含星面代理对）+ 拉丁整词；查询先
     求交收窄候选，再在候选正文上精确验证——索引只收窄，验证才裁决。
   - 范围：`search(text, { treeId, kinds, limit })`；treeId=null 全部树
     （「当前 Tree 默认」是 API 层决策，引擎只收显式范围）。
   - 无结果不编造：零命中恒为空数组。
2. `apps/studio/tests/search-engine.test.ts` —— 14 个 node:test 用例，
   含 B4 冻结集**全量机械执行**（见下）与单元语义（中/英匹配、范围、
   类型过滤、旧版本标注、诚实空结果、确定性重建/序列化往返/乱序输入、
   排序全序、材料命中定位、输入校验 fail-fast）。
3. 本波次说明（本文件）。

## B4 冻结集执行结果（engine 层，2026-09-30 本 worktree 实测）

- 语料：`tests/fixtures/d4/b4-search/facts.json` 全部 35 条种子事实
  （3 棵树；材料片段经 materialKey 钉在 B1 冻结真值 canonicalText，测试
  内构造性复核切片全等，同 d4-probes §7 纪律）。
- 55 条正向查询：**55/55 目标 factId 进入前 5**（实测最差名次第 3；
  charter B4 下限为 95% 即 ≥53 条）。断言锁死 55/55——任何回退在此
  显式失败，不允许静默降级。
- 12 条无结果查询：**12/12 零命中**，无编造。
- 回归：`npm ci` + `npm run typecheck` 绿；studio 套件 206/206；根
  `npm test` 全绿（8 个套件共 556 用例）；`verify:d4` 9 PASS / 0 FAIL /
  8 NOT_RUN（基线不变）。

## 刻意不做（归集成侧/后续波次）

- **迁移 0010（search-index）登记**：不改 `packages/persistence/**`
  （迁移正被并行波次重编号，0009 已归术语账本，0010 按更正记录归
  search）。schema 与登记由集成侧定，建议见下。
- **HTTP 接线**：`apps/studio/src/server.ts` 的
  `POST /api/trees/:treeId/search` 与 `POST /api/search`（契约 §3）。
- **索引持久化与重建命令**：charter §4「索引可从产品数据 npm run 命令
  重建；索引删除重建是 B5 故障注入项」。
- **verify:d4 的 b4-cross-material-find 翻绿**：仍诚实 NOT_RUN（引擎层
  冻结集执行已由上述 studio 测试承担；门禁执行面按 owner 标记归 D4-4
  接线后翻绿）。
- 前端搜索 UI、结果跳转（B4 的「来源跳转正确率 100%」需 HTTP/UI 层）。
- 不动 `package.json`、任何 fixture（冻结集纪律）。

## 设计决策（接线需要知道的）

- **文档模型**：一个文档 = 一条被索引的已保存产品事实。建议 refId 取
  `${treeId}:${kind}:${事实行 id}`（材料可取 versionId）；批内唯一。
  材料按**版本**入索引（同材料多版本 = 多文档），`oldVersion` 由版本链
  推导（非当前版本 true）——B1 版本对单测已验证 v1-only 句子命中标注
  true、当前版 v2 命中 false、共享文本当前版排序在前。
- **正文构造**：材料 = 版本 canonicalText **全文**（命中 start/end 即
  canonicalText UTF-16 偏移，可直接跳转；blockId = 命中起点所在块，
  需在文档上带块覆盖）；批注 = explanation+term+note（d4-probes §7 的
  真值拼接序）；Return/Turn = text。**标题不参与匹配**（与冻结真值口径
  一致），只在结果中展示。
- **B4 旧版本查询的语义**：冻结集把 old-version 查询的预指定目标定为
  「引用旧句的批注事实」（批注 note 保留 v1-only 句子）——引擎照常命中
  批注；oldVersion 标注只对材料文档（版本链）有意义，非材料命中恒 false。
- **SearchHit 映射**：引擎结果携带契约 §3 全部字段（可选字段以显式
  null 表达）+ 附加 refId/matchType/matchCount；HTTP 层按契约裁剪 null
  与附加字段。
- **索引表示**：`serialize()` = `{ version: 1, documents }`（文档快照，
  即未来 0010 表行的 JSON 形态）；`restore()` 走同一 build 校验并**在
  进程内确定性重建倒排结构**——序列化面不含派生数据（charter：索引不是
  事实源）。**建议**：0010 表直接存文档行（或 body 引用
  material_versions.canonical_text 避免双份长文），启动时 build 重建；
  若最终决定不需要库内索引表，按 README 规则记录弃用原因并保持编号连续。

## 集成清单

1. 登记/落迁移 0010（见上建议；`assertContiguous` 连续性）。
2. server.ts 接两个搜索端点：默认范围=当前树（path 参数树），`POST
   /api/search` 为全部树；`{text, kinds}` 入参 → 引擎选项；结果裁剪为
   契约 SearchHit。
3. 文档源装配（只索引已保存产品事实）：材料版本（含旧版本，oldVersion
   推导）× tree_material_links、批注、Return、Turn。
4. 索引重建命令 + B5 故障注入（删索引重建后结果逐字一致——引擎的
   确定性测试已覆盖重建/往返/乱序全等）。
5. verify:d4 b4-cross-material-find 由 NOT_RUN 翻为执行（引擎层 55/55
   已绿；接线后按门禁口径跑 HTTP 面或直接复用引擎层结果）。
6. 前端：结果跳转（材料命中带 versionId+blockId+start/end；批注/
   Return/Turn 命中按 refId 回事实），跳转后可继续原探索；session 不可
   用时显式新探索入口（复用 W1 §3.4）。
