# DeepSeek CLI (`dsk`)

基于 DeepSeek API 的终端 AI 工具，支持流式输出和 Markdown 渲染。
兼容 **Termux**、**Linux**、**Windows**。

---

## 安装

### Windows（完整步骤）

**第一步：安装 Node.js**

打开 PowerShell（按 `Win + R`，输入 `powershell`，回车），运行：

```powershell
winget install OpenJS.NodeJS.LTS
```

等安装完成后，**关掉 PowerShell，重新打开一个新窗口**（必须重开，否则环境变量不生效）。

验证安装成功：

```powershell
node --version   # 应该显示 v20.x.x 或更高
npm --version    # 应该显示版本号
```

**第二步：下载项目**

```powershell
git clone https://github.com/Hacky4212/agent.git
cd agent
```

如果没有 git，先安装：

```powershell
winget install Git.Git
```

安装完同样需要重开 PowerShell。

**第三步：安装依赖并编译**

```powershell
npm install
npm run build
```

`npm install` 会下载依赖包（需要网络），`npm run build` 把 TypeScript 编译成可执行文件，完成后会出现 `dist/` 目录。

**第四步：注册全局命令**

```powershell
npm link
```

这一步把 `dsk` 命令注册到系统 PATH 里。**`npm link` 完成 = 安装成功**。

验证：

```powershell
dsk --version   # 显示 1.0.0 说明安装成功
```

> 如果 `npm link` 报错 "需要管理员权限"，右键 PowerShell → "以管理员身份运行"，然后重新执行 `npm link`。

**第五步：设置 API Key**

```powershell
dsk config set api-key sk-你的key
```

**完成。直接输入 `dsk` 开始对话。**

---

### Linux

```bash
# 1. 安装 Node.js 18+
#    Ubuntu / Debian：
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

#    Arch：
sudo pacman -S nodejs npm

# 2. 克隆项目
git clone https://github.com/Hacky4212/agent.git
cd agent

# 3. 安装依赖并编译
npm install
npm run build

# 4. 注册全局命令
npm link
# 如果不想用 sudo，配置用户级 prefix：
# npm config set prefix ~/.npm-global
# echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc
# source ~/.bashrc
# npm link

# 5. 设置 API Key
dsk config set api-key sk-你的key
```

---

### Termux（Android）

```bash
# 1. 安装 Node.js
pkg install nodejs

# 2. 克隆项目
git clone https://github.com/Hacky4212/agent.git
cd agent

# 3. 安装依赖并编译
npm install
npm run build

# 4. 注册全局命令
npm link

# 5. 设置 API Key
dsk config set api-key sk-你的key
```

> **如果 `npm link` 报权限错误：**
> ```bash
> npm config set prefix ~/.npm-global
> echo 'export PATH=$HOME/.npm-global/bin:$PATH' >> ~/.bashrc
> source ~/.bashrc
> npm link
> ```

---

## 更新到最新版本

已经装过的设备，更新只需三步：拉新代码 → 装依赖 → 重新编译。

```bash
# 进入项目目录
cd agent          # 或你当初 clone 的路径

# 1. 拉取最新代码
git pull

# 2. 安装可能新增的依赖
npm install

# 3. 重新编译
npm run build
```

**完成。`npm link` 不需要重新运行**——它是一个指向 `dist/` 的符号链接，`npm run build` 更新了 `dist/` 之后，`dsk` 命令自动就是新版本。

验证更新成功：

```bash
dsk --version
```

> **如果 `git pull` 报冲突**（比如你本地改过配置文件），先暂存或丢弃本地改动：
> ```bash
> git stash      # 暂存本地改动
> git pull
> git stash pop  # 恢复本地改动（可能需要手动解决冲突）
> ```
> 注意：你的 API Key 和配置存在系统配置目录里，**不在项目文件夹**，所以 `git pull` 不会覆盖它们，更新后配置照常保留。

---

## 使用

### 直接启动交互式对话

```bash
dsk
```

就这一个命令，进入多轮对话模式。

```bash
# 换模型启动
dsk -m deepseek-v4-flash

# 关闭推理思考，更快
dsk --no-think

# 带系统提示词
dsk -s "你是一个资深后端工程师，用中文回答"

# 预先加载文件进上下文
dsk -f main.py
```

### 单次提问（用完退出）

```bash
dsk ask "帮我写一个快速排序"

# 指定推理深度
dsk ask --effort max "证明勾股定理"

# 关闭推理模式
dsk ask --no-think "今天天气怎么样"

# 读取文件让 AI 分析
dsk ask -f main.py "帮我 review 这段代码"

# 同时读取多个文件
dsk ask -f a.py b.py c.py "这三个文件有什么关联"
```

