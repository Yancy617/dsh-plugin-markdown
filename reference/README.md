# `reference/` — 上游规范正文（逐字副本）

这个目录放**不是本项目写的东西**：上游规范的正文，逐字复制，供仪器与查证引用。
它**不进产物、不进依赖**（`package.json#files` 是白名单，本目录不在其中），只在仓库里。

## 里面有什么

| 文件 | 是什么 | 出处 |
|---|---|---|
| `CommonMark-0.31.2-spec.txt` | **CommonMark 0.31.2 规范全文**（官方 `spec.txt`，652 个 example） | <https://spec.commonmark.org/0.31.2/spec.txt> |

## 许可与署名（必读，改文件前读）

`CommonMark-0.31.2-spec.txt` 是 **John MacFarlane** 的著作，按
**[Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/)（CC BY-SA 4.0）**
发布（出处见页首的 CC 标记）。本仓库**逐字转载、未作修改**。

再分发本文件时必须保留署名、许可链接、免责声明，并标明是否修改。**满足条件所需的一切都在本文件里**
（署名、许可链接、免责声明、`NO WARRANTY` 声明、出处 URL，以及"未修改"的明确声明），
所以只保留本文件这一份即可，不必另外补通知。

> ⚠️ **正文一个字都不许改。** 项目里那句"**路径必须真的在仓库里**"靠它兑现：
> `scripts/audit-gfm.ts` 从这里切出全部 652 例，`docs/规格核验-读数.md` 与
> `docs/技术基线与决策记录.md` 里的逐字引用也都指向它。改一个字节，那些读数就不再是同一个东西量的。
> 规范升版时**新增**一份带版本号的文件（`CommonMark-0.32.0-spec.txt`），不要覆盖——旧读数是按旧版量出来的。

## 与 `docs/` 的分工

`docs/` 写**结论**，`reference/` 存**上游正文**。本项目自己的查证笔记与研究报告仍在
`_research/`（**不进仓库**）；本目录只放"别人写的、我们逐字引用的"东西。
