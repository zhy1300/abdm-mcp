# abdm MCP 下载器 — 安装说明

一个给 DSH（DeepSeek Harness）用的 **MCP 下载工具**：多连接分段下载 + sha256 校验 + 队列/进度查询。

**对方只需要装 DSH，别的什么都不用装。** 运行时用的是 DSH 自带的 Node.js
（`<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`），
不需要单独装 Node、不需要 AB Download Manager。

## 三步装好

1. 把压缩包解压到任意目录，例如 `C:\tools\abdm\`（必须是**本地磁盘**，别放网络盘）。
2. 右键 PowerShell 或 CMD，运行：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File C:\tools\abdm\install.ps1
   ```
   它会自己完成：找到 DSH 自带的 node → 找到 DSH 的 profile 配置 → 先跑一次 MCP 握手自检 → 把配置块写进 profile（自动备份）。
3. **重启 DSH 桌面端**（工具表要重启才刷新）。

重启后工具出现在会话里：`mcp__abdm__abdm_download` / `abdm_list` / `abdm_status`。

## 常用参数

| 参数 | 作用 |
|---|---|
| `-WhatIf` | 只打印要写入的配置，不改文件 |
| `-Force` | profile 里已有 `abdm` 块时强制重写（默认跳过） |
| `-Uninstall` | 从 profile 移除本工具的配置块（不动其他条目） |
| `-NodePath "C:\...\node.exe"` | 指定运行时（默认自动找 DSH 自带的那个，其次 `runtime\node.exe`，最后 PATH 里的 `node`） |
| `-Profile "C:\...\cordis.patch.yml"` | 指定要改的 profile 文件（默认自动探测 `$DSH_HOME`、`E:\dsh-home`、`%USERPROFILE%\.dsh`、`%APPDATA%\dsh`） |
| `-SkipVerify` | 跳过安装前的握手自检 |

## 验证

装完后让 agent 跑：

```
abdm_status                                  # 看引擎状态、线程数、代理
abdm_download(url=["https://.../file.zip"], outDir="C:\tmp\dl", hash=true)
```

返回 `ok:true`（传了 `sha256` 则是 `sha256Verified:true`）就算通。

## 出问题怎么查

- **重启后没有工具**：确认 profile 文件里确实多了一段 `- id: abdm`；`$DSH_HOME\profiles\desktop\cordis.patch.yml` 是常见位置。
- **`no Node.js runtime found`**：DSH 装在非标准位置时，用 `-NodePath` 明确指定 node.exe。
- **下载很慢**：公司网络/被墙时设环境变量 `HTTPS_PROXY=http://127.0.0.1:7890`，或调用时传 `proxy:"http://127.0.0.1:7890"`。
- **端口占用**：本工具是 stdio 进程，**不监听任何端口**。真正监听 15151 的是可选的 AB Download Manager。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\tools\abdm\install.ps1 -Uninstall
```

然后重启 DSH，再把 `C:\tools\abdm\` 目录删掉即可。
## 鸣谢

- ab-download-manager下载器创作者，本项目是基于ab-download-manager二次开发，原仓库地址为https://github.com/amir1376/ab-download-manager