### 管道输入

```bash
# 把命令输出传给 AI
cat error.log | dsk ask "这个报错什么原因"

# 让 AI 解释某个文件
cat README.md | dsk ask "用中文总结一下"

# 没有提问时，直接分析传入内容
echo "SELECT * FROM users WHERE id=1" | dsk
```

### 交互模式斜杠命令

进入 `dsk` 后可以用：

| 命令 | 说明 |
|---|---|
| `/help` | 显示所有命令 |
| `/clear` | 清空对话记录 |
| `/model deepseek-v4-pro` | 切换模型 |
| `/think [on\|off]` | 开关推理思考模式 |
| `/effort [high\|max]` | 调整推理深度 |
| `/system 你是一个诗人` | 更改系统提示词 |
| `/file main.py` | 把文件附加到下一条消息 |
| `/save 对话.md` | 把对话导出为 Markdown 文件 |
| `/history` | 查看历史对话列表 |
| `/usage` | 开关 token 用量显示 |
| `/exit` | 退出（也可以按 Ctrl+D） |

取消正在生成的回答：按 `Ctrl+C`

---

## 推理思考模式

DeepSeek V4 Pro 默认开启最大深度推理（等同于 Claude xhigh），回答前会先进行完整的思维链推理，终端显示推理过程（灰色块），然后给出最终答案。

```bash
# 全局调整
dsk config set thinking true
dsk config set reasoning-effort max   # max = Claude xhigh，high = 更快

# 单次关掉推理
dsk ask --no-think "随便问个问题"
dsk --no-think   # 整个会话关掉推理
```

| effort | 说明 |
|---|---|
| `max` | **默认**，最大推理深度，等同于 Claude xhigh |
| `high` | 推理质量高，速度更快，适合大多数场景 |

---

## 配置管理

```bash
dsk config list                                   # 查看所有配置
dsk config set api-key           sk-...           # API Key
dsk config set model             deepseek-v4-pro  # 默认模型
dsk config set temperature       1.0              # 随机性 0-2
dsk config set max-tokens        8192             # 最多生成 token 数
dsk config set show-usage        true             # 显示 token 用量
dsk config set thinking          true             # 默认开启推理思考
dsk config set reasoning-effort  max              # 推理深度
dsk config path                                   # 查看配置文件路径
dsk config reset                                  # 恢复所有默认值
```

### 全局系统提示词

全局系统提示词会在每次对话开始时自动注入，影响模型的所有回答风格和行为。

**查看当前提示词：**

```bash
dsk config list   # systemPrompt 那一行
```

**修改提示词（短提示词直接写）：**

```bash
dsk config set system-prompt "你是一个 Linux 专家，用中文回答，回答要简洁"
```

**修改提示词（多行长提示词，建议直接编辑配置文件）：**

```bash
# 查看配置文件路径
dsk config path

# Windows 用记事本打开（把路径替换成上面命令输出的路径）
notepad "%APPDATA%\deepseek-cli-nodejs\Config\config.json"

# Linux / Termux 用 nano 打开
nano ~/.config/deepseek-cli-nodejs/Config/config.json
```

配置文件是普通 JSON，找到 `"systemPrompt"` 那行直接改，保存后立即生效，不需要重启。

**临时覆盖提示词（不影响全局配置）：**

```bash
dsk -s "你是一个诗人"          # 本次会话用这个提示词
dsk ask -s "用英文回答" "你好"  # 单次请求用这个提示词
```

**本项目默认的全局提示词** 要求模型严谨务实、不捏造信息、明确区分事实与推断、用中文回答。如果想恢复这个默认提示词，运行：

```bash
dsk config reset
```

---

## 历史对话

```bash
dsk history        # 查看最近 20 条
dsk history -n 5   # 只看最近 5 条
```

---

## 可用模型

| 模型 ID | 说明 | 支持推理思考 |
|---|---|---|
| `deepseek-v4-pro` | DeepSeek V4 Pro，最强，1M 上下文 | ✅ |
| `deepseek-v4-flash` | DeepSeek V4 Flash，更快更省 token | ✅ |
| `deepseek-chat` | DeepSeek-V3（将于 2026/07/24 下线） | — |
| `deepseek-reasoner` | DeepSeek-R1（将于 2026/07/24 下线） | ✅ |

模型 ID 以 [DeepSeek 官方 API 文档](https://platform.deepseek.com) 为准。

---

## 开发模式（不编译直接跑）

```bash
npm run dev -- ask "测试一下"
npm run dev          # 交互式
```

---

## 卸载

```bash
npm unlink -g deepseek-cli
```
