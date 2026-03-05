# 60666A VEX Engineering Notebook 智能分发与展示方案

本仓库提供了一套完整的解决方案，用于解决大型 PDF（如上百MB的 VEX 工程笔记）在网络共享和网页预览时的各种痛点问题。方案涵盖了 PDF 压缩优化、全球 CDN 部署方案、多端设备兼容性处理，以及针对中国大陆的网络访问优化。

## 背景与痛点

1. **Google Drive 预览限制**：当 PDF 文件大于 100MB 时，Google Drive 无法提供在线预览，访客必须下载整个文件才能查看，严重影响了评委和普通访客的阅读体验。
2. **大尺寸文件加载慢**：数百页的高清工程笔记动辄几百MB，如果直接放在普通服务器上，或者哪怕是放到对象存储，不经过处理依然会导致加载极慢、浏览器崩溃。
3. **国内外网络环境差异**：使用普通的海外 CDN（如 Cloudflare 本身）在全球范围内速度很快，但在中国大陆往往存在访问缓慢或被墙的风险，影响国内团队内部交流。
4. **不同设备/浏览器的 PDF 渲染差异极大**：
   - 移动端（iPad、iPhone、Android）原生的 PDF 渲染器对大文件的支持和体验反而好于网页内嵌版。
   - 桌面端 Chrome/Edge 的 Blink 内核与 `pdf.js` 配合时，可能在某些渲染层面上出现瑕疵（如图片之间有细微横线）。
   - 不同的浏览器对 `iframe` 嵌入或者 `PDFObject` 支持的行为不一致。

## 解决方案概述

本方案提供了从**文件预处理** $\rightarrow$ **全球静态分发** $\rightarrow$ **智能端到端适配** $\rightarrow$ **按区域网络回源** 的完整端到端解决策略。

### 1. PDF 文件瘦身与线性化处理 (Fast Web View)

工程笔记的源文件（通常由平板手写软件或 InDesign 产出）内部往往嵌有大量的矢量路径和高达 300+ DPI 的印刷级高清大图。**但对于在电脑或手机屏幕上浏览而言，我们完全不需要如此冗余的“印刷级”精度——通常 150 DPI 的分辨率在显示器上已经极其清晰。**

因此，我们使用 Ghostscript 和 QPDF 工具链对导出的源文件进行二次加工，在肉眼几乎分辨不出画质损失的前提下，实现体积的极大幅度瘦身**（例如，通过该脚本处理可以将 110MB 左右的文件直接压缩到 35MB）**，并将其“线性化”（支持浏览器按页边下边渲染，而不必等几百兆完全下载完毕）。

```bash
# 第一步：高兼容性压缩（保留透明度、修正色彩映射、减小体积）
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dNOPAUSE -dQUIET -dBATCH \
   -dDoThumbnails=false -dCreateJobTicket=false -dPreserveTransparency=true \
   -dRenderIntent=/RelativeColorimetric -dInterpolateControl=true \
   -sOutputFile=final_fixed.pdf origin_notebook.pdf

# 第二步：线性化处理（开启 Fast Web View 属性）
qpdf --linearize final_fixed.pdf final_optimized.pdf
```

### 2. 使用 Cloudflare Pages 与 R2 构建低成本全球分发网络

网页的前端代码与几百兆的 PDF 实体文件分离：
- **存储层 (Cloudflare R2)**：将 `final_optimized.pdf` 放入 R2 对象存储，获得免流量费的高速分发。
- **前端层 (Cloudflare Pages)**：将本仓库所包含的前端页面部署在 Cloudflare Pages，响应速度达到边缘节点级别。

**部署方法示例 (Wrangler)：**
```bash
CLOUDFLARE_API_TOKEN=your_token wrangler pages deploy vex-viewer-site-cloudflare-pages \
  --project-name your_project_name \
  --branch main
```

### 3. 多端兼容的 Smart Viewer 动态路由分发

我们并没有强推单一的 Viewer 框架，而是通过分析 `User-Agent` 与平台特征，动态将访客指派给最适合其设备的原生或 JS 查看器解决方案（详见 `index.html` 中的智能路由）：

