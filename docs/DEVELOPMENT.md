# 开发说明

## 技术栈

- Electron
- React
- Vite
- TypeScript
- Tailwind CSS

## 目录结构

```text
src/        React 前端代码
electron/   Electron 主进程、preload 和本地书库工具
scripts/    开发、测试和打包辅助脚本
assets/     应用图标和资源
docs/       项目文档
```

## 安装依赖

```powershell
npm install
```

## 启动开发环境

```powershell
npm run dev:electron
```

该命令会启动 Vite 开发服务器并打开 Electron 窗口。

## 构建前端

```powershell
npm run build
```

## 打包 Windows 安装包

```powershell
npm run dist
```

本地构建产物位于 `dist/` 和 `release/`，不要提交到 GitHub。

## 本地数据

Electron 本地书库保存在用户数据目录中，不在项目源码目录内。请不要把用户 TXT、书库 JSON、同步 token 或 `.env` 提交到仓库。

## 本地 API 边界

`electron/preload.cjs` 暴露 `window.readerAPI`，前端通过 IPC 调用本地书库能力。云端同步通过浏览器 `fetch` 调用服务器 `/api/...`。

## 测试脚本

```powershell
npm run test:encoding
npm run test:chapters
npm run test:books
```
