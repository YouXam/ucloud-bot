import { Router } from 'itty-router';
import { UndoneList, UndoneListItem, ResourceDetail, Detail, User } from './types';
import { Parser } from 'htmlparser2';

function apiUrl(env: Env, methodName: string, params?: { [key: string]: string }) {
	let query = ''
	if (params) {
		query = '?' + new URLSearchParams(params).toString()
	}
	return `https://api.telegram.org/bot${env.ENV_BOT_TOKEN}/${methodName}${query}`
}
async function api(env: Env, methodName: string, params?: { [key: string]: string }) {
	const url = apiUrl(env, methodName, params)
	const res = await fetch(url)
	return await res.json()
}

async function sendMessage(env: Env, chat_id: number, text: string, parse_mode = 'HTML') {
	try {
		return await api(env, 'sendMessage', { chat_id: chat_id.toString(), text, parse_mode })
	} catch (err) {
		console.error(err)
	}
}

async function editMessage(env: Env, chat_id: number, message_id: number, text: string, parse_mode = 'HTML') {
	return await api(env, 'editMessageText', { chat_id: chat_id.toString(), message_id: message_id.toString(), text, parse_mode })
}

async function onCommand(message: string, id: number, env: Env) {
	if (message.startsWith('/start')) {
		return await sendMessage(env, id, "使用 `/login username password` 登录", 'MarkdownV2')
	} else if (message.startsWith('/login')) {
		const [_, username, password] = message.split(' ')
		if (!username || !password) {
			return await sendMessage(env, id, "参数不足")
		}
		const res: { result: { message_id: number } } = await sendMessage(env, id, "登录中...") as any
		try {
			const r = await fetch(env.API_FETCH + "/undoneList", {
				headers: {
					"Authorization": `Basic ${btoa(`${username}:${password}`)}`
				}
			})
			if (r.status == 401) {
				return await editMessage(env, id, res.result.message_id, "登录失败: \n" + (await r.text()))
			}
			const data: UndoneList = await r.json()
			let flag = false;
			await env.DB.prepare(`INSERT INTO users (id, username, password, push, undoneList) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, password = excluded.password, push = excluded.push, undoneList = excluded.undoneList`)
				.bind(id, username, password, 1, JSON.stringify(data.undoneList.reduce((obj, item) => {
					if (flag) obj[item.activityId] = true;
					flag = true;
					return obj;
				  }, {} as { [key: string]: boolean })))
				.run()
			await editMessage(env, id, res.result.message_id, "登录成功, 推送已开启。使用 /list 查看未完成的作业。")
		} catch (e: any) {
			console.log(e)
			if (res) await editMessage(env, id, res.result.message_id, "登录失败: \n" + e.toString())
		}
	} else if (message.startsWith('/list')) {
		const res: { result: { message_id: number } } = await sendMessage(env, id, "请稍等...") as any
		try {
			const user: User = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()
			if (!user) {
				return await editMessage(env, id, res.result.message_id, "未登录。使用 /login username password 登录。")
			}
			const r = await fetch(env.API_FETCH + "/undoneList", {
				headers: {
					"Authorization": `Basic ${btoa(`${user.username}:${user.password}`)}`
				}
			})
			if (r.status == 401) {
				return await editMessage(env, id, res.result.message_id, "登录失败，可能需要重新登录 : \n" + (await r.text()))
			}
			const data: UndoneList = await r.json()
			const undoneList = data.undoneList;
			if (undoneList.length == 0) {
				return await editMessage(env, id, res.result.message_id, "当前没有未完成的作业。")
			}
			const classes: { [classId: string]: UndoneListItem[] } = {}
			undoneList.forEach(item => {
				if (!classes[item.courseInfo.id]) {
					classes[item.courseInfo.id] = []
				}
				classes[item.courseInfo.id].push(item)
			})
			const reply_markup: Array<Array<{ text: string, callback_data?: string }>> = [];
			for (const classId in classes) {
				const classItem = classes[classId]
				const courseInfo = classItem[0].courseInfo
				reply_markup.push([{
					text: `${courseInfo.name}`,
					callback_data: '0'
				},
				{
					text: `${courseInfo.teachers}`,
					callback_data: '0'
				}
				])
				classItem.forEach(item => {
					reply_markup.push([{
						text: `📚 ${item.activityName}`,
						callback_data: item.activityId
					}])
				})
			}
			return await api(env, 'editMessageText', {
				chat_id: id.toString(),
				message_id: res.result.message_id.toString(),
				text: `当前共有 ${undoneList.length} 个未完成的作业：`,
				reply_markup: JSON.stringify({ inline_keyboard: reply_markup })
			})
		} catch (e: any) {
			return await editMessage(env, id, res.result.message_id, "获取失败: \n" + e.toString())
		}
	} else if (message.startsWith('/push')) {
		const user: User = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()
		if (!user) {
			return await sendMessage(env, id, "未登录。使用 `/login username password` 登录。", 'MarkdownV2')
		}
		const state = user.push ? 0 : 1
		await env.DB.prepare(`INSERT INTO users (id, username, password, push, undoneList) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, password = excluded.password, push = excluded.push, undoneList = excluded.undoneList`)
			.bind(id, user.username, user.password, state, user.undoneList)
			.run()
		return await sendMessage(env, id, state ? "推送已开启。" : "推送已关闭。", 'MarkdownV2')
	}
}