| 平台 / 操作系统 | 浏览器 | 采用的 Viewer 策略 | 原因及预期表现 |
|---|---|---|---|
| **iPad** | 任意 (Safari/Chrome) | **裸 PDF (原生)** | iOS 系统级快速渲染，滚动顺滑，极速加载 |
| **iPhone** | Chrome (CriOS) | **pdf.js (无侧边栏)** | 避免裸 PDF 误触发下载，保证在线阅览 |
| **iPhone** | Safari | **裸 PDF (原生)** | 系统内嵌渲染稳且快 |
| **Android** | 任意 | **裸 PDF + `#view=FitH`** | 触发自带 PDF 查看逻辑 |
| **Mac / Windows** | **Chrome / Edge** | **PDFObject** | 调用浏览器高级原生内核视图，完美回避 pdf.js 的渲染横线 bug，附带缩略图 |
| **Mac** | Safari 及其他 | **pdf.js (带缩略图)** | 高度定制，完美兼容，带漂亮侧边栏 |

### 4. 国内访问速度优化：独立 Worker + 客户端并发测速 (Double Smart Routing)

为了解决 Cloudflare 在中国大陆偶发访问缓慢甚至被阻断的痛点，我们设计了**服务端 + 客户端双重智能路由**机制。我们废弃了局限于 Pages 内部有限能力的 `_worker.js`，改为在域名的路由级别使用**独立的 Cloudflare Worker**，配合轻量级的前端探针完成极致优化。

**(1) 服务端路由层：基于 IP 归属地判断的独立 Worker**
我们将主域名（如 `your-custom-domain.com`）的流量路由给独立的 Cloudflare Worker，利用 `request.cf.country` 原生属性作为第一道判断：
```javascript
// 独立 Worker 的核心分流逻辑
async function handleRequest(request) {
    const url = new URL(request.url)
    const country = request.cf ? request.cf.country : null

    // IP 为中国且访问首页时，302 重定向至国内高速优化节点（如国内VPS）
    if (country === 'CN' && (url.pathname === '/' || url.pathname === '')) {
        return Response.redirect('https://your-cn-optimized-domain.com/', 302)
    }

    // 否则重写 URL 显式指定 fetch Pages 的主域名，避免在自定义域名上产生内部路由重定向循环
    const pagesUrl = new URL(url.pathname + url.search, 'https://your-pages-app.pages.dev')
    const pagesRequest = new Request(pagesUrl.toString(), request)
    return fetch(pagesRequest)
}
```

**(2) 客户端验证层：基于 `ping.txt` 的真实客户端竞速兜底**
由于访客可能使用各种代理，或者Cloudflare IP 数据库存在误差，我们在入口页 `index.html` 加入了最后一道真实环境网络探针验证：
在判断 Viewer 和设备环境之前，页面首先会利用 `Promise.allSettled` 并发请求 Cloudflare 边缘节点和亚太优化节点上的一个微小文件 `ping.txt`：
```javascript
var t0 = performance.now();
var cnTime = Infinity, cfTime = Infinity;

await Promise.allSettled([
    fetch(CN_HOST + '/ping.txt?_=' + t0, { cache: 'no-store', mode: 'no-cors' })
        .then(function () { cnTime = performance.now() - t0; }),
    fetch('/ping.txt?_=' + t0, { cache: 'no-store' })
        .then(function () { cfTime = performance.now() - t0; })
]);

// 只要优化线路速度胜出，立刻执行 replace 跳转，交由优化节点决定最终 Viewer
if (cnTime < cfTime) {
    window.location.replace(CN_HOST + '/');
    return; // 终止后续在当前节点的 Viewer 渲染
}
```
通过这两套机制的接力，确保了**海外用户秒开原生边缘网络内容，而大陆用户一定能自动降落到连接最快速的自备优化节点上**。


---

## 附录：各端平台与浏览器对不同 Viewer 的兼容性盲测记录

在制定上述**智能设备分流策略**之前，我们进行了地毯式测试，记录了 200MB+ 大体积工程笔记在不同设备和加载方式下的行为表现。下表为开发过程中积累的核心原始测试数据：

