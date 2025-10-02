"use strict";

// 🚨 중요: 여기에 실제 Worker URL을 입력해야 합니다!
// 배포 후 https://your-worker-name.your-subdomain.workers.dev 형태가 됩니다
const WORKER_URL = "https://emma-tutor-api.hyunqwer.workers.dev";

const API_ROUTES = Object.freeze({
    CHAT: "/api/chat",
    START_REVIEW: "/api/start_review",
    NEXT_QUESTION: "/api/next_question",
    SPEAK: "/api/speak",
    STT: "/api/stt",
});

const MessageSender = Object.freeze({
    EMMA: "Emma 선생님",
    STUDENT: "학생",
    SYSTEM: "시스템",
});

class TutorSessionState {
    constructor(initialState = {}) {
        const defaults = {
            conversationHistory: [],
            todayVocabulary: [],
            currentQuizIndex: 0,
            quizMode: false,
            waitingForPronunciation: false,
        };

        this.update({ ...defaults, ...initialState });
    }

    update(nextState = {}) {
        this.conversationHistory = Array.isArray(nextState.conversationHistory)
            ? [...nextState.conversationHistory]
            : [];
        this.todayVocabulary = Array.isArray(nextState.todayVocabulary)
            ? [...nextState.todayVocabulary]
            : [];
        this.currentQuizIndex = Number.isInteger(nextState.currentQuizIndex)
            ? nextState.currentQuizIndex
            : 0;
        this.quizMode = Boolean(nextState.quizMode);
        this.waitingForPronunciation = Boolean(nextState.waitingForPronunciation);
    }

    setVocabulary(words) {
        this.todayVocabulary = [...words];
        this.currentQuizIndex = 0;
        this.quizMode = words.length > 0;
        this.waitingForPronunciation = false;
    }

    toJSON() {
        return {
            conversationHistory: [...this.conversationHistory],
            todayVocabulary: [...this.todayVocabulary],
            currentQuizIndex: this.currentQuizIndex,
            quizMode: this.quizMode,
            waitingForPronunciation: this.waitingForPronunciation,
        };
    }
}

class ApiClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl.replace(/\/?$/, "");
    }

    async postJson(route, payload) {
        const response = await fetch(`${this.baseUrl}${route}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload ?? {}),
        });

        return this.handleResponse(response);
    }

    async postForm(route, formData) {
        const response = await fetch(`${this.baseUrl}${route}`, {
            method: "POST",
            body: formData,
        });

        return this.handleResponse(response);
    }

    async postForBlob(route, payload) {
        const response = await fetch(`${this.baseUrl}${route}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload ?? {}),
        });

        if (!response.ok) {
            const errorPayload = await this.safeParseJson(response);
            const errorMessage = errorPayload?.error
                ? `API 오류: ${errorPayload.error}`
                : `API 요청 실패 (${response.status})`;
            throw new Error(errorMessage);
        }

        return response.blob();
    }

    async handleResponse(response) {
        const payload = await this.safeParseJson(response);
        if (!response.ok) {
            const message = payload?.error
                ? `API 오류: ${payload.error}`
                : `API 요청 실패 (${response.status})`;
            throw new Error(message);
        }
        return payload;
    }

    async safeParseJson(response) {
        try {
            return await response.clone().json();
        } catch (error) {
            console.warn("JSON 파싱 실패", error);
            return null;
        }
    }
}

class CloudflareEnglishTutor {
    constructor() {
        this.sessionId = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        this.isRecording = false;
        this.recognition = null;
        this.mediaRecorder = null;
        this.currentAudio = null;
        this.audioContext = null;
        this.canAutoPlay = false;
        this.recordingChunks = [];

        this.sessionState = new TutorSessionState();
        this.apiClient = new ApiClient(WORKER_URL);

        this.initializeElements();
        this.bindEvents();
        this.addInitialMessage();
    }
    
    initializeElements() {
        const getElement = (id) => {
            const element = document.getElementById(id);
            if (!element) {
                throw new Error(`${id} 요소를 찾을 수 없습니다.`);
            }
            return element;
        };

        this.chatDisplay = getElement("chatDisplay");
        this.vocabInput = getElement("vocabInput");
        this.startReviewBtn = getElement("startReviewBtn");
        this.voiceBtn = getElement("voiceBtn");
        this.recordBtn = getElement("recordBtn");
        this.freeChatBtn = getElement("freeChatBtn");
        this.nextQuestionBtn = getElement("nextQuestionBtn");
        this.textInput = getElement("textInput");
        this.sendBtn = getElement("sendBtn");
        this.loadingIndicator = getElement("loadingIndicator");
        this.enableSoundBtn = getElement("enableSoundBtn");
    }

