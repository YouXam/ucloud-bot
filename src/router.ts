import { Router } from 'itty-router';
import { UndoneList, UndoneListItem, ResourceDetail, Detail, User, Submitting, SubmittingD1, CourseInfo, Attachment } from './types';
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
	const res2 = await res.json()
	console.log(methodName, params, "=>", res2)
	return res2
}
async function safeFetch(input: RequestInfo<unknown, CfProperties<unknown>>, init?: RequestInit<RequestInitCfProperties> | undefined): Promise<Response> {
	return new Promise(async (resolve, reject) => {
		try {
			console.debug("Using api:", input)
			const res = await fetch(input, init)
			if (res.status != 200) {
				throw new Error(await res.text())
			}
			const cloned = res.clone()
			const resBody = await cloned.text()
			console.debug("Api response:", input, resBody)
			resolve(res)
		} catch (e) {
			reject(e)
		}
	})
}
async function fetchAPI(type: 'race' | 'fallback', env: Env, path: string, options?: RequestInit) {
	if (type === 'race') {
		const jobs = env.API_FETCH.map(x => safeFetch(x + path, options))
		return await Promise.any(jobs).catch(e => {
			if (e instanceof AggregateError) {
				throw e.errors[0]
			}
		}) as Response
	}
	let error = null
	for (const url of env.API_FETCH) {
		try {
			return await safeFetch(url + path, options)
		} catch (e) {
			console.error(url, e)
			error = e
		}
	}
	throw error || new Error('No API_FETCH')
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
async function exit_submit(id: number, env: Env, mode: 'command' | 'callback' = 'command') {
	const user: User | null = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()
	if (!user) {
		return await sendMessage(env, id, "未登录。使用 `/login username password` 登录。", 'MarkdownV2')
	}
	const submitting: SubmittingD1 | null = await env.DB.prepare(`SELECT * FROM submitting WHERE username = ?`).bind(user.username).first()
	if (!submitting || !submitting.is_submitting) {
		if (mode === 'command') {
			await sendMessage(env, id, "当前没有正在提交的作业。", 'MarkdownV2')
		}
		return
	}
	// 恢复 reply_to 的 inline_keybord, 编辑 submitting message 为已取消
	const reply_markup = JSON.parse(submitting.reply_markup)
	reply_markup.inline_keyboard[reply_markup.inline_keyboard.length - 1] = [
		{
			text: '提交',
			callback_data: 's' + submitting.assignment_id
		}
	]
	await api(env, 'editMessageReplyMarkup', {
		chat_id: submitting.channel_id,
		message_id: submitting.reply_to,
		reply_markup: JSON.stringify(reply_markup)
	})
	await api(env, 'editMessageText', {
		chat_id: submitting.channel_id,
		message_id: submitting.message_id,
		text: "已取消提交。"
	})
	await env.DB.prepare(`DELETE FROM submitting WHERE username = ?`).bind(user.username).run()
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
			const r = await fetchAPI('race', env, "/undoneList", {
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
			if (res) await editMessage(env, id, res.result.message_id, "登录失败: \n" + (e.message || e.toString()))
		}
	} else if (message.startsWith('/list')) {
		const res: { result: { message_id: number } } = await sendMessage(env, id, "请稍等...") as any
		try {
			const user: User | null = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first()
			if (!user) {
				return await editMessage(env, id, res.result.message_id, "未登录。使用 /login username password 登录。")
			}
			const r = await fetchAPI('race', env, "/undoneList", {
				headers: {
					"Authorization": `Basic ${btoa(`${user.username}:${user.password}`)}`
				}
			})
			if (r.status == 401) {
				return await editMessage(env, id, res.result.message_id, "登录失败，可能需要重新登录 : \n" + (await r.text()))
			}
			if (r.status != 200) {
				console.error("status:", r.status)
				const body = await r.text()
				console.log("Error: ", body)
				throw new Error(body)
			}
			const data: UndoneList = await r.json()
			const undoneList = data.undoneList;
			if (undoneList.length == 0) {
				return await editMessage(env, id, res.result.message_id, "当前没有未完成的作业。")
			}
			const classes: { [classId: string]: UndoneListItem[] } = {}
			undoneList.forEach(item => {
				if (item?.courseInfo?.id) {
					classes[item.courseInfo.id] = [
						...(classes[item.courseInfo.id] || []),
						item
					]
				} else {
					classes['0'] = [
						...(classes['0'] || []),
						{
							...item,
							courseInfo: {
								id: 0,
								name: '未知课程',
								teachers: '未知教师'
							}
						}
					]
				}
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
						callback_data: item.type === 3 ? item.activityId : "us." + item.type + "." + item.activityId
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
			console.error(e.stack || e.message || e.toString())
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
	} else if (message.startsWith('/exit_submit')) {
		await exit_submit(id, env, 'command')
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
const alertTip = {
	'new': '',
	"hour": '<b>⚠️ 剩余时间不足一小时 ⚠️</b>\n\n',
	"day": '<b>⚠️ 剩余时间不足一天 ⚠️</b>\n\n' 
}
export async function sendTask(env: Env, id: number, detail: Detail, alertType: 'new' | 'hour' | 'day'='new') {
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

	const text = `${alertTip[alertType]}<b>${assignmentTitle}</b>\n<b>课程: </b>${couseName}\n<b>章节</b>: ${chapterName || '-'}\n<b>开始时间</b>: ${assignmentBeginTime}\n<b>结束时间</b>: ${assignmentEndTime}\n\n${content}`
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
		function getReplyMarkup(x: ResourceDetail) {
			if (x.ext == 'doc' || x.ext == 'docx' || x.ext == 'ppt' || x.ext == 'pptx' || x.ext == 'xls' || x.ext == 'xlsx') {
				return [{
						text: x.name,
						url: getPreviewURL(x)
					},
					{
						text: '下载',
						url: x.url
					}
				]
			}
			return [{
				text: x.name,
				url: x.url
			}]
		}
		reply_markup = reply_markup.concat(detail.resource.map(getReplyMarkup))
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
export async function sendUndoneItem(env: Env, id: number, item: Pick<UndoneListItem, 'activityName' | 'courseInfo' | 'endTime' | 'type' | 'activityId'>, alertType: 'new' | 'hour' | 'day'='new') {
	const { activityName, courseInfo, endTime } = item
	const couseName = courseInfo && courseInfo.name && courseInfo.teachers ? "#" + courseInfo.name + "(" + courseInfo?.teachers + ")" : ''
	const typename = {
		2: '问卷',
		3: '作业',
		4: '测验'
	}[item.type] || '未知'
	const text = `${alertTip[alertType]}<b>${activityName}</b>\n<b>课程: </b>${couseName}\n<b>结束时间</b>: ${endTime}\n\n<b>此任务为 ${typename}，请在云邮教学空间网页端提交。</b>`
	return await api(env, 'sendMessage', {
		chat_id: id.toString(),
		text,
		parse_mode: 'HTML'
	})
}
async function updateSubmitting(env: Env, submitting: Submitting): Promise<string> {
	const { id, username, assignment_id, content, attachments, message_id, detail, reply_to, channel_id } = submitting
	let text = submitting.is_submitting ? 
		`正在提交 <b>${detail.assignmentTitle}</b>，请直接发送文字、文件或图片，发送完毕后点击“提交”按钮以提交。\n\n`
		: `已提交 <b>${detail.assignmentTitle}</b>：\n\n`
	if (content) {
		text += `<b>内容</b>：\n${content}\n\n`
	}
	if (attachments.length) {
		text += `<b>附件</b>：\n${attachments.map((x, i)=> {
			if (x.uploading) {
				return (i + 1) + ". " + x.filename + ' (上传中...)'
			} else {
				return (i + 1) + '. <a href="' + x.url + '">' + x.filename + '</a>'
			}
		}).join('\n')}\n\n`
	}
	const rmfile_reply_markup = []
	if (attachments.length) {
		let line = []
		for (let i = 0; i < attachments.length; i++) {
			line.push({
				text: "❌ " + (i + 1).toString(),
				callback_data: 'rmfile.' + i
			})
			if (line.length == 5) {
				rmfile_reply_markup.push(line)
				line = []
			}
		}
		if (line.length) {
			rmfile_reply_markup.push(line)
		}
		if (rmfile_reply_markup.length !== 1 || rmfile_reply_markup[0].length !== 1) {
			rmfile_reply_markup.push([{
				text: '❌ 全部删除',
				callback_data: 'rmfile'
			}])
		}
	}
	const res: any = await api(env, message_id ? 'editMessageText' : 'sendMessage', {
		chat_id: channel_id,
		text,
		message_id: message_id,
		parse_mode: 'HTML',
		reply_to_message_id: reply_to,
		reply_markup: submitting.is_submitting ? JSON.stringify({
			inline_keyboard: [
				...rmfile_reply_markup,
				[
					{
						text: '取消',
						callback_data: 'ec'
					},
					{
						text: '提交',
						callback_data: 'es'
					}
				]
			]
		}) : { inline_keyboard: [] },
		link_preview_options: {
			prefer_small_media: true,
			show_above_text: true
		}
	})
	if (!res || !res.ok) {
		console.error('Error', res)
		return ''
	}
	return message_id || res.result.message_id.toString();
}

const router = Router();

router.post('/webhook', async (request, env: Env, ctx: ExecutionContext) => {
	if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') != env.ENV_BOT_SECRET) {
		return new Response('Not Found.', { status: 404 });
	}
	const data = await request.json()
	console.log(data)
	if (data.message) {
		const { message } = data
		if (!message.text && !message.caption && !message.document && !message.photo) {
			return new Response('Ok')
		}
		if (message.text && message.text.startsWith('/')) {
			return new Response(JSON.stringify(await onCommand(message.text, message.chat.id, env)))
		}
		const user: User | null = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(message.chat.id).first()
		if (!user) {
			return new Response('ok')
		}

		// 处理提交
		const preSubmittingD1: SubmittingD1 | null = await env.DB.prepare(`SELECT * FROM submitting WHERE username = ?`)
				.bind(user.username).first()
		const preSubmitting: Submitting | null = preSubmittingD1 ? {
			...preSubmittingD1,
			attachments: JSON.parse(preSubmittingD1.attachments),
			detail: JSON.parse(preSubmittingD1.detail),
			reply_markup: JSON.parse(preSubmittingD1.reply_markup)
		} : null
		if (!preSubmitting || !preSubmitting.is_submitting) {
			return new Response('ok')
		}
		if (message.text) {
			const text = message.text
			preSubmitting.content = preSubmitting.content.length ? preSubmitting.content + '\n' + text : text
			await env.DB.prepare('UPDATE submitting SET content = ? WHERE username = ?').bind(
				preSubmitting.content, user.username
			).run()
			await updateSubmitting(env, preSubmitting)
		}
		if (message.document || message.photo) {
			let temp_filename = null
			const { file_name: filename, mime_type, file_id } = message.document ? message.document : {
				file_name: (temp_filename = message.photo[message.photo.length - 1].file_unique_id + 'temp.jpg'),
				mime_type: 'image/jpeg',
				file_id: message.photo[message.photo.length - 1].file_id
			}
			let position = preSubmitting.attachments.findIndex(x => x.file_id == file_id)
			if (position === -1) {
				position = preSubmitting.attachments.length
				preSubmitting.attachments.push({
					resourceId: '',
					url: '',
					filename,
					mime_type,
					file_id,
					uploading: true
				})
			}
			if (message.caption) {
				preSubmitting.content = preSubmitting.content.length ? preSubmitting.content + '\n' + message.caption : message.caption
				await env.DB.prepare('UPDATE submitting SET content = ?, attachments = ? WHERE username = ?').bind(
					preSubmitting.content, JSON.stringify(preSubmitting.attachments), user.username
				).run()
			} else {
				await env.DB.prepare('UPDATE submitting SET attachments = ? WHERE username = ?').bind(
					JSON.stringify(preSubmitting.attachments), user.username
				).run()
			}
			await updateSubmitting(env, preSubmitting)
			const r: any = await api(env, 'getFile', { file_id })
			if (!r.ok) {
				await sendMessage(env, message.chat.id, "获取文件失败")
				return new Response("ok")
			}
			const url = "https://api.telegram.org/file/bot" + env.ENV_BOT_TOKEN + "/" + r.result.file_path
			const r2 = await fetchAPI('fallback', env, "/upload", {
				method: "POST",
				headers: {
					"Authorization": `Basic ${btoa(`${user.username}:${user.password}`)}`
				},
				body: JSON.stringify({ url, filename, mime_type })
			})
			const attachment: any = await r2.json()
			const newAttachments = {
				resourceId: attachment.resourceId,
				url: attachment.previewUrl,
				filename: temp_filename ? r.result.file_path.split('/').join("_") : filename,
				mime_type
			}
			const preSubmitting2D1: SubmittingD1 | null = await env.DB.prepare(`SELECT * FROM submitting WHERE username = ?`)
				.bind(user.username).first()
			const preSubmitting2: Submitting | null = preSubmitting2D1 ? {
				...preSubmitting2D1,
				attachments: JSON.parse(preSubmitting2D1.attachments),
				detail: JSON.parse(preSubmitting2D1.detail),
				reply_markup: JSON.parse(preSubmitting2D1.reply_markup)
			} : null
			if (!preSubmitting2 || !preSubmitting2.is_submitting) {
				return new Response('ok')
			}
			if (preSubmitting2.attachments.length == position) {
				preSubmitting2.attachments.push(newAttachments)
			} else {
				preSubmitting2.attachments[position] = newAttachments
			}
			ctx.waitUntil(env.DB.prepare('UPDATE submitting SET attachments = ? WHERE username = ?').bind(
				JSON.stringify(preSubmitting2.attachments), user.username
			).run())
			await updateSubmitting(env, preSubmitting2)
		}
	} else if (data.callback_query) {
		const { callback_query } = data
		const { data: callback_data, from } = callback_query
		if (callback_data == '0') {
			// 用户点击教师或课程
			ctx.waitUntil(api(env, 'answerCallbackQuery', {
				callback_query_id: callback_query.id,
				show_alert: true,
				text: '暂不支持查看教师或课程详情'
			}))
			return new Response('Ok')
		} else if (callback_data == '-1') {
			// 提交状态点击“提交中”
			ctx.waitUntil(api(env, 'answerCallbackQuery', {
				callback_query_id: callback_query.id,
				text: '当前作业正在提交。'
			}))
			return new Response('Ok') 
		} else if (callback_data.startsWith('s')) {
			// 进入提交状态
			const submittingId = callback_data.substr(1)
			const user: User | null = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(from.id).first()
			if (!user) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '未登录。使用 `/login username password` 登录。'
				}))
				return new Response('Ok')
			}
			const preSubmittingD1: SubmittingD1 | null = await env.DB.prepare(`SELECT 
				* FROM submitting WHERE username = ?`).bind(user.username).first()
			const preSubmitting: Submitting | null = preSubmittingD1 ? {
				...preSubmittingD1,
				attachments: JSON.parse(preSubmittingD1.attachments),
				detail: JSON.parse(preSubmittingD1.detail),
				reply_markup: JSON.parse(preSubmittingD1.reply_markup)
			} : null
			if (preSubmitting && preSubmitting.is_submitting) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '当前已有提交中的作业，请提交完成后再试。'
				}))
				return new Response('Ok')
			}

			const res = await fetchAPI('race', env, "/homework?id=" + submittingId, {
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
			console.log(data.callback_query.message)
			const submitting: Submitting = {
				username: user.username,
				assignment_id: submittingId,
				is_submitting: true,
				content: '',
				attachments: [],
				message_id: null,
				detail: detail,
				channel_id: callback_query.message.chat.id.toString(),
				reply_to: callback_query.message.message_id.toString(),
				reply_markup: data.callback_query.message.reply_markup
			}
			submitting.message_id = await updateSubmitting(env, submitting)
			const inline_keyboard = data.callback_query.message.reply_markup.inline_keyboard
			inline_keyboard[inline_keyboard.length - 1] = [
				{
					text: '提交中...',
					callback_data: '-1'
				}
			]
			ctx.waitUntil(api(env, 'editMessageReplyMarkup', {
				chat_id: submitting.channel_id,
				message_id: submitting.reply_to,
				reply_markup: JSON.stringify({
					inline_keyboard
				})
			}))
			await env.DB.prepare(
				`INSERT INTO submitting
					(username, assignment_id, is_submitting, content, attachments, message_id, detail, channel_id, reply_to, reply_markup)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(username)
				DO UPDATE SET
					username = excluded.username, assignment_id = excluded.assignment_id, is_submitting = excluded.is_submitting,
					content = excluded.content, attachments = excluded.attachments, message_id = excluded.message_id,
					detail = excluded.detail, channel_id = excluded.channel_id, reply_to = excluded.reply_to,
					reply_markup = excluded.reply_markup`
			).bind(
				submitting.username, submitting.assignment_id, submitting.is_submitting ? 1 : 0,
				submitting.content, JSON.stringify(submitting.attachments), submitting.message_id,
				JSON.stringify(submitting.detail), submitting.channel_id, submitting.reply_to,
				JSON.stringify(submitting.reply_markup)
			).run()
			ctx.waitUntil(api(env, 'answerCallbackQuery', { callback_query_id: callback_query.id }))
		} else if (callback_data == 'es') {
			// 提交作业
			const user: User | null = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(from.id).first()
			if (!user) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '未登录。使用 `/login username password` 登录。'
				}))
				return new Response('Ok')
			}
			const preSubmittingD1: SubmittingD1 | null = await env.DB.prepare(`SELECT 
				* FROM submitting WHERE username = ?`).bind(user.username).first()
			const preSubmitting: Submitting | null = preSubmittingD1 ? {
				...preSubmittingD1,
				attachments: JSON.parse(preSubmittingD1.attachments),
				detail: JSON.parse(preSubmittingD1.detail),
				reply_markup: JSON.parse(preSubmittingD1.reply_markup)
			} : null
			if (!preSubmitting || !preSubmitting.is_submitting) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '当前没有提交中的作业'
				}))
				return new Response('Ok')
			}
			if (!preSubmitting.content && !preSubmitting.attachments.length) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '请发送内容或附件'
				}))
				return new Response('Ok')
			}
			if (preSubmitting.attachments.some(x => x.uploading)) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '请等待附件上传完成'
				}))
				return new Response('Ok')
			}
			console.log("submit", preSubmitting.assignment_id, preSubmitting.content, preSubmitting.attachments)
			const s = await fetchAPI('fallback', env, "/submit", {
				headers: {
					"Authorization": `Basic ${btoa(`${user.username}:${user.password}`)}`
				},
				method: "POST",
				body: JSON.stringify({
					assignmentId: preSubmitting.assignment_id,
					assignmentContent: preSubmitting.content,
					attachmentIds: preSubmitting.attachments.map(x => x.resourceId)
				})
			})
			console.log(await s.text())
			const inline_keyboard = preSubmitting.reply_markup.inline_keyboard
			if (inline_keyboard) {
				inline_keyboard[inline_keyboard.length - 1] = [
					{
						text: '再次提交',
						callback_data: 's' + preSubmitting.assignment_id
					}
				]
			}
			ctx.waitUntil(api(env, 'editMessageReplyMarkup', {
				chat_id: preSubmitting.channel_id,
				message_id: preSubmitting.reply_to,
				reply_markup: JSON.stringify({
					inline_keyboard
				})
			}))
			preSubmitting.is_submitting = false
			updateSubmitting(env, preSubmitting)
			await env.DB.prepare(`DELETE FROM submitting WHERE username = ?`).bind(user.username).run()
			await api(env, 'answerCallbackQuery', {
				callback_query_id: callback_query.id,
				text: '提交成功'
			})
		} else if (callback_data == 'ec') {
			await exit_submit(from.id, env, 'callback')
			await api(env, 'answerCallbackQuery', {
				callback_query_id: callback_query.id,
				text: '已取消提交'
			})
		} else if (callback_data.startsWith('us')) {
			// 用户点击未支持的作业
			// 2: 问卷，4: 测验
			const [_, type, activityId] = callback_data.split('.') as [string, string, string]
			try {
				const res = await fetchAPI('fallback', env, "/cache?id=" + activityId)
				const info: {
					info: CourseInfo & {
						endTime: string,
						activityName: string
					}
				} = await res.json()
				await sendUndoneItem(env, from.id, {
					type: parseInt(type),
					courseInfo: info.info,
					endTime: info.info.endTime,
					activityId,
					activityName: info.info.activityName
				})
				ctx.waitUntil(api(env, 'answerCallbackQuery', { callback_query_id: callback_query.id }))
			} catch (e) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '获取作业详情失败: \n' + ((e as Error).message || (e as any).toString())
				}))
			}
			
		} else if (callback_data.startsWith('rmfile')) {
			// 用户删除附件
			const user: User | null = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(from.id).first()
			if (!user) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '未登录。使用 `/login username password` 登录。'
				}))
				return new Response('Ok')
			}
			const submitting: SubmittingD1 | null = await env.DB.prepare(`SELECT * FROM submitting WHERE username = ?`).bind(user.username).first()
			if (!submitting || !submitting.is_submitting) {
				ctx.waitUntil(api(env, 'answerCallbackQuery', {
					callback_query_id: callback_query.id,
					show_alert: 'true',
					text: '当前没有正在提交的作业。'
				}))
				return new Response('Ok')
			}
			let preAttachments = JSON.parse(submitting.attachments)
			if (callback_data === 'rmfile') {
				preAttachments = []
			} else {
				const index = parseInt(callback_data.split('.')[1])
				preAttachments.splice(index, 1)
			}
			await env.DB.prepare(`UPDATE submitting SET attachments = ? WHERE username = ?`).bind(
				JSON.stringify(preAttachments), user.username
			).run()
			await updateSubmitting(env, {
				...submitting,
				attachments: preAttachments,
				reply_markup: JSON.parse(submitting.reply_markup),
				detail: JSON.parse(submitting.detail)
			})
			ctx.waitUntil(api(env, 'answerCallbackQuery', { callback_query_id: callback_query.id }))
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
			const res = await fetchAPI('race', env, "/homework?id=" + callback_data, {
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


router.get('/setWebhook', async (request, env: Env) => {
	const url = new URL(request.url)
	const proto = request.headers.get('X-Forwarded-Proto') ? request.headers.get('X-Forwarded-Proto') + ":" : url.protocol
	const host = request.headers.get('host') || url.hostname
	const webhookUrl = `${proto}//${host}/webhook`
	const jobs = [
		api(env, 'setMyDescription', { description: '查看/推送「云邮教学空间」作业' }),
		api(env, 'setMyCommands', { commands: [
			{ command: 'start', description: '开始' },
			{ command: 'login', description: '登录' },
			{ command: 'list', description: '查看未完成的作业' },
			{ command: 'push', description: '开启/关闭推送' },
			{ command: 'exit_submit', description: '取消提交' },
		] }),
		api(env, 'setMyShortDescription', { short_description: '查看/推送「云邮教学空间」作业' }),
		(await fetch(apiUrl(env, 'setWebhook', { url: webhookUrl, secret_token: env.ENV_BOT_SECRET }))).json()
	]
	const results = await Promise.allSettled(jobs)
	return new Response(JSON.stringify({
		webhook: webhookUrl,
		succeed: results.filter(x => x.status == 'fulfilled').length == jobs.length,
		results: results.map(x => x.status == 'fulfilled' ? x.value : x.reason)
	}), { status: 200, headers: { 'content-type': 'application/json' }})

})

router.all('*', () => new Response('Not Found.', { status: 404 }));

export default router;
