---
name: dexie-stores-cumulative
description: database.ts 的 v12 注释「Dexie 每版漏写表即删表」是错的——Dexie 4 的 stores() 跨版本累加；删表必须显式 `表名: null`
metadata:
  type: project
---

`src/sillytavern/database.ts` 的 v12 版本块上方写着「注意: Dexie 要求每版重述完整 schema，
漏写任一表即为删表（静默毁数据）」。**这句话对 Dexie 4 不成立。**

**Why:** Dexie 4.4.3 的 `Version.prototype.stores()` 逐版 `extend(storesSpec, version._cfg.storesSource)`
累加出 schema（`node_modules/dexie/dist/dexie.js` 约 4096 行）。后一版没提到的表从前一版继承下来，
数据一根毛都不掉。真要删表只有一条路：显式写 `表名: null` —— 本文件里 v9 的 `chats: null`
就是唯一的删表先例，这本身就是反证。已实测: 把 `audioPlaylists` 从 v13 块里整行删掉，
`database.test.ts` 96 测全绿、数据全在；改成 `audioPlaylists: null` 才炸出 6 个失败。

**How to apply:** 加新表继续按惯例重述全部旧表（v4–v13 都这么写，一眼可见完整形状，保持一致），
但**别再把「漏写=毁数据」当作论据**去推导别的结论 —— 比如别为此写"schema 完整性"运行时校验，
也别据此认为升版是高危操作。想写真正有价值的升版守卫，测**表册齐全**
（`db.tables.map(t => t.name)` 比对期望清单）而不是测"某版块里有没有写全" ——
前者能抓到误写 `表名: null` 和新表漏声明，后者抓不到任何真实故障。
`database.test.ts` 的「v13 升版不得丢数据」测试就是按这个思路写的，注释里也记了这件事。