| 测试环境           | viewer.js (Iframe)               | pdfobject (浏览器原生)         | pdf.js (Mozilla 开源方案)        | 直接裸 PDF 路径         | 裸路径加上 #view=FitH |
| ------------------ | -------------------------------- | ------------------------------ | -------------------------------- | ----------------------- | ------------------------ |
| **Mac Chrome**     | PDFViewer 带缩略图（双页）        | PDFObject 带缩略图，默认展开   | 渲染带横线 bug                   | 表现同 PDFObject        | 表现同 PDFObject         |
| **Mac Safari**     | 丐版 viewer 界面                 | 丐版 viewer 界面               | 完美呈现，无细横线 bug           | 丐版 viewer             | 丐版 viewer              |
| **iPad Safari**    | 一直 Load (Canvas OOM 内存爆炸)   | 一直 Load (Canvas OOM 内存爆炸) | Load 失败 (显示 0 of 212)        | 成功且解析极快          | 成功且解析极快           |
| **iPad Chrome**    | 一直 Load                        | 一直 Load                      | Load 失败 (显示 0 of 212)        | 成功且解析极快          | 成功且解析极快           |
| **iPhone Safari**  | 一直 Load                        | 一直 Load                      | 成功                             | 成功且解析极快          | 成功且解析极快           |
| **iPhone Chrome**  | 一直 Load                        | 一直 Load                      | 成功                             | 弹出系统 Download 弹窗  | 弹出系统 Download 弹窗    |
| **Android Chrome** | 跳转至裸路径 #view=FitH (正常打开)| 提示不支持预览，点击后跳转裸链 | 可以打开                         | 直接触发下载无 Web 阅读 | 直接调起原生页面内阅读   |

*核心排雷总结：移动端绝对不能使用任何基于 JS+Canvas 解析的开源阅读器加载此等体积的 PDF（触发系统杀后台机制），必须依靠设备级内核原生的支持方式。*

---

## 🚀 新手指南：如何在 Cloudflare 上零成本免费部署你的笔记

对于没有服务器的新手，**完全利用 Cloudflare 的免费配额**（Pages 托管前端，R2 托管大文件 PDF，Worker 分流控制）是最优雅且不花一分钱的方式。

