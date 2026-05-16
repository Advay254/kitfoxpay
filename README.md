# KitfoxPay

> 解决 NewAPI 支付通道受限问题的开源适配网关，无需修改 NewAPI 代码即可接入 Jeepay，升级更平滑、支付更可控。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)](https://nodejs.org/)

## ✨ 特性

- 🚀 **零代码改动**：NewAPI 无需修改任何代码，只需更改支付接口地址
- 🔄 **平滑升级**：支付逻辑与业务逻辑完全解耦，NewAPI 升级不再受支付代码影响
- 🔒 **开源可控**：底层使用开源 Jeepay 支付平台，支持自建部署，数据完全可控
- 🔌 **即插即用**：兼容易支付接口标准，无缝替换第三方易支付平台
- 🎯 **可扩展架构**：采用适配器模式，后续可以轻松接入更多支付通道
- 🌍 **Paystack 支持**：内置 Paystack 网关适配器，支持非洲主流支付渠道（NGN/GHS/ZAR/KES 等货币）
- 🎨 **可视化配置**：提供 Web 管理界面，无需手动编辑配置文件

## 📋 目录

- [快速开始](#快速开始)
- [功能特性](#功能特性)
- [架构设计](#架构设计)
- [配置说明](#配置说明)
- [使用场景](#使用场景)
- [开发指南](#开发指南)
- [贡献指南](#贡献指南)
- [许可证](#许可证)

## 🚀 快速开始

### 环境要求

- Node.js >= 14.0.0
- npm 或 yarn
- 已部署的 Jeepay 支付平台（或使用 Jeepay 官方测试环境）

### 安装步骤

#### 1. 克隆仓库

```bash
# GitHub
git clone https://github.com/kitfoxai/kitfoxpay.git
# 或 Gitee（国内用户推荐）
git clone https://gitee.com/kitfoxai/kitfoxpay.git

cd kitfoxpay
```

#### 2. 安装依赖

```bash
npm install
```

#### 3. 配置参数

**首先，在 Jeepay 后台获取配置信息：**
- 商户号（mchNo）
- 应用ID（appId）
- 商户私钥（privateKey）

具体获取方法请参考下方"界面展示"部分的截图说明。

**然后，复制配置示例文件：**

```bash
cp config.example.js config.js
```

编辑 `config.js`，填入你的 Jeepay 配置信息：

```javascript
module.exports = {
  jeepay: {
    baseUrl: 'https://pay.jeepay.vip',
    mchNo: '你的商户号',
    appId: '你的应用ID',
    privateKey: '你的商户私钥'
  },
  epay: {
    pid: '你的易支付商户ID',
    key: '你的易支付密钥'
  },
  server: {
    host: '0.0.0.0',
    port: 9219,
    siteDomain: 'http://localhost:9219'
  },
  admin: {
    password: '请修改为安全密码'
  }
};
```

#### 4. 启动服务

```bash
npm start
```

服务启动后，访问 `http://localhost:9219` 进入管理界面。界面展示请参考下方"界面展示"部分。

### 在 NewAPI 中配置

在 NewAPI 配置文件中，将支付接口地址改为 KitfoxPay 地址：

```yaml
payment:
  epay_url: http://your-kitfoxpay-domain:9219
  pid: 你的易支付商户ID
  key: 你的易支付密钥
```

**注意**：`pid` 和 `key` 需要与 KitfoxPay 配置保持一致。

完整的配置界面和支付流程演示请参考下方"界面展示"部分。

## 🎯 功能特性

### 核心功能

- ✅ **支付订单创建**：支持多种支付方式，自动处理参数转换和签名验证
- ✅ **支付结果通知**：自动接收 Jeepay 通知并转发给 NewAPI
- ✅ **订单查询**：支持单个/批量订单查询，实时同步订单状态
- ✅ **退款功能**：支持全额/部分退款，自动处理退款通知
- ✅ **商户信息查询**：查询商户信息和结算记录
- ✅ **可视化配置**：Web 管理界面，支持配置热更新

### 接口支持

KitfoxPay 完全兼容易支付接口标准：

- `mapi.php` - 后端 API 支付接口
- `submit.php` - 前台支付提交接口
- `api.php` - 统一 API 接口（订单查询、退款、商户查询等）

支持 GET 和 POST 两种请求方式，完整的签名验证机制。

## 📸 界面展示

### KitfoxPay 管理界面

启动服务后，访问 `http://localhost:9219` 即可进入管理界面。界面采用 Tab 设计，将不同配置分类管理：

![KitfoxPay 管理界面 - 网站设置](docs/images/kitfoxpay-admin-01.png)

![KitfoxPay 管理界面 - Jeepay 配置](docs/images/kitfoxpay-admin-02.png)

![KitfoxPay 管理界面 - 易支付配置](docs/images/kitfoxpay-admin-03.png)

### KitfoxPay 调试界面

提供完整的接口测试功能，支持 Jeepay 和易支付接口的调试：

![KitfoxPay 调试界面 - Jeepay 测试](docs/images/kitfoxpay-debug-01.png)

![KitfoxPay 调试界面 - 易支付测试](docs/images/kitfoxpay-debug-02.png)

### Jeepay 后台配置获取

在配置 KitfoxPay 之前，需要先在 Jeepay 后台获取必要的配置信息：

![Jeepay 商户信息 - 商户信息](docs/images/jeepay-merchant-01.png)

![Jeepay 商户信息 - 应用信息](docs/images/jeepay-merchant-02.png)

![Jeepay API 密钥](docs/images/jeepay-api-key.png)

### NewAPI 配置与支付流程

在 NewAPI 系统中配置支付接口：

![NewAPI 支付配置界面](docs/images/newapi-config.png)

支付流程演示：

![NewAPI 支付界面 - 支付选择](docs/images/newapi-payment-01.png)

![NewAPI 支付界面 - 支付确认](docs/images/newapi-payment-02.png)

![NewAPI 支付成功界面](docs/images/newapi-payment-success.png)

## 🏗️ 架构设计

```
┌─────────────────┐
│   NewAPI        │
│  (业务系统)      │
└────────┬────────┘
         │ 易支付接口调用
         ▼
┌──────────────────────────────────┐
│   KitfoxPay  (适配器网关)         │
│                                  │
│  ┌────────────────────────────┐  │
│  │       EpayAdapter          │  │  ← 易支付接口适配层
│  └──────────┬─────────────────┘  │
│             │ 按配置路由           │
│      ┌──────┴──────┐             │
│      ▼             ▼             │
│  ┌──────────┐ ┌──────────────┐  │
│  │ Jeepay   │ │  Paystack    │  │  ← 双网关支持
│  │ Client   │ │  Client      │  │
│  └────┬─────┘ └──────┬───────┘  │
└───────┼───────────────┼──────────┘
        │ Jeepay API    │ Paystack API
        ▼               ▼
┌──────────────┐ ┌──────────────────┐
│   Jeepay     │ │   Paystack       │
│  (支付平台)   │ │  (非洲支付网关)   │
└──────────────┘ └──────────────────┘
```

### 核心模块

- **`index.js`** - 主入口，Express 服务器和路由注册
- **`epay.js`** - 易支付接口适配器，参数转换和签名处理
- **`jeepay/jeepay.js`** - Jeepay 客户端，API 封装
- **`admin.js`** - 管理后台 API
- **`public/index.html`** - Web 管理界面
- **`config.js`** - 配置文件

## ⚙️ 配置说明

### Jeepay 配置

```javascript
jeepay: {
  baseUrl: 'https://pay.jeepay.vip',  // Jeepay API 地址
  mchNo: '商户号',                     // 从 Jeepay 后台获取
  appId: '应用ID',                     // 从 Jeepay 后台获取
  privateKey: '商户私钥'               // 从 Jeepay 后台获取
}
```

### 易支付接口配置

```javascript
epay: {
  pid: '易支付商户ID',                 // 自定义，需与 NewAPI 配置一致
  key: '易支付密钥'                    // 自定义，需与 NewAPI 配置一致
}
```

### 服务器配置

```javascript
server: {
  host: '0.0.0.0',                     // 绑定 IP
  port: 9219,                          // 监听端口
  siteDomain: 'http://your-domain.com' // 对外访问域名（用于回调）
}
```

### Paystack 配置（可选）

> 当 `enabled: true` 时，所有支付请求通过 Paystack 处理，Jeepay 配置仍需填写但不用于支付。

```javascript
paystack: {
  enabled:       false,                       // 是否启用 Paystack（默认关闭，不影响 Jeepay 用户）
  secretKey:     'sk_test_xxxxxxxxxxxx',      // Paystack 密钥（sk_test_... 或 sk_live_...）
  baseUrl:       'https://api.paystack.co',   // API 地址（通常无需修改）
  currency:      'NGN',                       // 货币代码：NGN / GHS / ZAR / KES / USD 等
  channels:      ['card', 'bank', 'ussd', 'mobile_money', 'bank_transfer'],
  webhookPath:   '/webhook/paystack',         // Webhook 接收路径
  customerEmail: 'customer@example.com'       // 默认客户邮箱（请求未提供时使用）
}
```

**Paystack Webhook 配置步骤：**

1. 登录 [Paystack Dashboard](https://dashboard.paystack.com) → Settings → API Keys & Webhooks
2. 在 Webhook URL 中填入：`https://你的域名/webhook/paystack`
3. 保存后，Paystack 会在每次支付事件后向该地址发送通知

**e-pay 参数与 Paystack 参数映射：**

| 易支付参数 | Paystack 参数 | 说明 |
|---|---|---|
| `out_trade_no` | `reference` | 唯一订单号（仅限字母、数字、`-`、`.`、`=`）|
| `money` | `amount` | 自动转换为最小货币单位（×100）|
| `return_url` | `callback_url` | 支付后跳转地址 |
| `notify_url` | `metadata.notify_url` | 存入 metadata，Webhook 时取出转发 |
| `name` | `metadata.custom_fields` | 商品名称 |

## 💡 使用场景

- **NewAPI 用户**：希望使用 Jeepay 替代易支付，实现平滑升级
- **易支付接口系统**：任何使用易支付接口的系统都可以通过 KitfoxPay 接入 Jeepay
- **多支付通道聚合**：未来可扩展支持多个支付通道，统一管理

## 🛠️ 开发指南

### 项目结构

```
KitfoxPay/
├── index.js              # 主入口文件
├── epay.js               # 易支付适配器（支持 Jeepay / Paystack 双路由）
├── jeepay/               # Jeepay 客户端模块
│   ├── index.js
│   └── jeepay.js
├── paystack/             # Paystack 客户端模块（新增）
│   └── paystack.js       # Paystack API 客户端 + Webhook 验证
├── admin.js              # 管理后台 API
├── config.js             # 配置文件（含 paystack 配置块）
├── config.example.js     # 配置示例
├── SECURITY.md           # 安全说明（Webhook 验证机制）
├── public/               # 静态文件
│   └── index.html        # Web 管理界面（含 Paystack 配置 Tab）
└── package.json          # 项目依赖
```

### 扩展新的支付通道

1. 创建新的支付客户端模块（参考 `jeepay/jeepay.js`）
2. 在 `epay.js` 中扩展适配逻辑
3. 在 `index.js` 中注册新通道的路由

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm start

# 访问管理界面
open http://localhost:9219
```

## 🤝 贡献指南

我们欢迎所有形式的贡献！

### 如何贡献

1. **Fork** 本仓库
2. 创建你的特性分支（`git checkout -b feature/AmazingFeature`）
3. 提交你的更改（`git commit -m 'Add some AmazingFeature'`）
4. 推送到分支（`git push origin feature/AmazingFeature`）
5. 开启一个 **Pull Request**

### 提交 Issue

- Bug 报告：请详细描述问题现象、复现步骤、环境信息
- 功能建议：请说明需求场景和预期效果

### 代码规范

- 遵循现有代码风格
- 添加必要的注释
- 确保代码通过测试

## 📅 Roadmap

- [x] 支持更多支付通道（Paystack 已集成 / Paystack integrated）
- [ ] 增强管理后台功能（订单查询、统计报表）
- [ ] 支持多商户配置
- [ ] 添加监控和日志系统
- [ ] 提供 Docker 镜像
- [ ] 编写更详细的文档和教程

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE)。

## 🙏 致谢

- 感谢 [Jeepay](https://github.com/jeequan/jeepay) 提供优秀的开源支付平台
- 感谢 [NewAPI](https://github.com/newapi) 提供的大模型网关和资产管理系统
- 感谢所有贡献者和使用者的支持

## 📞 联系方式

- **GitHub**：[https://github.com/kitfoxai/kitfoxpay](https://github.com/kitfoxai/kitfoxpay)
- **Gitee**：[https://gitee.com/kitfoxai/kitfoxpay](https://gitee.com/kitfoxai/kitfoxpay)
- **Issue**：[GitHub Issues](https://github.com/kitfoxai/kitfoxpay/issues) | [Gitee Issues](https://gitee.com/kitfoxai/kitfoxpay/issues)
- **讨论**：[GitHub Discussions](https://github.com/kitfoxai/kitfoxpay/discussions)

---

如果这个项目对你有帮助，欢迎给个 ⭐ Star！
