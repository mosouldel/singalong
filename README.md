# 🎤 我会唱 · 私人 KTV 曲库

收录自己会唱的歌：搜索 → 一键收录 → 看歌词 → 每句加备注 → 统计。曲库和备注全部保存在手机本地，不上传任何服务器。

## 功能
- 顶部搜索 + 主体列表 + 底部「我的曲库 / 统计」两栏。
- 搜索后一键「收录」，默认标签为「会唱」，点击标签可切到「想学」。
- 列表筛选：全部 / 按歌手 / 按标签；左滑或长按可移除。
- 详情页看歌词，点任意一句弹出备注框；支持编辑歌曲信息、手动粘贴歌词。
- 统计：总收录、会唱/想学数量、按歌手排行、最近收录。
- 数据导出/导入（JSON 备份）。

## 歌词来源（可插拔，设置里切换）
- **自动（推荐）**：先试 LRCLIB，失败再试魔镜歌词。
- **LRCLIB**：开放 JSON 接口，稳定、含逐行时间戳歌词；华语/欧美覆盖较好。
- **魔镜歌词**：`mojigeci.com`，中文/港台/日韩更全，但无官方 API，靠服务端/原生抓取解析。
- 都失败时可**手动添加 / 手动粘贴歌词**，曲库本身永远离线可用。

## 为什么需要代理或原生 App
浏览器直接跨域抓取 `mojigeci.com` 会被 CORS 拦截，所以有两条路：
1. **浏览器预览**：用 `server.js` 做本地静态服务器 + 代理（同源，绕开 CORS）。
2. **手机 App**：打包成 Android App 后，App 内用**原生 HTTP** 直连歌词站，不跨域、无需服务器，出门 4G/5G 随处可用。

## 运行方式

### A. 浏览器预览（开发调试）
需要已安装 Node.js（18+）。

```bash
cd singalong
node server.js
```

浏览器打开 `http://localhost:8787`。手机在同一 Wi-Fi 下，可访问 `http://<电脑局域网IP>:8787`。

### B. 打包成 Android APK（正式使用，推荐）
两种方式任选：

**方式 1：GitHub Actions 自动打包（无需本地安卓环境）**
1. 把 `singalong` 整个目录推到 GitHub 仓库（`www/`、`package.json`、`.github/workflows/build-apk.yml` 都要包含）。
2. 在仓库 Actions 里运行 `Build Android APK`，或直接 push 到 `main`。
3. 构建完成后下载 `singalong-debug-apk`，传到手机安装（需允许“未知来源”）。

**方式 2：本地 Android Studio 打包**
```bash
cd singalong
npm install
npx cap add android
npx cap sync android
npx cap open android   # 用 Android Studio 打开后 Build APK
```

## 文件结构
```
singalong/
├─ www/                      # Web 应用（也是 App 的界面）
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js                 # 全部逻辑：曲库 + 歌词源 + UI
│  ├─ manifest.webmanifest
│  └─ icon.svg
├─ server.js                 # 本地预览服务器 + /proxy 代理
├─ capacitor.config.json     # Capacitor 打包配置
├─ package.json
├─ .github/workflows/build-apk.yml
└─ README.md
```

## 已知说明 / 注意
- 数据用 `localStorage` 存本机；换手机或卸载前请先在「设置 → 导出」备份。
- 魔镜歌词是网页抓取，站方改版可能导致解析失效；解析逻辑集中在 `app.js` 的 `parseMojigeciSearch` / `parseMojigeciLyrics`，便于按需调整。
- 若 LRCLIB 在国内网络不可达，请把设置里的来源切成「魔镜」，或手动收录。
- 本应用仅用于个人整理自己会唱的歌，请勿用于批量抓取或再分发歌词内容。

## iOS
当前仅配置了 Android。iOS 需要 macOS + Apple 开发者账号，如需要可再补充。