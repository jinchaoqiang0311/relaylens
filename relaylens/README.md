# RelayLens

AI 中转站账单级实测平台。

```
relaylens/
├── probe/      探针系统(P1 开发中)
│   ├── config/sites.yaml    在册站点与任务配置
│   ├── src/                 调度器/探针/存储/发布器
│   ├── store/raw/           原始数据归档(不可变,gitignore)
│   └── store/dist/          前端消费产物(gitignore)
└── web/        九页静态站(见 workspace/relaylens-home,待迁入)
```

## 快速开始(probe)

```bash
cd probe
npm install
npx tsx cli.ts once              # 全站跑一轮 health+price
npx tsx cli.ts once --task=health --site=placeholder-alpha
npx tsx cli.ts report            # 查看健康概览
npx tsx cli.ts schedule          # 常驻调度
```

- 数据落点:`store/raw/{site}/RL-RC-*.json`(原始)、`store/relaylens.sqlite`(指标)、`store/dist/*.json`(前端产物)
- 设计文档:探针系统方案 v0.1
- 方法论同步:web/method.html