### 第一步：把大体积 PDF 塞入云端对象存储（R2）
由于 GitHub 和 Cloudflare Pages 都有文件大小限制(<=25MB)，大体积的 PDF 会导致部署失败。
1. 登录 Cloudflare 控制台，在左侧菜单选择 **R2 Object Storage**。
2. 点击 **Create bucket**（创建一个存储桶），比如起名叫 `my-vex-pdfs`。
3. 储桶建好后，在桶内点击 **Upload**，把你经过 `gs` 和 `qpdf` 压缩好的大体积 PDF 传上去。
4. **开启公共访问**：在桶的 **Settings -> Public Access** 中，点击 **Connect Custom Domain** 绑定一个你的子域名（例如 `r2.your-domain.com`），或者开启允许公共访问的 R2.dev 链接。
5. ⚠️ **极其重要：配置 CORS (跨域资源共享) 规则**。因为网页端 `pdf.js` 需要在前端发送 `fetch`/`XHR` 请求下载 PDF的二进制流，如果你的前端所在的域名 (如 `my-note.your-domain.com`) 和 R2 存储的域名 (`r2.your-domain.com`) 不同源，必定会触发浏览器的跨域拦截导致无限加载。
   - 在 R2 桶的 **Settings -> CORS Policy** 中点击 **Add CORS policy**。
   - 填入以下 JSON 配置以允许所有的读取跨域请求（或者将 `AllowedOrigins` 限制为你的特定前端域名）：
   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["Accept-Ranges", "Content-Range", "Content-Length", "ETag"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```
6. **记录下这个 PDF 的最终公开下载链接**（如 `https://r2.your-domain.com/my-note.pdf`）。

### 第二步：配置前端项目（Pages）
1. 将本项目代码下载（或 Fork）到你自己的电脑里。
2. 进入 `vex-viewer-site-cloudflare-pages` 文件夹。
3. 把 `config.sample.js` 重命名为 `config.js`。
4. 打开 `config.js`，按照你的实际情况修改里面两条链接：
   - `PDF_URL` 填你刚才在第一步拿到的 R2 链接。
   - `CN_HOST` 填你的国内跳转备用域名（如果你没有国内服务器备用，可以随便填，因为我们海外部分正常）。
5. 登录 Cloudflare 控制台，进入左侧 **Workers & Pages**，选择 **Pages -> Connect to Git**（连接你 Fork 的 GitHub 仓库），部署这个 `vex-viewer-site-cloudflare-pages` 目录。
6. 或者你也可以在本地终端安装 wrangler 直接上传：`npx wrangler pages deploy vex-viewer-site-cloudflare-pages`。
7. 部署好后，Cloudflare 会给你个原生的 Pages 域名，例如 `xxx.pages.dev`。**记下它**。

### 第三步：设置智能路由 Worker（可选但极力推荐）
如果我们希望将最终的高大上网址（比如 `my-note.your-domain.com`）绑定给这个笔记体系，并且让它拥有处理国内直连跳转的智能能力：
1. 在 Cloudflare 的 **Workers & Pages -> Create Worker** 中新建一个 Worker，名字随便起（比如 `router-worker`）。
2. 点击 **Edit code**，把本项目根目录里的 `worker-routing-sample.js` 代码全选复制、覆盖粘贴进去，点击右上角的 **Deploy** 保存。
3. 退出代码编辑页，进入该 Worker 的 **Settings -> Variables -> Environment Variables** 模块。
   - 增加两个变量：
     - `CN_OPTIMIZED_HOST` : `https://your-cn-server.com` (如果没有可填空或填你常用的镜像)
     - `PAGES_HOST` : `https://xxx.pages.dev` (填你第二步刚才拿到的原生 Pages 域名！)
4. 最后也是最神奇的一步！去 Cloudflare 的 **Websites** -> 点进你平时用的主域名管理界面 -> 左边菜单选 **Workers Routes** -> **Add route**。
   - 将路由（Route）写成 `my-note.your-domain.com/*`。
   - 将 Worker 选为你刚才创建的那个 `router-worker`。
5. 搞定！现在只要有人访问 `my-note.your-domain.com`，这股流量就会先被 Worker 接管，然后完美执行我们设计好的智能客户端识别和线路优选，一切都是全自动免费的！

## 目录结构介绍

- `vex-viewer-site-cloudflare-pages/`: 包含部署到 Cloudflare Pages 的所有前端静态资源素材。包含了不同引擎的 HTML Viewer 壳、`ping.txt` 用于前端测速，以及负责防内循环的 `404.html`。
  - `config.sample.js`: 环境配置文件样例，需要复制为 `config.js` 并填写真实 R2 路径与国内优化加速域名。
  - `test.html`: **各款引擎渲染效果测试汇总页面，方便不同设备调试进入各种 Viewer（如 Google Viewer 等）。**
- `worker-routing-sample.js`: 双重智路由中的服务端前置 Worker 脚本，采用了抽象了隐私数据的环境变量化 ES Module 结构。部署时需在 CF Panel 中填入变量。
- `vex-viewer-site-cnvps/`: 同步部署在亚太优化节点静态 Web 服务器（如 Nginx/Caddy）上的前端备用目录，内部结构与主站类似。
- `web/` / `build/`: 预编译包含的官方最新 `pdf.js` 与其配套的资源文件（兼容现代大文件分块懒读取）。做了一些小fix（修改validateFileURL以解决cors问题）。

> **注意事项**：当修改 Cloudflare Pages 的行为时，使用单页应用(SPA)模式默认会把任何未匹配的路径转发给 `index.html`。为了防止 404 伪装成 200 返回并在部分逻辑下引发无限循环，我们专门在仓库中提供了一个 `404.html` 文件来改变该默认行为。

## 💡 结语与致谢

本项目全部由 **Google Gemini 3.1** 和 **Claude Sonnet 4.6** (通过 Antigravity AI 代理平台) 协作完成。

部署本项目的最佳方案是将其交给各个主流 **AI 编程 CLI**。例如 **Claude Code**、**Codex CLI**、**Gemini CLI** 或类似工具。它们能通过分析当前工作区结构，自动完成环境变量绑定及多端资源同步。

如果本方案对参与类似于 VEX、FRC 等比赛提交大型工程类文档（或数字发行的杂志长卷）遇到了相同阻难的队伍有所启发，欢迎 Star / Fork。如有针对移动端更好的嵌入意见也欢迎提出 PR！
