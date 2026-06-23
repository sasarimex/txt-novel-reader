# 摸鱼阅读 TXT 小说阅读器

一个面向 Windows 桌面的 TXT 小说阅读器。客户端使用 Electron + React + Vite + TypeScript 构建，支持本地书库管理、阅读进度保存、书签、分类和可选的云端同步。

## 主要功能

- 导入单本或批量导入 TXT 小说
- 自动解析章节目录并支持目录跳转
- 上一章、下一章、滚动阅读和点击翻页
- 书签、阅读位置和阅读进度保存
- 字号、行高、主题和阅读模式设置
- 书架排序、分类管理和拖拽归类
- 书名、作者、备注编辑
- 可选云端同步：同步书架元数据、阅读进度、书签、阅读设置和分类

## 系统要求

- Windows 10 或 Windows 11
- Node.js 20 或更高版本
- npm

## 普通用户安装

1. 打开项目的 GitHub Releases 页面。
2. 下载最新的 `Setup.exe` 安装包。
3. 双击安装并启动软件。
4. 在软件中导入 TXT 文件开始阅读。

安装包不建议直接提交到源码仓库。请把 Windows 安装包发布到 GitHub Releases。

## 开发启动

```powershell
git clone <CLIENT_REPOSITORY_URL>
cd txt-novel-reader
npm install
npm run dev:electron
```

## 构建

```powershell
npm run build
npm run dist
```

构建产物会生成在本地 `dist/` 和 `release/` 目录中，这些目录不应提交到 GitHub。

## 云端同步

云端同步是可选功能，需要自行部署 `txt-novel-reader-server`。

客户端只需要填写同步服务器根地址，例如：

```text
https://read.example.com
```

不要填写 `/api`，也不要在 Cloudflare Tunnel 模式下填写 `:3300`。客户端会自动拼接 `/api/...`。

服务器不会保存 TXT 小说正文，只同步账号、书架元数据、阅读进度、书签、阅读设置和分类。

## 隐私说明

- TXT 小说正文默认只保存在本地设备。
- 不要把个人 TXT 文件、`.env`、token 或账号密码提交到 GitHub。
- 当前项目未指定开源许可证；如需公开授权，请在发布前添加 `LICENSE`。

## 更多文档

- [用户指南](docs/USER_GUIDE.md)
- [开发说明](docs/DEVELOPMENT.md)
- [发布说明](docs/RELEASE_GUIDE.md)
- [GitHub 上传检查清单](GITHUB_UPLOAD_CHECKLIST.md)
