# 命名与版本规范

本规范自 Iteration 16 起生效。历史文档、数据库值和公开 API 字段不批量改名，以保证链接、账本和客户端兼容。

## 四类编号

| 对象 | 格式 | 示例 | 用途 |
|---|---|---|---|
| 发布版本 | SemVer `vMAJOR.MINOR.PATCH` | `v5.10.0` | 破坏性、功能、修复分别递增 major、minor、patch |
| 迭代 | `Iteration N` | `Iteration 16` | 一轮有明确目标和验收标准的工作周期 |
| 工作项 | `I{N}-{NN}` | `I16-03` | 迭代内稳定、按顺序递增的任务编号 |
| 优先级 | `P0` / `P1` / `P2` / `P3` | `I16-03 [P0]` | P0 阻断，P1 高，P2 常规，P3 可延后；不表示执行顺序 |

## 代码与接口

- Python：模块、函数、变量使用 `snake_case`，类使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`。
- TypeScript：变量和函数使用 `camelCase`，类型、接口和 Vue 组件使用 `PascalCase`，常量使用 `UPPER_SNAKE_CASE`。
- 文件：Vue 组件使用 `PascalCase.vue`；普通 TypeScript 使用 `kebab-case.ts`；Python 使用 `snake_case.py`。
- 环境变量和 Secret：使用 `UPPER_SNAKE_CASE`，真实值只存部署平台。
- HTTP 路径：保持小写名词与连字符；现有 `/api` 路径保持兼容。
- JSON：公开 API 继续使用 `snake_case`；不进行破坏式批量改名。
- Git：提交遵循 Conventional Commits，例如 `fix: prevent stale watchlist estimates`。

## 金融术语

- 温度：市场拥挤与短期回撤风险，越高越热，不表示预期收益越高。
- 估值分位：PE/PB 历史分位或明确标注的净值代理分位。
- 趋势状态：均线结构所反映的价格方向。
- 动量状态：RSI 等价格动量指标，不直接称为投资者情绪。
- 数据覆盖率：实际可用证据权重占设计权重的比例。
- 证据强度：由来源质量、覆盖率和验证状态共同决定，不等同于收益概率。
- 综合评分：同类比较的质量评分，不是未来收益预测。
- 决策建议：基于规则的辅助动作，不是买卖指令。

## 迁移原则

1. 新代码必须遵循本规范。
2. 旧名称只在自然修改相关模块时迁移，并保留兼容层或数据库迁移。
3. 历史 `Vx-Py` 编号视为不可变引用；新计划不得继续使用该格式。
4. 每次改名必须有搜索结果、测试或迁移验证，禁止只改展示文本而遗漏接口和持久化数据。
