
import apiRouter, { sendTask } from './router';
import { UndoneList, User, Detail  } from './types';

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return apiRouter.handle(request, env, ctx);
	},

	async scheduled(event: Event, env: Env, ctx: ExecutionContext): Promise<void> {
		const users: D1Result<User> = await env.DB.prepare(`SELECT * FROM users WHERE push`).all();
		if (!users.success || !users.results || users.results.length == 0)
			return;
		const cache: { [key: string] : Detail } = {}
		for (const user of users.results) {
			try {
				const r = await fetch(env.API_SCHEDULE + "/undoneList", {
					headers: {
						"Authorization": `Basic ${btoa(`${user.username}:${user.password}`)}`
					}
				})
				if (r.status != 200) {
					console.error(user.username, r.statusText, await r.text());
					continue;
				}
				const res: UndoneList = await r.json()
				if (res.undoneNum == 0)
					continue;
				const lastUndoneList: { [key: string]: boolean } = JSON.parse(user.undoneList);
				const newTask = res.undoneList.filter(item => !lastUndoneList[item.activityId]);
				if (newTask.length != 0) {
					for (const item of newTask) {
						try {
							if (cache[item.activityId]) {
								await sendTask(env, user.id, cache[item.activityId]);
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
								await sendTask(env, user.id, data);
							}
						} catch (e) {
							console.error(user.username, e);
						}
					}
					await env.DB.prepare(`INSERT INTO users (id, username, password, push, undoneList) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, password = excluded.password, push = excluded.push, undoneList = excluded.undoneList`)
						.bind(user.id, user.username, user.password, user.push, JSON.stringify(res.undoneList.reduce((obj, item) => {
							obj[item.activityId] = true;
							return obj;
						}, {} as { [key: string]: boolean })))
						.run()
				}
			} catch (e) {
				console.error(user.username, e);
			}
		}
	}
};
