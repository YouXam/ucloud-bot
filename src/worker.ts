
import apiRouter, { sendMessage, sendTask, sendUndoneItem } from './router';
import { UndoneList, User, Detail } from './types';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        return apiRouter.handle(request, env, ctx);
    },

    async scheduled(event: Event, env: Env, ctx: ExecutionContext): Promise<void> {
        const users: D1Result<User> = await env.DB.prepare(`SELECT * FROM users WHERE push`).all();
        if (!users.success || !users.results || users.results.length == 0)
            return;
        const cache: { [key: string]: Detail } = {}
        const now = new Date().getTime();
        for (const user of users.results) {
            try {
                const r = await fetch(env.API_SCHEDULE + "/undoneList", {
                    headers: {
                        "Authorization": `Basic ${btoa(`${user.username}:${user.password}`)}`
                    }
                })
                if (r.status === 401) {
                    await env.DB.prepare(`UPDATE users SET push = 0 WHERE id = ?`)
                        .bind(user.id)
                        .run()
                    await sendMessage(env, user.id, "登录失效，可能是密码已更改，推送已关闭。请使用 /login 重新登录。");
                    continue;
                }
                if (r.status != 200) {
                    console.error(user.username, r.statusText, await r.text());
                    continue;
                }
                const res: UndoneList = await r.json()
                if (res.undoneNum == 0)
                    continue;
                const undoneList: { [key: string]: 'new' | 'day' | 'hour' } = {}
                // 'new': 已经推送过新作业的, 'day': 已经推送过“剩余时间不足一天”的，'hour': 已经推送过“剩余时间不足一小时”的
                let lastUndoneList: { [key: string]: 'new' | 'day' | 'hour' } = JSON.parse(user.undoneList)

                // migrate
                for (const key in lastUndoneList) {
                    // @ts-expect-error
                    if (lastUndoneList[key] === true) {
                        lastUndoneList[key] = 'new';
                    }
                }

                for (const item of res.undoneList) {
                    try {
                        let alertType: 'new' | 'day' | 'hour'
                        const endTime = new Date(item.endTime + " GMT+0800").getTime();
                        if (endTime - now < 60 * 60 * 1000) {
                            alertType = 'hour';
                        } else if (endTime - now < 24 * 60 * 60 * 1000) {
                            alertType = 'day';
                        } else {
                            alertType = 'new'
                        }
                        if (lastUndoneList[item.activityId] === alertType) {
                            undoneList[item.activityId] = alertType;
                            continue;
                        }
                        if (cache[item.activityId]) {
                            console.log("send", user.id, cache[item.activityId], alertType);
                            await sendTask(env, user.id, cache[item.activityId], alertType);
                            undoneList[item.activityId] = alertType;
                            continue;
                        }
                        if (item.type !== 3) {
                            console.log("send", user.id, item, alertType);
                            await sendUndoneItem(env, user.id, item, alertType);
                            undoneList[item.activityId] = alertType;
                            continue;
                        }
                        const res = await fetch(env.API_SCHEDULE + "/homework?id=" + item.activityId, {
                            headers: {
                                "Authorization": `Basic ${btoa(`${user.username}:${user.password}`)}`
                            }
                        })
                        if (res.status != 200) {
                            console.error(user.username, res.status, res.statusText, await res.text());
                        } else {
                            const data: Detail = await res.json();
                            cache[item.activityId] = data;
                            console.log("send", user.id, data, alertType);
                            await sendTask(env, user.id, data, alertType);
                            undoneList[item.activityId] = alertType;
                        }
                    } catch (e) {
                        console.error(user.username, e);
                    }
                }
                await env.DB.prepare(`INSERT INTO users (id, username, password, push, undoneList) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, password = excluded.password, push = excluded.push, undoneList = excluded.undoneList`)
                    .bind(user.id, user.username, user.password, user.push, JSON.stringify(undoneList))
                    .run()
            } catch (e) {
                console.error(user.username, e);
            }
        }
    }
};
