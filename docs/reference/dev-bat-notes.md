# dev.bat 说明书（改启动器前必读）

`dev.bat` 是开发启动器（`npm run dev` / 双击都走它）。它做两件事：清掉 5173-5179 上的残留 Vite 监听，然后固定端口 5173 启动 Vite。

这份文档存在的唯一理由：**`dev.bat` 里的注释必须是纯 ASCII**，所以那些用中文写的踩坑记录没地方放，只能搬到这里。

---

## 一、铁律：dev.bat 内的注释一律纯 ASCII

### 现象

`chcp 65001` 之后，cmd.exe 的批处理解析器会和 UTF-8 多字节文本**错位**，于是 `::` 注释行的片段被当成命令执行。

实测（2026-07-30，Windows 11，系统 OEM 代码页 936）：

| 版本 | stdout | stderr | 症状 |
|------|--------|--------|------|
| `f289615`（更早） | 25 B（横幅被打烂，只剩残渣） | 848 B | 注释里的 `netstat` 真的被执行 |
| `1875d1c`（修复前） | 168 B | **940 B** | 注释里的 `findstr` 真的被执行 3 次 |
| 现版本 | 168 B | **0 B** | 干净 |

`1875d1c` 版实际漏到 stderr 的片段（节选）：

```
'须配' is not recognized as an internal or external command,
'的参数当成**空格分隔的模式列表**来解析，' is not recognized as an internal or external command,
FINDSTR: Cannot open ֻ����
FINDSTR: Cannot open :5173
```

最后两行不是"报错"，是**注释里那句 `实测: findstr ":5173 " → …` 被真的跑起来了**。

### 为什么危险

不是观感问题。这个脚本里有 `taskkill /PID %%A /F`。一个能让注释变成命令的解析器，加上一条会强杀进程的命令，中间只隔着一个字节偏移。同时它还会把真正的报错埋进噪音里。

### 复现方式

不是所有调用方式都能复现——**取决于调用时的控制台代码页与句柄形态**。已知能稳定复现的姿势（Git Bash 下）：

```bash
MSYS_NO_PATHCONV=1 cmd.exe /c "C:\path\to\dev.bat" > out.txt 2> err.txt < /dev/null
```

而 PowerShell 的 `Start-Process -RedirectStandardError`，以及先 `chcp 936` 再 `call` 的包装写法，**都测不出来**（stderr 恒为 0）。所以"我这儿跑着没事"不构成这个 bug 不存在的证据。

### 修法与边界

把注释全部改成 ASCII/英文，中文说明搬来本文件。**`echo` 行的中文保留**——那是用户真正看得见的输出，且实测保留后 stderr 仍为 0（包括 `for` 块内那行 `[clean] 杀掉端口 …`，已在真实占用端口的场景下验证过）。

结论：**多字节文本出现在 `echo` 参数里是安全的，出现在 `::` 注释里是危险的。** 加注释时请写英文。

---

## 二、端口清理那三个细节（都是踩出来的）

```bat
for %%P in (5173,...,5179) do (
    for /f "tokens=5" %%A in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr /C:":%%P "') do (
        taskkill /PID %%A /F >nul 2>&1
    )
)
```

### 1. 不写死 `127.0.0.1`

Vite 在 Windows 上默认监听的是 IPv6 回环 `[::1]:5173`。只匹配 IPv4 会一个都杀不掉；接着 `--strictPort` 撞上占用直接退出，表现就是"dev.bat 一闪就崩"。

实测 netstat 行长这样：

```
  TCP    [::1]:5173             [::]:0                 LISTENING       148428
```

### 2. 先筛 `LISTENING` 再匹配端口

监听行的外部地址恒为 `0.0.0.0:0` / `[::]:0`，所以不会误伤"远端端口恰好是 `%%P`"的 ESTABLISHED / TIME_WAIT 连接。

### 3. 端口号后面那个空格必须配 `/C:` 才生效，缺一不可

netstat 的本地地址列左对齐补空格，只有靠这个尾随空格才分得开 `:5173` 和 `:51730` / `:51734`。

