# 发布说明

## 发布前检查

1. 更新 `package.json` 版本号。
2. 运行依赖安装和构建。
3. 测试基础阅读、导入、书签、分类和同步登录流程。
4. 确认没有提交 `node_modules/`、`dist/`、`release/`、`.env` 或个人 TXT 文件。

## 构建

```powershell
npm install
npm run build
npm run dist
```

## GitHub Releases

1. 打开 GitHub 仓库的 Releases 页面。
2. 点击 Draft a new release。
3. 创建 tag，例如 `v2.0.0`。
4. 上传生成的 Windows `Setup.exe`。
5. 填写 release notes。
6. 发布 release。

## 安装包存放建议

本目录中的 `release-assets/` 仅作为本地整理安装包的临时位置，默认被 `.gitignore` 忽略。请把安装包上传到 GitHub Releases，而不是提交到源码仓库。
