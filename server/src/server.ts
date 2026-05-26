import express, { Response, Request } from "express"
import dotenv from "dotenv"
import http from "http"
import cors from "cors"
import axios from "axios"
import { SocketEvent, SocketId } from "./types/socket"
import { USER_CONNECTION_STATUS, User } from "./types/user"
import { Server } from "socket.io"
import path from "path"

dotenv.config()

const app = express()

app.use(express.json())

app.use(cors())

app.use(express.static(path.join(__dirname, "public"))) // Serve static files

const server = http.createServer(app)
const io = new Server(server, {
	cors: {
		origin: "*",
	},
	maxHttpBufferSize: 1e8,
	pingTimeout: 60000,
})

let userSocketMap: User[] = []

interface PistonRuntime {
	language: string
	version: string
	aliases: string[]
}

interface Judge0Language {
	id: number
	name: string
}

interface GeminiPart {
	text?: string
}

interface GeminiCandidate {
	content?: {
		parts?: GeminiPart[]
	}
}

interface GeminiGenerateContentResponse {
	candidates?: GeminiCandidate[]
}

const JUDGE0_URL =
	process.env.JUDGE0_URL?.replace(/\/$/, "") || "http://localhost:2358"

const GEMINI_API_BASE_URL =
	"https://generativelanguage.googleapis.com/v1beta/models"
const GEMINI_MODEL =
	(process.env.GEMINI_MODEL?.trim() || "gemini-flash-latest").replace(
		/^models\//,
		"",
	)

const languageAliases: Record<string, string[]> = {
	python: ["py"],
	javascript: ["js", "node", "nodejs"],
	typescript: ["ts"],
	java: ["jav"],
	c: ["h"],
	"c++": ["cpp", "cc", "cxx", "hpp", "hh"],
	"c#": ["cs"],
	go: ["golang"],
	rust: ["rs"],
	ruby: ["rb"],
	php: ["php"],
	swift: ["swift"],
	kotlin: ["kt", "kts"],
	scala: ["scala"],
	perl: ["pl"],
	r: ["r"],
	bash: ["sh"],
	powershell: ["ps1"],
}

function normalizeLanguageName(name: string): string {
	return name.split("(")[0].trim().toLowerCase()
}

function getVersionFromName(name: string): string {
	const versionMatch = name.match(/\(([^)]+)\)/)
	return versionMatch?.[1]?.trim() || ""
}

function mapJudge0ToPistonRuntime(language: Judge0Language): PistonRuntime {
	const normalized = normalizeLanguageName(language.name)
	return {
		language: normalized,
		version: getVersionFromName(language.name),
		aliases: languageAliases[normalized] || [],
	}
}

async function getJudge0Languages(): Promise<Judge0Language[]> {
	const response = await axios.get<Judge0Language[]>(`${JUDGE0_URL}/languages`)
	return response.data
}

function getJudge0LanguageId(
	languages: Judge0Language[],
	requestedLanguage: string,
): number | null {
	const requested = requestedLanguage.trim().toLowerCase()
	const byName = languages.find(
		(language) => normalizeLanguageName(language.name) === requested,
	)
	if (byName) return byName.id

	const aliasEntry = Object.entries(languageAliases).find(([, aliases]) =>
		aliases.includes(requested),
	)
	if (!aliasEntry) return null

	const [canonicalLanguage] = aliasEntry
	return (
		languages.find(
			(language) => normalizeLanguageName(language.name) === canonicalLanguage,
		)?.id || null
	)
}

app.get("/api/v2/piston/runtimes", async (_req: Request, res: Response) => {
	try {
		const languages = await getJudge0Languages()
		const runtimes = languages.map(mapJudge0ToPistonRuntime)
		res.json(runtimes)
	} catch (error) {
		if (axios.isAxiosError(error)) {
			console.error("Failed to fetch Judge0 languages", {
				status: error.response?.status,
				data: error.response?.data,
				message: error.message,
			})
			res.status(502).json({
				error: "Failed to fetch supported languages",
				details: error.response?.data || error.message,
			})
			return
		}

		console.error("Failed to fetch Judge0 languages", error)
		res.status(502).json({ error: "Failed to fetch supported languages" })
	}
})

