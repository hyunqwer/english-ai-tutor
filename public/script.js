// 🚨 중요: 여기에 실제 Worker URL을 입력해야 합니다!
// 배포 후 https://your-worker-name.your-subdomain.workers.dev 형태가 됩니다
const WORKER_URL = 'https://emma-tutor-api.hyunqwer.workers.dev';

class CloudflareEnglishTutor {
    constructor() {
        this.sessionId = 'cf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        this.isRecording = false;
        this.recognition = null;
        this.mediaRecorder = null;
        this.currentAudio = null;
        this.audioContext = null;
        this.canAutoPlay = false;
        this.recordingChunks = [];

        // 세션 상태를 클라이언트에서 관리
        this.sessionState = {
            conversationHistory: [],
            todayVocabulary: [],
            currentQuizIndex: 0,
            quizMode: false,
            waitingForPronunciation: false,
        };
        
        this.initializeElements();
        this.bindEvents();
        this.addInitialMessage();
    }
    
    initializeElements() {
        this.chatDisplay = document.getElementById('chatDisplay');
        this.vocabInput = document.getElementById('vocabInput');
        this.startReviewBtn = document.getElementById('startReviewBtn');
        this.voiceBtn = document.getElementById('voiceBtn');
        this.recordBtn = document.getElementById('recordBtn');
        this.freeChatBtn = document.getElementById('freeChatBtn');
        this.nextQuestionBtn = document.getElementById('nextQuestionBtn');
        this.textInput = document.getElementById('textInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.loadingIndicator = document.getElementById('loadingIndicator');
        this.enableSoundBtn = document.getElementById('enableSoundBtn');
    }
    
    bindEvents() {
        this.enableSoundBtn.addEventListener('click', () => this.enableSound());
        this.startReviewBtn.addEventListener('click', () => this.startReview());
        this.voiceBtn.addEventListener('click', () => this.startVoiceInput());
        this.recordBtn.addEventListener('click', () => this.toggleRecording());
        this.freeChatBtn.addEventListener('click', () => this.startFreeChat());
        this.nextQuestionBtn.addEventListener('click', () => this.getNextQuestion());
        this.sendBtn.addEventListener('click', () => this.sendTextMessage());
        this.textInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendTextMessage();
        });
    }
    
    async enableSound() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContext();
            
            if (this.audioContext.state === 'suspended') {
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
            this.enableSoundBtn.style.display = 'none';
            
            await this.initializeMicrophone();
            
            this.addMessage('시스템', '🔊 소리가 활성화됐어요! Emma의 목소리를 들을 수 있어요! 🎵');
            this.speakText('Hello! Welcome to our English learning adventure! 영어 모험을 시작해봐요!');
            
        } catch (error) {
            console.error('Sound enable error:', error);
            this.addMessage('시스템', '소리 활성화에 실패했어요. 브라우저 설정을 확인해주세요.');
        }
    }
    
    async initializeMicrophone() {
        try {
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            
            if (SpeechRecognition) {
                this.recognition = new SpeechRecognition();
                this.recognition.continuous = false;
                this.recognition.interimResults = false;
                this.recognition.lang = 'en-US';
                
                this.recognition.onstart = () => {
                    this.voiceBtn.textContent = '🛑 중지';
                    this.voiceBtn.classList.add('recording');
                    this.showStatus('🎤 말씀하세요...', 'listening');
                };
                
                this.recognition.onresult = (event) => {
                    const transcript = event.results[0][0].transcript;
                    this.addMessage('학생', transcript, true);
                    this.processMessage(transcript);
                    this.hideStatus();
                };
                
                this.recognition.onerror = () => {
                    this.addMessage('시스템', '음성 인식 오류. 녹음 방식으로 전환합니다.');
                    this.switchToRecordingMode();
                    this.hideStatus();
                };
                
                this.recognition.onend = () => {
                    this.voiceBtn.textContent = '🎤 말하기';
                    this.voiceBtn.classList.remove('recording');
                    this.isRecording = false;
                    this.hideStatus();
                };
                
            } else {
                this.switchToRecordingMode();
            }
            
        } catch (error) {
            console.error('Microphone initialization error:', error);
            this.switchToRecordingMode();
        }
    }
    
    switchToRecordingMode() {
        this.voiceBtn.style.display = 'none';
        this.recordBtn.style.display = 'block';
    }
    
    startVoiceInput() {
        if (!this.recognition) {
            this.addMessage('시스템', '먼저 "🔊 소리 켜기" 버튼을 눌러주세요!');
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
            
            let mimeType = 'audio/webm';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'audio/mp4';
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
                this.recordBtn.textContent = '🎙️ 녹음하기';
                this.recordBtn.classList.remove('recording');
                this.isRecording = false;
                this.hideStatus();
            };
            
            this.mediaRecorder.start();
            this.isRecording = true;
            this.recordBtn.textContent = '🛑 중지';
            this.recordBtn.classList.add('recording');
            this.showStatus('🎙️ 녹음 중... 말씀하세요!', 'recording');
            
        } catch (error) {
            console.error('Recording error:', error);
            this.addMessage('시스템', '마이크 권한을 허용해주세요!');
        }
    }
    
    async transcribeAudio(audioBlob) {
        try {
            this.showLoading();
            
            const formData = new FormData();
            formData.append('audio', audioBlob, 'recording.webm');
            
            const response = await fetch(`${WORKER_URL}/api/stt`, {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (data.text) {
                this.addMessage('학생', data.text, true);
                this.processMessage(data.text);
            } else {
                this.addMessage('시스템', '음성을 인식하지 못했어요. 다시 시도해주세요!');
            }
            
        } catch (error) {
            console.error('Transcription error:', error);
            this.addMessage('시스템', '음성 변환 중 오류가 발생했어요.');
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
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender === 'Emma 선생님' ? 'emma' : isStudent ? 'student' : 'system'}`;
        messageDiv.innerHTML = message.replace(/\n/g, '<br>');
        
        this.chatDisplay.appendChild(messageDiv);
        this.chatDisplay.scrollTop = this.chatDisplay.scrollHeight;
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
        
        this.addMessage('Emma 선생님', message);
    }
    
    async speakText(text) {
        if (!this.canAutoPlay) return;
        
        try {
            if (this.currentAudio) {
                this.currentAudio.pause();
                this.currentAudio = null;
            }
            
            const response = await fetch(`${WORKER_URL}/api/speak`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text })
            });
            
            if (response.ok) {
                const audioBlob = await response.blob();
                const audioUrl = URL.createObjectURL(audioBlob);
                
                this.currentAudio = new Audio(audioUrl);
                this.currentAudio.playsInline = true;
                
                await this.currentAudio.play();
                this.currentAudio.onended = () => {
                    URL.revokeObjectURL(audioUrl);
                    this.currentAudio = null;
                };
            }
            
        } catch (error) {
            console.log('TTS failed, using fallback:', error);
            this.fallbackTTS(text);
        }
    }
    
    fallbackTTS(text) {
        if ('speechSynthesis' in window) {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 0.8;
            utterance.lang = 'en-US';
            speechSynthesis.speak(utterance);
        }
    }
    
    showLoading() { this.loadingIndicator.style.display = 'flex'; }
    hideLoading() { this.loadingIndicator.style.display = 'none'; }
    
    sendTextMessage() {
        const message = this.textInput.value.trim();
        if (!message) return;
        
        this.addMessage('학생', message, true);
        this.textInput.value = '';
        this.processMessage(message);
    }
    
    async processMessage(message) {
        try {
            this.showLoading();
            
            const response = await fetch(`${WORKER_URL}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: message,
                    sessionState: this.sessionState
                })
            });
            
            const data = await response.json();
            
            if (data.error) {
                this.addMessage('시스템', `오류: ${data.error}`);
            } else {
                this.addMessage('Emma 선생님', data.response);
                this.speakText(data.response);
                
                this.sessionState = data.sessionState;
                
                if (this.sessionState.quizMode && !this.sessionState.waitingForPronunciation) {
                    setTimeout(() => this.getNextQuestion(), 2000);
                }
            }
            
        } catch (error) {
            this.addMessage('시스템', '네트워크 오류가 발생했어요.');
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
            
            const response = await fetch(`${WORKER_URL}/api/start_review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    words: words,
                    sessionState: this.sessionState
                })
            });
            
            const data = await response.json();
            
            this.addMessage('Emma 선생님', data.response);
            this.speakText("Let's start today's review! 오늘의 복습을 시작해봐요!");
            
            this.startReviewBtn.disabled = true;
            this.startReviewBtn.textContent = '복습 중...';
            this.nextQuestionBtn.style.display = 'block';

            this.sessionState = data.sessionState;
            
            setTimeout(() => this.getNextQuestion(), 3000);
            
        } catch (error) {
            this.addMessage('시스템', '복습 시작 중 오류가 발생했습니다.');
            console.error('Start review error:', error);
        } finally {
            this.hideLoading();
        }
    }
    
    async getNextQuestion() {
        try {
            this.showLoading();
            
            const response = await fetch(`${WORKER_URL}/api/next_question`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionState: this.sessionState })
            });
            
            const data = await response.json();
            
            if (data.question) {
                this.addMessage('Emma 선생님', data.question);
                
                if (data.targetWord) {
                    this.speakText(data.targetWord);
                    
                    setTimeout(() => {
                        const followUp = `이제 '${data.targetWord}'라고 말해보세요! 🎤\n\n마이크나 키보드 둘 다 사용 가능해요! 😊`;
                        this.addMessage('Emma 선생님', followUp);
                    }, 3000);
                }
            }
            
            if (data.celebration) {
                this.startReviewBtn.disabled = false;
                this.startReviewBtn.textContent = '🚀 복습 시작하기!';
                this.nextQuestionBtn.style.display = 'none';
                this.speakText("Congratulations! You did an amazing job today! 정말 잘했어요!");
            }

            this.sessionState = data.sessionState;
            
        } catch (error) {
            this.addMessage('시스템', '다음 문제 로딩 중 오류가 발생했습니다.');
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
        
        this.addMessage('Emma 선생님', message);
        this.speakText("Let's have a wonderful conversation together!");
    }
}

// 앱 초기화
document.addEventListener('DOMContentLoaded', () => {
    new CloudflareEnglishTutor();
});