    bindEvents() {
        this.enableSoundBtn.addEventListener("click", () => this.enableSound());
        this.startReviewBtn.addEventListener("click", () => this.startReview());
        this.voiceBtn.addEventListener("click", () => this.startVoiceInput());
        this.recordBtn.addEventListener("click", () => this.toggleRecording());
        this.freeChatBtn.addEventListener("click", () => this.startFreeChat());
        this.nextQuestionBtn.addEventListener("click", () => this.getNextQuestion());
        this.sendBtn.addEventListener("click", () => this.sendTextMessage());
        this.textInput.addEventListener("keypress", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                this.sendTextMessage();
            }
        });
    }

    async enableSound() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContext();

            if (this.audioContext.state === "suspended") {
                await this.audioContext.resume();
            }

            // 무음 재생으로 오디오 정책 우회
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            gainNode.gain.value = 0.001;
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            oscillator.start();
            setTimeout(() => oscillator.stop(), 100);

            this.canAutoPlay = true;
            this.enableSoundBtn.style.display = "none";

            await this.initializeMicrophone();

            this.addMessage(MessageSender.SYSTEM, "🔊 소리가 활성화됐어요! Emma의 목소리를 들을 수 있어요! 🎵");
            this.speakText("Hello! Welcome to our English learning adventure! 영어 모험을 시작해봐요!");

        } catch (error) {
            console.error("Sound enable error:", error);
            this.addMessage(MessageSender.SYSTEM, "소리 활성화에 실패했어요. 브라우저 설정을 확인해주세요.");
        }
    }

    async initializeMicrophone() {
        try {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

            if (!SpeechRecognition) {
                this.switchToRecordingMode();
                return;
            }

            this.recognition = new SpeechRecognition();
            this.recognition.continuous = false;
            this.recognition.interimResults = false;
            this.recognition.lang = "en-US";

            this.recognition.onstart = () => {
                this.voiceBtn.textContent = "🛑 중지";
                this.voiceBtn.classList.add("recording");
                this.showStatus("🎤 말씀하세요...", "listening");
            };

            this.recognition.onresult = (event) => {
                const transcript = event.results[0][0].transcript;
                this.addMessage(MessageSender.STUDENT, transcript, true);
                this.processMessage(transcript);
                this.hideStatus();
            };

            this.recognition.onerror = () => {
                this.addMessage(MessageSender.SYSTEM, "음성 인식 오류. 녹음 방식으로 전환합니다.");
                this.switchToRecordingMode();
                this.hideStatus();
            };

            this.recognition.onend = () => {
                this.voiceBtn.textContent = "🎤 말하기";
                this.voiceBtn.classList.remove("recording");
                this.isRecording = false;
                this.hideStatus();
            };

        } catch (error) {
            console.error("Microphone initialization error:", error);
            this.switchToRecordingMode();
        }
    }

    switchToRecordingMode() {
        this.voiceBtn.style.display = "none";
        this.recordBtn.style.display = "block";
    }

    startVoiceInput() {
        if (!this.recognition) {
            this.addMessage(MessageSender.SYSTEM, '먼저 "🔊 소리 켜기" 버튼을 눌러주세요!');
            return;
        }

        if (this.isRecording) {
            this.recognition.stop();
        } else {
            this.isRecording = true;
            this.recognition.start();
        }
    }
    
    async toggleRecording() {
        if (this.isRecording) {
            this.mediaRecorder.stop();
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            let mimeType = "audio/webm";
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = "audio/mp4";
            }

            this.mediaRecorder = new MediaRecorder(stream, { mimeType });
            this.recordingChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.recordingChunks.push(event.data);
                }
            };

            this.mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(this.recordingChunks, { type: mimeType });
                await this.transcribeAudio(audioBlob);

                stream.getTracks().forEach(track => track.stop());
                this.recordBtn.textContent = "🎙️ 녹음하기";
                this.recordBtn.classList.remove("recording");
                this.isRecording = false;
                this.hideStatus();
            };

            this.mediaRecorder.start();
            this.isRecording = true;
            this.recordBtn.textContent = "🛑 중지";
            this.recordBtn.classList.add("recording");
            this.showStatus("🎙️ 녹음 중... 말씀하세요!", "recording");

        } catch (error) {
            console.error("Recording error:", error);
            this.addMessage(MessageSender.SYSTEM, "마이크 권한을 허용해주세요!");
        }
    }

    async transcribeAudio(audioBlob) {
        try {
            this.showLoading();

            const formData = new FormData();
            formData.append("audio", audioBlob, "recording.webm");

            const data = await this.apiClient.postForm(API_ROUTES.STT, formData);

            if (data?.text) {
                this.addMessage(MessageSender.STUDENT, data.text, true);
                this.processMessage(data.text);
            } else {
                this.addMessage(MessageSender.SYSTEM, "음성을 인식하지 못했어요. 다시 시도해주세요!");
            }

        } catch (error) {
            console.error("Transcription error:", error);
            this.addMessage(MessageSender.SYSTEM, "음성 변환 중 오류가 발생했어요.");
        } finally {
            this.hideLoading();
        }
    }

    showStatus(message, type) {
        this.hideStatus();
        const statusDiv = document.createElement('div');
        statusDiv.className = `status-indicator ${type}`;
        statusDiv.textContent = message;
        statusDiv.id = 'statusIndicator';
        document.body.appendChild(statusDiv);
    }

    hideStatus() {
        const statusDiv = document.getElementById('statusIndicator');
        if (statusDiv) statusDiv.remove();
    }

    addMessage(sender, message, isStudent = false) {
        if (!message) return;

        const messageDiv = document.createElement('div');
        const roleClass = sender === MessageSender.EMMA
            ? 'emma'
            : isStudent || sender === MessageSender.STUDENT
                ? 'student'
                : 'system';
        messageDiv.className = `message ${roleClass}`;

        const fragment = document.createDocumentFragment();
        const lines = String(message).split(/\r?\n/);
        lines.forEach((line, index) => {
            fragment.appendChild(document.createTextNode(line));
            if (index < lines.length - 1) {
                fragment.appendChild(document.createElement('br'));
            }
        });

        messageDiv.appendChild(fragment);
        this.chatDisplay.appendChild(messageDiv);

        requestAnimationFrame(() => {
            this.chatDisplay.scrollTop = this.chatDisplay.scrollHeight;
        });
    }

    addInitialMessage() {
        const message = `안녕하세요! 전 세계 어디서나 만날 수 있는 Emma 선생님이에요! 😊🌍

🌟 Cloudflare로 구동되는 AI 튜터:
• 빠르고 안전한 HTTPS 환경
• 전 세계 어디서나 접속 가능  
• 모바일/PC 완벽 지원

📱 사용법:
1. "🔊 소리 켜기" 버튼 클릭
2. 오늘 배운 단어 입력
3. Emma와 함께 영어 모험 시작!

준비되셨나요? Let's learn English together! 💕`;

        this.addMessage(MessageSender.EMMA, message);
    }

    async speakText(text) {
        if (!this.canAutoPlay || !text) return;

        try {
            const audioBlob = await this.apiClient.postForBlob(API_ROUTES.SPEAK, { text });
            const audioUrl = URL.createObjectURL(audioBlob);

            this.currentAudio = new Audio(audioUrl);
            this.currentAudio.playsInline = true;

            await this.currentAudio.play();
            this.currentAudio.onended = () => {
                URL.revokeObjectURL(audioUrl);
                this.currentAudio = null;
            };
            return;
        } catch (error) {
            console.log("TTS 요청 실패, 브라우저 TTS로 전환:", error);
            if (error instanceof Error) {
                this.addMessage(MessageSender.SYSTEM, `${error.message} — 브라우저 음성으로 전환할게요.`);
            }
        }

        this.fallbackTTS(text);
    }

    fallbackTTS(text) {
        if (!("speechSynthesis" in window)) return;

        speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.lang = "en-US";
        utterance.volume = 0.85;

        const assignVoice = () => {
            const voices = speechSynthesis.getVoices();
            const preferredVoices = [
                "Google US English",
                "Microsoft Zira - English (United States)",
                "Alex",
            ];

            let selectedVoice = null;
            for (const preferred of preferredVoices) {
                selectedVoice = voices.find((voice) => voice.name.includes(preferred));
                if (selectedVoice) break;
            }

            if (!selectedVoice) {
                selectedVoice = voices.find((voice) => voice.lang.startsWith("en"));
            }

            if (selectedVoice) {
                utterance.voice = selectedVoice;
            }
        };

        if (speechSynthesis.getVoices().length === 0) {
            window.speechSynthesis.onvoiceschanged = () => {
                assignVoice();
                window.speechSynthesis.onvoiceschanged = null;
                speechSynthesis.speak(utterance);
            };
        } else {
            assignVoice();
        }

        speechSynthesis.speak(utterance);
        console.log("브라우저 TTS 재생:", text.substring(0, 30) + "...");
    }

    showLoading() { this.loadingIndicator.style.display = 'flex'; }
    hideLoading() { this.loadingIndicator.style.display = 'none'; }

    sendTextMessage() {
        const message = this.textInput.value.trim();
        if (!message) return;

        this.addMessage(MessageSender.STUDENT, message, true);
        this.textInput.value = '';
        this.processMessage(message);
    }

    async processMessage(message) {
        try {
            this.showLoading();

            const data = await this.apiClient.postJson(API_ROUTES.CHAT, {
                message,
                sessionState: this.sessionState.toJSON(),
            });

            if (data?.error) {
                this.addMessage(MessageSender.SYSTEM, `오류: ${data.error}`);
                return;
            }

            this.addMessage(MessageSender.EMMA, data.response);
            this.speakText(data.response);

            this.sessionState.update(data.sessionState);

            if (this.sessionState.quizMode && !this.sessionState.waitingForPronunciation) {
                setTimeout(() => this.getNextQuestion(), 2000);
            }

        } catch (error) {
            this.addMessage(MessageSender.SYSTEM, '네트워크 오류가 발생했어요.');
            console.error('Process message error:', error);
        } finally {
            this.hideLoading();
        }
    }

    async startReview() {
        const vocabText = this.vocabInput.value.trim() || "apple, happy, school, friend, book";
        const words = vocabText.split(',').map(word => word.trim()).filter(word => word);

        try {
            this.showLoading();

            const data = await this.apiClient.postJson(API_ROUTES.START_REVIEW, {
                words,
                sessionState: this.sessionState.toJSON(),
            });

            this.addMessage(MessageSender.EMMA, data.response);
            this.speakText("Let's start today's review! 오늘의 복습을 시작해봐요!");

            this.startReviewBtn.disabled = true;
            this.startReviewBtn.textContent = '복습 중...';
            this.nextQuestionBtn.style.display = 'block';

            this.sessionState.update(data.sessionState);

            setTimeout(() => this.getNextQuestion(), 3000);

        } catch (error) {
            this.addMessage(MessageSender.SYSTEM, '복습 시작 중 오류가 발생했습니다.');
            console.error('Start review error:', error);
        } finally {
            this.hideLoading();
        }
    }

    async getNextQuestion() {
        try {
            this.showLoading();

            const data = await this.apiClient.postJson(API_ROUTES.NEXT_QUESTION, {
                sessionState: this.sessionState.toJSON(),
            });

            if (data.question) {
                this.addMessage(MessageSender.EMMA, data.question);

                if (data.targetWord) {
                    this.speakText(data.targetWord);

                    setTimeout(() => {
                        const followUp = `이제 '${data.targetWord}'라고 말해보세요! 🎤\n\n마이크나 키보드 둘 다 사용 가능해요! 😊`;
                        this.addMessage(MessageSender.EMMA, followUp);
                    }, 3000);
                }
            }

            if (data.celebration) {
                this.startReviewBtn.disabled = false;
                this.startReviewBtn.textContent = '🚀 복습 시작하기!';
                this.nextQuestionBtn.style.display = 'none';
                this.speakText("Congratulations! You did an amazing job today! 정말 잘했어요!");
            }

            this.sessionState.update(data.sessionState);

        } catch (error) {
            this.addMessage(MessageSender.SYSTEM, '다음 문제 로딩 중 오류가 발생했습니다.');
            console.error('Next question error:', error);
        } finally {
            this.hideLoading();
        }
    }

    startFreeChat() {
        const message = `💬 자유 대화 모드예요!

🌍 전 세계 어디서나 Emma와 대화해보세요!
🎤 마이크나 ✏️ 키보드 둘 다 OK!

영어든 한국어든 편하게 말해보세요! 💕`;

        this.addMessage(MessageSender.EMMA, message);
        this.speakText("Let's have a wonderful conversation together!");
    }
}

// 앱 초기화
document.addEventListener('DOMContentLoaded', () => {
    new CloudflareEnglishTutor();
});