app.post("/api/v2/piston/execute", async (req: Request, res: Response) => {
	try {
		const { language, files, stdin } = req.body as {
			language?: string
			files?: { name?: string; content?: string }[]
			stdin?: string
		}

		if (!language || !files || files.length === 0 || !files[0].content) {
			res.status(400).json({ error: "Invalid execute payload" })
			return
		}

		const languages = await getJudge0Languages()
		const languageId = getJudge0LanguageId(languages, language)

		if (!languageId) {
			res.status(400).json({ error: `Unsupported language: ${language}` })
			return
		}

		// Base64 encode source code and stdin to support emoji and non-ASCII characters
		const sourceCodeBase64 = Buffer.from(files[0].content).toString("base64")
		const stdinBase64 = Buffer.from(stdin || "").toString("base64")

		const response = await axios.post(`${JUDGE0_URL}/submissions`, {
			source_code: sourceCodeBase64,
			language_id: languageId,
			stdin: stdinBase64,
			redirect_stderr_to_stdout: false,
		}, {
			params: {
				base64_encoded: true,
				wait: true,
			},
		})

		const result = response.data as {
			stdout?: string
			stderr?: string
			compile_output?: string
			message?: string
			status?: { id?: number; description?: string }
		}

		// Decode base64-encoded output from Judge0
		const decodeBase64 = (str?: string) => {
			if (!str) return ""
			try {
				return Buffer.from(str, "base64").toString()
			} catch {
				return str
			}
		}

		const stdout = decodeBase64(result.stdout)
		const stderr = decodeBase64(result.stderr)
		const compileOutput = decodeBase64(result.compile_output)

		const stderrOutput = [
			stderr,
			compileOutput,
			result.message,
		]
			.filter(Boolean)
			.join("\n")

		res.json({
			run: {
				stdout: stdout || "",
				stderr: stderrOutput,
				code: result.status?.id || 0,
				signal: null,
				output: stdout || stderrOutput,
			},
		})
	} catch (error) {
		if (axios.isAxiosError(error)) {
			console.error("Judge0 execute error", {
				status: error.response?.status,
				data: error.response?.data,
				message: error.message,
			})
			res.status(502).json({
				error: "Failed to execute code",
				details: error.response?.data || error.message,
			})
			return
		}

		console.error("Judge0 execute error", error)
		res.status(502).json({ error: "Failed to execute code" })
	}
})

app.post("/api/v1/copilot/generate", async (req: Request, res: Response) => {
	try {
		const geminiApiKey = process.env.GEMINI_API_KEY?.trim()
		const { prompt } = req.body as { prompt?: string }

		if (!geminiApiKey) {
			res.status(500).json({ error: "GEMINI_API_KEY is not configured" })
			return
		}

		if (!prompt || prompt.trim().length === 0) {
			res.status(400).json({ error: "Prompt is required" })
			return
		}

		const response = await axios.post<GeminiGenerateContentResponse>(
			`${GEMINI_API_BASE_URL}/${GEMINI_MODEL}:generateContent`,
			{
				systemInstruction: {
					parts: [
						{
							text: "You are a code generator copilot for project named Code Sync. Generate code based on the given prompt without any explanation. Return only the code, formatted in Markdown using the appropriate language syntax (e.g., js for JavaScript, py for Python). Do not include any additional text or explanations. If you don't know the answer, respond with 'I don't know'.",
						},
					],
				},
				contents: [
					{
						parts: [
							{
								text: prompt,
							},
						],
					},
				],
				generationConfig: {
					maxOutputTokens: 2048,
				},
			},
			{
				params: {
					key: geminiApiKey,
				},
			},
		)

		const text = (response.data.candidates || [])
			.flatMap((candidate) => candidate.content?.parts || [])
			.map((part) => part.text)
			.filter((partText): partText is string => !!partText)
			.join("\n")

		if (!text) {
			res.status(502).json({ error: "Gemini returned an empty response" })
			return
		}

		res.json({ output: text })
	} catch (error) {
		if (axios.isAxiosError(error)) {
			console.error("Gemini generate error", {
				status: error.response?.status,
				data: error.response?.data,
				message: error.message,
			})
			res.status(502).json({
				error: "Failed to generate code",
				details: error.response?.data || error.message,
			})
			return
		}

		console.error("Gemini generate error", error)
		res.status(502).json({ error: "Failed to generate code" })
	}
})

// Function to get all users in a room
function getUsersInRoom(roomId: string): User[] {
	return userSocketMap.filter((user) => user.roomId == roomId)
}

// Function to get room id by socket id
function getRoomId(socketId: SocketId): string | null {
	const roomId = userSocketMap.find(
		(user) => user.socketId === socketId
	)?.roomId

	if (!roomId) {
		console.error("Room ID is undefined for socket ID:", socketId)
		return null
	}
	return roomId
}

function getUserBySocketId(socketId: SocketId): User | null {
	const user = userSocketMap.find((user) => user.socketId === socketId)
	if (!user) {
		console.error("User not found for socket ID:", socketId)
		return null
	}
	return user
}

// Connection Event