function filterAndExtractImages(html: string) {
	const allowedTags = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre'];
	const images: string[] = [];
	let filteredHtml = '';
	let _isImgTag = false;
	const parser = new Parser({
		onopentag: (name, attribs) => {
			// if (name === 'br') {
			// 	filteredHtml += '\n';
			// }
			if (allowedTags.includes(name)) {
				filteredHtml += `<${name}>`;
			}
		},
		ontext: text => {
			filteredHtml += text;
		},
		onclosetag: (tagname) => {
			if (tagname === 'p') {
				filteredHtml += '\n';
			}
			if (allowedTags.includes(tagname)) {
				filteredHtml += `</${tagname}>`;
			}
			if (tagname === 'img') {
				_isImgTag = false;
			}
		},
		onopentagname: (name) => {
			if (name === 'img') {
				_isImgTag = true;
			}
		},
		onattribute: (name, value) => {
			if (_isImgTag && name === 'src') {
				images.push(value);
			}
		}
	}, { decodeEntities: true });
	parser.write(html);
	parser.end();

	return {
		html: filteredHtml,
		images
	};
}

export async function sendTask(env: Env, id: number, detail: Detail) {
	let { assignmentTitle, assignmentContent, chapterName, courseInfo, assignmentBeginTime, assignmentEndTime } = detail
	const { html: content, images } = filterAndExtractImages(assignmentContent)
	if (images.length) {
		await api(env, 'sendMediaGroup', {
			chat_id: id.toString(),
			media: JSON.stringify(images.map(image => ({
				type: 'photo',
				media: image
			})))
		})
	}
	let couseName = courseInfo && courseInfo.name && courseInfo.teachers ? "#" + courseInfo.name + "(" + courseInfo?.teachers + ")" : ''
	const text = `<b>${assignmentTitle}</b>\n<b>课程: </b>${couseName}\n<b>章节</b>: ${chapterName || '-'}\n<b>开始时间</b>: ${assignmentBeginTime}\n<b>结束时间</b>: ${assignmentEndTime}\n\n${content}`
	let reply_markup: {
		text: string;
		url: string;
	}[][] = []
	if (detail.resource) {
		reply_markup = reply_markup.concat(detail.resource.map((x: ResourceDetail) => ([{
			text: x.name,
			url: `https://fileucloud.bupt.edu.cn/ucloud/document/${x.storageId}.${x.ext}`
		}])))
	}
	return await api(env, 'sendMessage', {
		chat_id: id.toString(),
		text,
		parse_mode: 'HTML',
		reply_markup: JSON.stringify({
			inline_keyboard: reply_markup
		})
	})
}

const router = Router();

router.post('/webhook', async (request, env: Env) => {
	if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') != env.ENV_BOT_SECRET) {
		return new Response('Not Found.', { status: 404 });
	}
	const data = await request.json()
	if (data.message) {
		const { message } = data
		if (message.text) {
			const { text }: { text: string } = message
			if (text.startsWith('/')) {
				return new Response(JSON.stringify(await onCommand(text, message.chat.id, env)))
			}
		}
	} else if (data.callback_query) {
		const { callback_query } = data
		const { data: activityId, from } = callback_query
		if (activityId == '0') {
			await api(env, 'answerCallbackQuery', { callback_query_id: callback_query.id })
			return new Response('Ok')
		}
		const id = from.id
		const user: User = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()
		if (!user) {
			return await sendMessage(env, id, "未登录。使用 `/login username password` 登录。", 'MarkdownV2')
		}
		const res = await fetch(env.API_FETCH + "/homework?id=" + activityId, {
			headers: {
				"Authorization": `Basic ${btoa(`${user.username}:${user.password}`)}`
			}
		})
		if (res.status != 200) {
			return new Response(JSON.stringify(await sendMessage(env, id, "获取作业详情失败: \n" + (await res.text()))))
		}
		const detail: Detail = await res.json()
		await api(env, 'answerCallbackQuery', { callback_query_id: callback_query.id })
		return new Response(JSON.stringify(await sendTask(env, id, detail)))
	}
	return new Response('Ok')
})

router.get('/getUpdates', async ({ }, env: Env) => {
	const r = await api(env, 'getUpdates')
	return new Response(JSON.stringify(r, null, 2))
});

router.get('/setWebhook', async (request, env: Env) => {
	const url = new URL(request.url)
	const webhookUrl = `${url.protocol}//${url.hostname}/webhook`
	const r: any = await (await fetch(apiUrl(env, 'setWebhook', { url: webhookUrl, secret_token: env.ENV_BOT_SECRET }))).json()
	return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))

})

router.all('*', () => new Response('Not Found.', { status: 404 }));

export default router;
