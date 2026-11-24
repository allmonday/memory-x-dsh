# memory-x-dsh

> 一棵给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的长期记忆树 —— 给模型提供 `memory_*` 读写工具，把目录注入提示词并按轮召回相关记忆，再在侧边栏放一个只读面板查看目录、版本历史与差异。

**你掌舵，它记图** —— 你在 DSH 里正常工作；值得长期记住的结论、决策、实体关系，被写进一棵以 SQLite 为真相、可检索、可回滚、可"整理"的记忆树。下次会话，目录常驻提示词，相关记忆自动召回。

树引擎来自 [memory-x](https://github.com/allmonday/memory-x) 的 `@memory-x/core`（MIT），以源码形式放在 `core/`。本仓库新增的是 DSH 集成：工具、提示词贡献、按会话隔离的写保护，以及 Web 面板。

## 功能

**模型侧：十四个 `memory_*` 工具**

| 工具 | 作用 |
| --- | --- |
| `memory_read` | 把一棵子树读成 Markdown 大纲。 |
| `memory_search` | 检索；每条命中带完整路径、祖先与片段。 |
| `memory_upsert` | 新增一条事实；完全重复则忽略，缺失的父节点自动创建。 |
| `memory_update` | 原地替换一条事实，避免旧事实堆积。 |
| `memory_write_note` | 写节点的长文 Markdown 正文。 |
| `memory_summary` | 读或写节点的一行导航摘要。 |
| `memory_history` | 节点的历史取值，按版本新到旧。 |
| `memory_changes` | 按版本分组的近期变更，值级 `old → new`。 |
| `memory_move` / `memory_delete` | 重构或删除子树，都留在历史里。 |
| `memory_diary` | 某一天的活动，模型总结后缓存。 |
| `memory_stats` | 节点数、叶子数、深度、顶层域。 |
| `memory_evidence` / `memory_link_evidence` | 把一条事实关联到支撑它的会话事件。 |
| `memory_propose` | 把一份整理计划作为一个版本应用。 |

每条叶子写入时自动盖上日期，模型不必自己记。

**提示词侧**

- **目录**：树的标题与叶子数、何时读/写/替换的规则、写入风格，字符预算由 `catalogMaxChars` 控制。
- **召回**：每轮最多三条与用户消息匹配的记忆，阈值 `recallMinScore`；它是动态上下文，跟着所属的那一轮走。

**锚定（写保护）**

| `anchor` | 行为 |
| --- | --- |
| `off` | 不注入协议，不设保护。 |
| `hint`（默认） | 提示词要求先解析并读取节点再写；写入本会话没读过的节点、或在目标子树外疑似重复，会返回警告。 |
| `strict` | 没读过的节点直接拒绝写入。 |

**面板与命令**

侧边栏的「记忆树」有三个标签：**目录**（树 + 搜索 + 右侧详情）、**版本**（版本历史与彩色 diff）、**体检**（深度、超大节点、重名标题）。面板只读：写入是对话的工作，回滚通过可复制的 `/memory rollback <id>` 命令完成。

```
/memory                   目录与规模
/memory stats             节点数、叶子数、数据位置
/memory log [n]           版本历史
/memory changes [n|#id]   近期变更，或某个版本的全量行
/memory rollback <id>     回滚（写入新版本，历史保留）
/memory lint              结构问题
/memory diary <date>      某一天的活动
```

## 安装

**前置**：DSH 桌面版或 Web 版；Node ≥ 22.6（引擎依赖内置的 `node:sqlite`）。

在 DSH 的 **Plugins › Add plugin** 里填入本仓库：

```
github:allmonday/memory-x-dsh
```

或者让 DSH 里的助手执行：用 `plugin_manager` 的 `install_bundle` 安装上面这个 spec。安装后新开一个会话即可看到 `memory_*` 工具与侧边栏入口。

**从源码目录安装（开发时）**：

```bash
git clone https://github.com/allmonday/memory-x-dsh.git
```

再把克隆出来的目录绝对路径作为 `install_bundle` 的 `target`。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `dataDir` | `~/.dsh/memory-x/memory` | 存放 `.memory/memory.db` 的目录。 |
| `anchor` | `hint` | 锚定协议强度：`off` / `hint` / `strict`。 |
| `recallMinScore` | `1.0` | 召回注入阈值，调高则注入更少。 |
| `catalogMaxChars` | `1600` | 目录在提示词中的字符预算。 |

默认位置与 pi 安装的 `~/memory-x/memory` 分开：两个进程同时写一个 SQLite 文件，是文件锁无法保证安全的唯一情形。把 `dataDir` 指向已有的 memory-x 目录可以沿用那棵树，但不要让 pi 与 DSH 同时使用它。

更多细节见 [docs/DETAIL.md](docs/DETAIL.md)。

## 开发

```bash
npm test                       # DSH 测试 + 从 memory-x 移植的核心测试套件
npm run build:core             # 由 core/*.ts 重新生成 core/*.js
npm run check:core             # 校验已提交的 core/*.js 没有过期
node scripts/port-upstream-tests.mjs <memory-x 检出目录>   # 同步 memory-x 的核心测试
node scripts/backup.mjs --label before-upgrade              # 一致性备份记忆库
```

仓库直接提交 `core/*.js`：插件以纯 ESM 发布，安装不需要任何构建步骤。`core/` 与 memory-x 上游同步时，重新移植测试套件，使回归网与引擎一致。

## 隐私

记忆库只存在本机 `dataDir` 下，本仓库不收集、不上传任何数据；面板通过 DSH 页面自身源上的一个只读 JSON 路由取数，没有写入端点。

## License

[MIT](LICENSE)
