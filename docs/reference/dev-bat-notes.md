# dev.bat 说明书（改启动器前必读）

开发启动器做两件事：清掉 5173-5179 上的残留 Vite 监听，然后固定端口 5173 启动 Vite。

**它现在有三个文件**（2026-08-14 起，见第六节）：

| 文件              | 角色                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `scripts/dev.mjs` | `npm run dev` 的入口，按 `process.platform` 分发，本身不做任何事   |
| `dev.bat`         | Windows 启动器（本文一到五节全部只讲它）                          |
| `dev.sh`          | macOS / Linux 启动器，行为与 `dev.bat` 一致                       |

这份文档存在的唯一理由：**`dev.bat` 里的注释必须是纯 ASCII**，所以那些用中文写的踩坑记录没地方放，只能搬到这里。（`dev.sh` 没有这个限制，它的注释就写在文件里。）

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

## 五、内容仓模式（D14 跨仓读写，默认自动启用）

内容-引擎分离波 4（D14）之后，`/data/*` 的读取与「保存为默认」的写入默认落在 **公开仓占位内容**（只读）；只有设置环境变量 `POEM_CONTENT_DIR` 时，才指向**内容仓**（真实内容真源）并开放写入。

**默认自动启用**：`dev.bat` 启动时检测引擎仓的兄弟目录 `..\fated_poem_independent_assets\data`（内容仓的 data 子目录）是否存在——存在则自动设 `POEM_CONTENT_DIR` 进入内容仓模式，**无需任何参数**。已显式设置 `POEM_CONTENT_DIR` 时尊重原值，不覆盖。

- `dev.bat --no-content`（或 `npm run dev -- --no-content`）：显式退回占位模式（内容只读、按钮隐藏）
- `dev.bat --content`：历史兼容参数，等价于默认行为
- ⚠️ 注意：`dev.bat` 的 `if not defined POEM_CONTENT_DIR (...)` 用了**括号块内的延迟展开坑**（块内 `if defined` 读的是块开始时的值），所以分支写成无嵌套结构（`%~1`/`%~2` 直接判 `--no-content`，`if exist` 独立成块）——改这段务必保持"每条语句独立一行"的结构，别把 `set` 和 `if defined` 塞进同一个括号块。

### 三条务必知道

1. **路径必须是内容仓的 `data` 子目录**，不是内容仓根。`vite.config.ts` 的 `dataDir = poemContentDir`，中间件 `resolve(dataDir, 'defaults/...')`——传错一级就写不进 `data/defaults/agent-config.json`。
2. **「保存为默认」按钮的出现与否完全由它决定**：`AgentConfigPanel.vue` 的 `canSaveAsDefault = __POEM_CONTENT_DIR__`（vite 编译期布尔）。内容仓存在时按钮自动出现；`--no-content` 或内容仓缺失时按钮隐藏——这是刻意设计（占位内容不允许被 UI 写）。主人想改内容：直接 `npm run dev` 即可（内容仓存在时自动启用）。
3. **跨仓库写入是设计内行为，且是安全的**：内容仓是独立 git 仓库（`E:\code\fated_poem_independent_assets`），写入 = 内容仓出现未提交改动，引擎仓零污染。改完记得去内容仓 git commit。写入路径有 P1-03 越界防御（`relative() startsWith('..') || isAbsolute`），Windows 绝对路径逃逸会被 400 拦下。

### 为什么不能无条件显示按钮

把 `canSaveAsDefault` 改成恒真，等于让「保存为默认」在**占位模式**下也能点——那会把公开仓的 `agent-config.json` 占位文件写脏，而占位内容本应是「首次启动无 pack 时的兜底」，一旦被 UI 覆盖就失去了兜底性质。正确做法始终是：**开发时用内容仓（自动启用），把改动写进内容仓**。

### 坑：本段改动遵守第一节铁律

内容仓分支的注释全部纯 ASCII，`echo` 行保留中文（实测安全）。参数解析用 `%~1`/`%~2` 判 `--no-content`、`if exist` 独立成块——避开 cmd 括号块内 `set` + `if defined` 的延迟展开陷阱（实测：同一块内 `set "NO_CONTENT="` 后 `if not defined NO_CONTENT` 恒真，会让 `--no-content` 失效）。

---

## 六、Mac / Linux 启动器（`dev.sh` + `scripts/dev.mjs`）

2026-08-14 加入，起因是 `"dev": "dev.bat"` 在 macOS 上根本不是一个命令。

