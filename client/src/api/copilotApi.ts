import axios, { AxiosInstance } from "axios"

const backendUrl = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000"
const copilotBaseUrl = `${backendUrl}/api/v1/copilot`

const instance: AxiosInstance = axios.create({
    baseURL: copilotBaseUrl,
    headers: {
        "Content-Type": "application/json",
    },
})

export default instance