但 findstr **不带 `/C:`** 时，会把带引号的参数当成**空格分隔的模式列表**来解析，尾随空格因此被当作分隔符丢掉，实际生效的只剩裸子串 `:5173` —— 于是 51730-51799 上任何监听进程都会被 `taskkill /F` 掉（5174..5179 那几轮还会继续放大命中面）。

`/C:` 表示"整个参数按字面量匹配"，空格才真正参与比较。

夹具实测（4 行 netstat 样本，含 `:5178` / `:51780` / `:51784` / `:5179`）：

```
=== WITHOUT /C: ===          === WITH /C: ===
  would kill PID=11111         would kill PID=11111
  would kill PID=22222       （只此一条）
  would kill PID=33333
```

不带 `/C:` 会误杀两个无关进程。

---

## 三、不要用 `timeout /t`

`taskkill` 需要一点落地时间，但**不要用 `timeout /t`** —— 它在 stdin 被重定向时（`npm run dev`、CI、任何把输出接管道的调用）会直接报：

```
ERROR: Input redirection is not supported, exiting the process immediately.
```

`ping -n 2 127.0.0.1 >nul` 是没有这个毛病的等价写法。

---

## 四、行尾必须是 CRLF

`dev.bat` 是 CRLF。写成 LF 会让 cmd.exe **完全无法解析**这个文件。用 Edit 工具改，别用会重写整份文件的方式；改完用 `file dev.bat` 确认仍是 `with CRLF line terminators`。

---

## 五、内容仓模式 `--content`（D14 跨仓读写）

内容-引擎分离波 4（D14）之后，`/data/*` 的读取与「保存为默认」的写入默认落在 **公开仓占位内容**（只读）；只有设置环境变量 `POEM_CONTENT_DIR` 时，才指向**内容仓**（真实内容真源）并开放写入。

`dev.bat --content`（或 `npm run dev -- --content`）就是干这个的：未显式设置 `POEM_CONTENT_DIR` 时，自动指向引擎仓的兄弟目录 `..\fated_poem_independent_assets\data`（内容仓的 data 子目录）。已显式设置则尊重原值，不覆盖。

### 三条务必知道

1. **路径必须是内容仓的 `data` 子目录**，不是内容仓根。`vite.config.ts` 的 `dataDir = poemContentDir`，中间件 `resolve(dataDir, 'defaults/...')`——传错一级就写不进 `data/defaults/agent-config.json`。
2. **「保存为默认」按钮的出现与否完全由它决定**：`AgentConfigPanel.vue` 的 `canSaveAsDefault = __POEM_CONTENT_DIR__`（vite 编译期布尔）。不带 `--content` 时按钮不渲染——这是刻意设计（占位内容不允许被 UI 写）。主人想改内容：`npm run dev -- --content` 即可，按钮自然出现。
3. **跨仓库写入是设计内行为，且是安全的**：内容仓是独立 git 仓库（`E:\code\fated_poem_independent_assets`），写入 = 内容仓出现未提交改动，引擎仓零污染。改完记得去内容仓 git commit。写入路径有 P1-03 越界防御（`relative() startsWith('..') || isAbsolute`），Windows 绝对路径逃逸会被 400 拦下。

### 为什么不能无条件显示按钮

把 `canSaveAsDefault` 改成恒真、或去掉 `--content` 分支，都等于让「保存为默认」在**占位模式**下也能点——那会把公开仓的 `agent-config.json` 占位文件写脏，而占位内容本应是「首次启动无 pack 时的兜底」，一旦被 UI 覆盖就失去了兜底性质。正确做法始终是：**开发时用 `--content` 指向内容仓，把改动写进内容仓**。

### 坑：本段改动遵守第一节铁律

`--content` 分支的注释全部纯 ASCII，`echo` 行保留中文（实测安全）。参数解析用 `for %%A in (%*)` 匹配 `--content`——不带参数时 `%*` 为空、循环不执行、变量不设置，行为与旧版完全一致。
