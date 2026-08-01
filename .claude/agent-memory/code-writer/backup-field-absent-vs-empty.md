---
name: backup-field-absent-vs-empty
description: 给 FullBackup 加新表字段时，importAllData 必须区分「字段缺席」与「空数组」——照抄既有段的 clear-then-guard 会让旧备份清空新表
metadata:
  type: feedback
---

往 `FullBackup` / `doImportAllData()` 加新表时，**不要照抄既有各段的写法**（`await 表.clear()` 在前、`if (Array.isArray(...)) bulkPut` 在后）。必须按字段**存在与否**分流三态：

- `undefined`（旧版本备份里根本没这个字段）→ **整张表原样不动，连 clear 都不执行**
- `[]`（字段存在但为空）→ 合法的「用户确实没有」，照常 clear
- 有数据 → 正常覆盖

禁止用 `?? []` 把 `undefined` 抹平成 `[]`——那等于选了最坏的一支。

**Why:** 既有各段之所以能无条件 clear，是因为那些表**从一开始就在备份里**，旧备份的空值和「用户真没有」同义。新加的表不是——它有一段「数据已在库里、但备份格式还不认识它」的历史窗口。v14 加 `worldBooks` 时我照抄了 clear-then-guard，独立审查指出：导入一份 pre-v14 备份会清空整张 worldBooks 表，用户导入的书/自建的书/对内置书的编辑**永久丢失**（内置书还能 fetch 回来，用户的不能）。守卫写在 clear 之后等于没守。

**How to apply:** 每次给 `FullBackup` 加字段都过一遍这个判断；`validateBackupOrThrow` 的 `arrayFields` 也照旧只在「存在且非数组」时报错，别改成必填。测试要写满三态 × 每个新字段，并且做一次变异验证（把守卫挪回 clear 之后，「缺席」那几条必须变红）——见 [[reactive-store-mock-vacuous]] 同样的空断言教训。
