# BUPT ucloud-bot
 
北邮教学云平台 Telegram 机器人。支持查看待办列表、待办详情、提交作业和自动推送新待办的功能。

## 使用方式

### 直接使用

1. 在 Telegram 中查找 [@bupt_ucloud_bot](https://t.me/bupt_ucloud_bot) 机器人；
2. 输入 `/login <学号> <统一认证密码>` 登录，待办推送默认开启；
3. 使用 `/list` 查看当前的待办列表；
4. 点击列表中的待办，查看详情；
5. 点击待办下方的“提交”按钮进入提交模式；
6. 直接发送文字、图片或文件添加提交内容；
7. 点击“提交”按钮提交到教学云平台。

### 自部署

1. Clone 本项目；
2. 创建 Cloudflare D1 数据库，将 ID 填写到 `wrangler.toml` 中，这里将名称设置为 `ucloud-bot`；
    ```bash
    npx wrangler d1 create ucloud-bot
    ```
3. 运行以下命令建表：
    ```bash
    npx wrangler d1 execute ucloud-bot --file database.sql
    ```
4. 创建 Telegram 机器人，获取 Token；
5. 使用以下命令设置 Token Secret：
    ```bash
    npx wrangler secret put ENV_BOT_TOKEN
    ```
6. 使用以下命令生成和设置 Webhook Secret：
    ```bash
    openssl rand -hex 32
    npx wrangler secret put ENV_BOT_SECRET
    ```
7. 部署到 Cloudflare Workers：
    ```bash
    npx wrangler deploy
    ```
8. 假设你部署到了 `https://ucloud-bot.example.workers.dev`，使用以下命令设置 Webhook：
    ```bash
    curl https://ucloud-bot.example.workers.dev/setWebhook
    ```
    如果结果类似于
    ```json
    {
        "webhook": "https://ucloud-bot.youxam.workers.dev/webhook",
        "succeed": true,
        "results": [
            { "ok": true, "result": true },
            { "ok": true, "result": true },
            { "ok": true, "result": true },
            {
                "ok": true,
                "result": true,
                "description": "Webhook is already set"
            }
        ]
    }
    ```
    则说明设置成功。
9. 在 Telegram 中访问你的机器人，使用方式见上面“直接使用”部分。