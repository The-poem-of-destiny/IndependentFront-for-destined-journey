# 内置音频库 `public/audio/`

本目录是**内置音轨库**的挂载点。启动时由前端读取 `manifest.json`，把其中的条目注册为
`source: 'builtin'` 的 `AudioTrack`（读取失败静默跳过，与 `loadBuiltInWorldBooks` 的行为一致）。

内置音轨与用户上传音轨的区别：

- 内置音轨的字节**不进 IndexedDB**，播放时直接用 `file` 指向的相对路径流式播放
- 内置音轨 `builtin: true`，用户**不可删除**，只能隐藏
- 用户上传的音轨走 `audioTracks`（元数据）+ `audioBlobs`（字节）两张表

---

## `manifest.json` 条目格式

`manifest.json` 是一个数组，每个元素形如：

| 字段 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `id` | string | ✅ | 内置音轨的稳定标识，全库唯一。改了等于换一首曲子 |
| `name` | string | ✅ | 显示名（音频库列表 / 迷你播放器标题） |
| `kind` | `'music' \| 'sfx'` | ✅ | 音轨用途。`music` 走音序通道流式播放；`sfx` 走音效声池解码播放 |
| `file` | string | ✅ | 相对本目录的文件路径，如 `bgm/tavern-night.mp3` |
| `tags` | string[] | ✅ | 场景标签。**AI 侧唯一的寻址方式**（`playByTag`），无标签则 AI 永远点不到它 |
| `credit` | string | ✅ | 作者 / 出处署名。CC-BY 素材靠这个字段履约 |
| `license` | string | ✅ | 授权标识，如 `CC0-1.0`、`CC-BY-4.0` |

**示例条目**（仅作格式示范，当前并未收录在 `manifest.json` 中）：

```jsonc
{
  "id": "bgm-tavern-night",
  "name": "夜色酒馆",
  "kind": "music",
  "file": "bgm/tavern-night.mp3",
  "tags": ["酒馆", "夜晚", "日常"],
  "credit": "Some Composer",
  "license": "CC0-1.0"
}
```

---

## 为什么 `manifest.json` 是空的

本仓库受 `《命定之诗》内容二创与素材使用授权协议.md` 约束——该协议管的是世界观内容的二创，
**并不构成任何第三方音频素材的授权来源**。任何随仓库分发的音频，都必须自带一份独立、可核验的
授权：要么是 **CC0**（无需署名），要么是 **CC-BY**（必须在 `credit` 字段署名）。

在有素材完成授权确认之前，本目录**只提供机制、不提供内容**，因此 `manifest.json` 保持为 `[]`。

这样做的代价为零：日后补入已确认授权的音乐，只需

1. 把音频文件放进本目录（建议按 `bgm/` `sfx/` 分子目录）
2. 在 `manifest.json` 里追加对应条目

即可生效——**这是一次数据变更，不需要改任何代码**。