io.on("connection", (socket) => {
	// Handle user actions
	socket.on(SocketEvent.JOIN_REQUEST, ({ roomId, username }) => {
		// Check is username exist in the room
		const isUsernameExist = getUsersInRoom(roomId).filter(
			(u) => u.username === username
		)
		if (isUsernameExist.length > 0) {
			io.to(socket.id).emit(SocketEvent.USERNAME_EXISTS)
			return
		}

		const user = {
			username,
			roomId,
			status: USER_CONNECTION_STATUS.ONLINE,
			cursorPosition: 0,
			typing: false,
			socketId: socket.id,
			currentFile: null,
		}
		userSocketMap.push(user)
		socket.join(roomId)
		socket.broadcast.to(roomId).emit(SocketEvent.USER_JOINED, { user })
		const users = getUsersInRoom(roomId)
		io.to(socket.id).emit(SocketEvent.JOIN_ACCEPTED, { user, users })
	})


	// Handle user disconnection
	
	socket.on("disconnecting", () => {
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.USER_DISCONNECTED, { user })
		userSocketMap = userSocketMap.filter((u) => u.socketId !== socket.id)
		socket.leave(roomId)
	})

	// Handle file actions
	socket.on(
		SocketEvent.SYNC_FILE_STRUCTURE,
		({ fileStructure, openFiles, activeFile, socketId }) => {
			io.to(socketId).emit(SocketEvent.SYNC_FILE_STRUCTURE, {
				fileStructure,
				openFiles,
				activeFile,
			})
		}
	)

	socket.on(
		SocketEvent.DIRECTORY_CREATED,
		({ parentDirId, newDirectory }) => {
			const roomId = getRoomId(socket.id)
			if (!roomId) return
			socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_CREATED, {
				parentDirId,
				newDirectory,
			})
		}
	)

	socket.on(SocketEvent.DIRECTORY_UPDATED, ({ dirId, children }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_UPDATED, {
			dirId,
			children,
		})
	})

	socket.on(SocketEvent.DIRECTORY_RENAMED, ({ dirId, newName }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.DIRECTORY_RENAMED, {
			dirId,
			newName,
		})
	})

	socket.on(SocketEvent.DIRECTORY_DELETED, ({ dirId }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.DIRECTORY_DELETED, { dirId })
	})

	socket.on(SocketEvent.FILE_CREATED, ({ parentDirId, newFile }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.FILE_CREATED, { parentDirId, newFile })
	})

	socket.on(SocketEvent.FILE_UPDATED, ({ fileId, newContent }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_UPDATED, {
			fileId,
			newContent,
		})
	})

	socket.on(SocketEvent.FILE_RENAMED, ({ fileId, newName }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_RENAMED, {
			fileId,
			newName,
		})
	})

	socket.on(SocketEvent.FILE_DELETED, ({ fileId }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.FILE_DELETED, { fileId })
	})

	// Handle user status
	socket.on(SocketEvent.USER_OFFLINE, ({ socketId }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socketId) {
				return { ...user, status: USER_CONNECTION_STATUS.OFFLINE }
			}
			return user
		})
		const roomId = getRoomId(socketId)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.USER_OFFLINE, { socketId })
	})

	socket.on(SocketEvent.USER_ONLINE, ({ socketId }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socketId) {
				return { ...user, status: USER_CONNECTION_STATUS.ONLINE }
			}
			return user
		})
		const roomId = getRoomId(socketId)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.USER_ONLINE, { socketId })
	})

	// Handle chat actions
	socket.on(SocketEvent.SEND_MESSAGE, ({ message }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.RECEIVE_MESSAGE, { message })
	})

	// Handle cursor position
	socket.on(SocketEvent.TYPING_START, ({ cursorPosition }) => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socket.id) {
				return { ...user, typing: true, cursorPosition }
			}
			return user
		})
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast.to(roomId).emit(SocketEvent.TYPING_START, { user })
	})

	socket.on(SocketEvent.TYPING_PAUSE, () => {
		userSocketMap = userSocketMap.map((user) => {
			if (user.socketId === socket.id) {
				return { ...user, typing: false }
			}
			return user
		})
		const user = getUserBySocketId(socket.id)
		if (!user) return
		const roomId = user.roomId
		socket.broadcast.to(roomId).emit(SocketEvent.TYPING_PAUSE, { user })
	})

	socket.on(SocketEvent.REQUEST_DRAWING, () => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast
			.to(roomId)
			.emit(SocketEvent.REQUEST_DRAWING, { socketId: socket.id })
	})

	socket.on(SocketEvent.SYNC_DRAWING, ({ drawingData, socketId }) => {
		socket.broadcast
			.to(socketId)
			.emit(SocketEvent.SYNC_DRAWING, { drawingData })
	})

	socket.on(SocketEvent.DRAWING_UPDATE, ({ snapshot }) => {
		const roomId = getRoomId(socket.id)
		if (!roomId) return
		socket.broadcast.to(roomId).emit(SocketEvent.DRAWING_UPDATE, {
			snapshot,
		})
	})
})

const PORT = process.env.PORT || 3000

app.get("/", (req: Request, res: Response) => {
	// Send the index.html file
	res.sendFile(path.join(__dirname, "..", "public", "index.html"))
})

server.listen(PORT, () => {
	console.log(`Listening on port ${PORT}`)
})