### 分发层为什么在 node 里

npm 没有「按平台选 script」的机制，而我们不想为这件事引一个依赖（`cross-env` 之类解决的也不是这个问题）。所以 `package.json` 的 `dev` 指向 `node scripts/dev.mjs`，由它按 `process.platform` 转发，参数原样透传（`npm run dev -- --no-content` 照旧生效）。

两个调用姿势都是刻意的：

- **Windows 走 `cmd.exe /c dev.bat`**，不是直接 spawn。Node 18 起 `spawn` 不再直接执行 `.bat`/`.cmd`（CVE-2024-27980），而 `shell: true` 会多套一层引号解析；显式 `cmd /c` 两头都避开。
- **POSIX 走 `bash dev.sh`**，不是 `./dev.sh`。可执行位在 Windows 检出里经常丢（`core.filemode=false` 是常态），显式用解释器调用就跟文件模式无关了。

父进程把 `SIGINT` 换成空处理：Ctrl+C 在终端里本来就投递给整个进程组，子进程自己收得到；父进程不抢着退，免得把还在收尾的 Vite 变成孤儿。

### `dev.sh` 与 `dev.bat` 的差异（只有一处是实质的）

端口清理换成了 `lsof -ti tcp:<port> -sTCP:LISTEN`。第二节那三个 netstat/findstr 细节**在这里全部不存在**：`-sTCP:LISTEN` 已经把 ESTABLISHED / TIME_WAIT 排除在外（对应细节 2），`lsof` 不区分 IPv4/IPv6（对应细节 1），按端口精确匹配也不会误伤 `:51730`（对应细节 3）。

其余一一对应：内容仓自动检测同样是兄弟目录 `../fated_poem_independent_assets/data`、同样尊重已设的 `POEM_CONTENT_DIR`、同样认 `--no-content`；`ping -n 2` 对应 `sleep 1`。

两个 `dev.sh` 独有的注意点：

1. **`set -euo pipefail` 下 `lsof` 无匹配会当场终止脚本** —— `lsof` 找不到监听时退出码是 1，所以那行必须 `|| true`。同理，收尾那句 `[ -n "$X" ] && echo …` 也不能用短路写法（条件为假时整条语句退出码为 1），已改成 `if` 块。
2. **`lsof` 缺失时不静默失败** —— 走 `command -v lsof` 判断，缺了就打印一行说明并跳过清理；接着 `--strictPort` 会在端口被占时明确报错，而不是让人对着「一闪就崩」猜原因。

### 行尾：`dev.sh` 必须 LF（和 `dev.bat` 正好相反）

根目录 `.gitattributes` 已钉 `dev.sh text eol=lf`。理由与 `scripts/notify.sh` 那条完全相同：shebang 行尾多一个 CR，解释器读到的就是 `/usr/bin/env bash\r` 这个不存在的路径，报 `bad interpreter: ...^M`。**新增任何带 shebang 的脚本都记得往 `.gitattributes` 补一行。**

### 已验证 / 尚未验证

已验证（2026-08-14，Windows 11）：

- `npm run dev` 经分发器走 `dev.bat` 全链路正常：横幅、内容仓自动检测、Vite `HTTP 200`；连开两次实例时第二次打出 `[clean] 杀掉端口 5173 上的进程 PID=…` 并正常接管端口（即分发层没有破坏 `dev.bat` 原有行为）。
- `dev.sh` 在 Git Bash 里真跑通到 Vite ready：横幅、内容仓自动检测、`lsof` 缺失分支的提示、`npx vite` 启动。

**尚未在真机 macOS 上跑过** —— 具体缺的是 `lsof` 那条端口清理分支（Git Bash 没有 `lsof`，走的是跳过分支）与 macOS 本身的表现。见根目录 `TODO.md` 的 Mac 兼容条目。

### 顺带：别在 Git Bash 里用 `dev.sh` 当日常启动器

上面那次 Git Bash 实跑暴露了一个只在 Windows 上成立的问题：MSYS 把自动检测出的内容仓路径给成了 `/e/Projects/...`，而 `vite.config.ts` 里的 `resolve()` 按 Windows 语义会把它解成 `E:\e\Projects\...`（不存在），于是 `/data` overlay 静默指向空目录。**Windows 上请始终走 `npm run dev`（分发到 `dev.bat`）**；`dev.sh` 只为 macOS / Linux 存在。
