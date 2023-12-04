import { Router } from 'itty-router';
import { UndoneList, UndoneListItem, ResourceDetail, Detail, User, Submitting } from './types';
import { Parser } from 'htmlparser2';

function apiUrl(env: Env, methodName: string, params?: { [key: string]: any }) {
	if (params) {
		const query = new URLSearchParams(params)
		return `https://api.telegram.org/bot${env.ENV_BOT_TOKEN}/${methodName}?${query.toString()}`
	}
	return `https://api.telegram.org/bot${env.ENV_BOT_TOKEN}/${methodName}`
}
async function api(env: Env, methodName: string, params?: { [key: string]: any }) {
	const url = apiUrl(env, methodName)
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify(params)
	})
	return await res.json()
}

async function sendMessage(env: Env, chat_id: number, text: string, parse_mode = 'HTML', reply_to?: number) {
	try {
		return await api(env, 'sendMessage', {
			chat_id: chat_id,
			text, parse_mode,
			reply_to_message_id: reply_to
		})
	} catch (err) {
		console.error(err)
		return null
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
			const user: User | null = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()
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
		const user: User | null = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()
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
function base64(n: number) {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';
	n++;
	let result = '', index = 0
	while (n) {
		const base = index > 0 ? 63 : 52;
		result += chars[n % base];
		n = Math.floor(n / base);
		index++;
	}
	return result;
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
		url?: string;
		callback_data?: string;
	}[][] = []
	if (detail.resource) {
		function getPreviewURL(x: ResourceDetail) {
			if (x.ext == 'doc' || x.ext == 'docx' || x.ext == 'ppt' || x.ext == 'pptx' || x.ext == 'xls' || x.ext == 'xlsx') {
				if (x.ext == 'doc' || x.ext == 'docx') {
					const urla = "http://psg3-view-wopi.wopi.online.office.net:808/oh/wopi/files/@/wFileId?wFileId="
					const urlb = urla + encodeURIComponent(x.url)
					const urlc = "https://psg3-word-view.officeapps.live.com/wv/WordViewer/request.pdf?WOPIsrc=" + encodeURIComponent(urlb) + "&access_token=1&access_token_ttl=0&type=printpdf"
					return urlc
				}
				return "https://view.officeapps.live.com/op/view.aspx?src=" + encodeURIComponent(x.url)
			}
			return x.url
		}
		reply_markup = reply_markup.concat(detail.resource.map((x: ResourceDetail) => ([{
				text: x.name,
				url: getPreviewURL(x)
			},
			{
				text: '下载',
				url: x.url
			}
		])))
	}
	reply_markup = reply_markup.concat([[
		{
			text: '提交',
			callback_data: 's' + detail.id
		}
	]])
	return await api(env, 'sendMessage', {
		chat_id: id.toString(),
		text,
		parse_mode: 'HTML',
		reply_markup: JSON.stringify({
			inline_keyboard: reply_markup
		})
	})
}

async function updateSubmitting(env: Env, submitting: Submitting): Promise<string> {
	const { id, username, assignment_id, content, attachments, messageId, detail, reply_to, channelId } = submitting
	let text = `正在提交 ${detail.assignmentTitle}，请直接发送文件或文字，发送完毕后点击“提交”按钮以提交。\n\n`
	if (content) {
		text += `内容：\n${content}\n\n`
	}
	if (attachments.length) {
		text += `附件：\n${attachments.map(x => '[' + x.filename + '](' + x.url + ')').join('\n')}\n\n`
	}
	const res: any = await api(env, messageId ? 'editMessageText' : 'sendMessage', {
		chat_id: channelId,
		text,
		message_id: messageId,
		parse_mode: 'MarkdownV2',
		reply_to_message_id: reply_to,
		reply_markup: JSON.stringify({
			inline_keyboard: [
				[
					{
						text: '提交',
						callback_data: 'es'
					}
				]
			]
		})
	})
	if (!res || !res.ok) {
		console.error('Error', res)
		return ''
	}
	return messageId || res.result.message_id.toString();
}

const router = Router();

router.post('/webhook', async (request, env: Env, ctx: ExecutionContext) => {
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
			// 用户点击教师或课程
			ctx.waitUntil(api(env, 'answerCallbackQuery', {
				callback_query_id: callback_query.id,
				show_alert: true,
				text: '暂不支持查看教师或课程详情'
			}))
			return new Response('Ok')
		} else if (activityId.startsWith('s')) {
			// 用户点击提交
			const submittingId = activityId.substr(1)
			const user: User | null = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(from.id).first()
			if (!user) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '未登录。使用 `/login username password` 登录。'
				}))
				return new Response('Ok')
			}
			const preSubmitting: Submitting | null = await env.DB.prepare(`SELECT * FROM submitting WHERE username = ?`).bind(user.username).first()
			console.log(preSubmitting)
			if (preSubmitting && preSubmitting.isSubmitting) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '当前已有提交中的作业，请提交完成后再试。'
				}))
				return new Response('Ok')
			}
			const res = await fetch(env.API_FETCH + "/homework?id=" + submittingId, {
				headers: {
					"Authorization": `Basic ${btoa(`${user.username}:${user.password}`)}`
				}
			})
			if (res.status != 200) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '获取作业详情失败: \n' + (await res.text())
				}))
				return new Response('Ok')
			}
			const detail: Detail = await res.json()
			const submitting: Submitting = {
				username: user.username,
				assignment_id: submittingId,
				isSubmitting: true,
				content: '',
				attachments: [],
				messageId: null,
				detail: detail,
				channelId: callback_query.message.chat.id.toString(),
				reply_to: callback_query.message.message_id.toString()
			}
			submitting.messageId = await updateSubmitting(env, submitting)
			await env.DB.prepare(
				`INSERT INTO submitting
					(username, assignment_id, is_submitting, content, attachments, message_id, detail, channelId, reply_to)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(username)
				DO UPDATE SET
					username = excluded.username, assignment_id = excluded.assignment_id, is_submitting = excluded.is_submitting,
					content = excluded.content, attachments = excluded.attachments, message_id = excluded.message_id,
					detail = excluded.detail, channelId = excluded.channelId, reply_to = excluded.reply_to`
			).bind(
				submitting.username, submitting.assignment_id, submitting.isSubmitting ? 1 : 0,
				submitting.content, JSON.stringify(submitting.attachments), submitting.messageId,
				JSON.stringify(submitting.detail), submitting.channelId, submitting.reply_to
			).run()
			ctx.waitUntil(api(env, 'answerCallbackQuery', { callback_query_id: callback_query.id }))
		} else if (activityId == 'es') {
			
		} else {
			// 用户点击作业
			const id = from.id
			const user: User | null = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()
			if (!user) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '未登录。使用 `/login username password` 登录。'
				}))
				return new Response('Ok')
			}
			const res = await fetch(env.API_FETCH + "/homework?id=" + activityId, {
				headers: {
					"Authorization": `Basic ${btoa(`${user.username}:${user.password}`)}`
				}
			})
			if (res.status != 200) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '获取作业详情失败: \n' + (await res.text())
				}))
				return new Response('Ok')
			}
			const detail: Detail = await res.json()
			ctx.waitUntil(api(env, 'answerCallbackQuery', { callback_query_id: callback_query.id }))
			return new Response(JSON.stringify(await sendTask(env, id, detail)))
		}
	}
	return new Response('Ok')
})

router.get('/getUpdates', async ({ }, env: Env) => {
	const r = await api(env, 'getUpdates')
	return new Response(JSON.stringify(r, null, 2))
});

router.get('/setWebhook', async (request, env: Env) => {
	const url = new URL(request.url)
	const proto = request.headers.get('X-Forwarded-Proto') ? request.headers.get('X-Forwarded-Proto') + ":" : url.protocol
	const host = request.headers.get('host') || url.hostname
	const webhookUrl = `${proto}//${host}/webhook`
	const r: any = await (await fetch(apiUrl(env, 'setWebhook', { url: webhookUrl, secret_token: env.ENV_BOT_SECRET }))).json()
	return new Response(JSON.stringify({
		webhook: webhookUrl,
		r
	}), { status: 200, headers: { 'content-type': 'application/json' }})

})

router.all('*', () => new Response('Not Found.', { status: 404 }));

export default router;
