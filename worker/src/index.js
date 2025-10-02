// Cloudflare Workers에서 실행되는 영어 AI 튜터 백엔드

// 세션 상태 클래스 (클라이언트에서 관리)
class TutorSession {
  constructor() {
    this.conversationHistory = [];
    this.todayVocabulary = [];
    this.currentQuizIndex = 0;
    this.quizMode = false;
    this.waitingForPronunciation = false;
    this.systemPrompt = `당신은 초등학생을 위한 친절하고 격려적인 영어 AI 튜터 Emma입니다.

특성:
- 항상 긍정적이고 격려하는 톤으로 대화합니다
- 학생이 틀려도 화내지 않고 다시 시도하도록 격려합니다  
- 영어와 한국어를 자유롭게 사용합니다
- 초등학생 수준에 맞는 쉬운 영어를 사용합니다
- 이모지를 적절히 활용합니다 (😊, 👏, 🌟 등)

주요 역할:
1. 오늘 배운 단어와 문장 복습 도우미
2. 발음 연습 지도 및 피드백 제공
3. 영어 자유 대화 상대
4. 영어 학습 질문 답변

대화 스타일: 존댓말 사용, 따뜻하고 친근한 톤 유지`;
  }
}

// CORS 헤더 설정
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const MAX_HISTORY_LENGTH = 20;

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
    ...init,
  });
}

async function parseJsonRequest(request) {
  try {
    return await request.json();
  } catch (error) {
    throw new Error('요청 본문을 JSON으로 파싱할 수 없습니다.');
  }
}

function createSessionFromState(state = {}) {
  const session = new TutorSession();
  Object.assign(session, state);
  if (!Array.isArray(session.conversationHistory)) {
    session.conversationHistory = [];
  }
  if (!Array.isArray(session.todayVocabulary)) {
    session.todayVocabulary = [];
  }
  session.currentQuizIndex = Number.isInteger(session.currentQuizIndex)
    ? session.currentQuizIndex
    : 0;
  session.quizMode = Boolean(session.quizMode);
  session.waitingForPronunciation = Boolean(session.waitingForPronunciation);
  return session;
}

// OpenAI API 호출 함수
async function callOpenAI(endpoint, data, apiKey, init = {}) {
  const response = await fetch(`https://api.openai.com/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
    ...init,
  });

  if (!response.ok) {
    let details = '';
    try {
      const errorBody = await response.json();
      details = errorBody?.error?.message ? `: ${errorBody.error.message}` : '';
    } catch (_) {
      // ignore parse errors
    }
    throw new Error(`OpenAI API error ${response.status}${details}`);
  }

  return response;
}

// 퀴즈 응답 처리 함수
function handleQuizResponse(session, response) {
  if (!session.waitingForPronunciation) {
    return "지금은 발음 연습 시간이 아니에요! 😊";
  }

  const currentWord = session.todayVocabulary[session.currentQuizIndex];
  const target = currentWord.toLowerCase();
  const studentAnswer = response.toLowerCase().trim();

  // 간단한 유사도 계산
  const similarity = calculateSimilarity(target, studentAnswer);

  if (similarity >= 0.7 || target.includes(studentAnswer) || studentAnswer.includes(target)) {
    const feedbackMessages = [
      `훌륭해요! 👏 '${currentWord}' 발음이 정말 좋아요!`,
      `완벽해요! 🌟 '${currentWord}'를 아주 잘 말했어요!`,
      `대단해요! 💪 '${currentWord}' 발음이 원어민 같아요!`
    ];
    const feedback = feedbackMessages[Math.floor(Math.random() * feedbackMessages.length)];

    session.currentQuizIndex++;
    session.waitingForPronunciation = false;

    return feedback;
  } else {
    const encouragementMessages = [
      `아쉬워요! 다시 한번 '${currentWord}'라고 말해볼까요? 😊`,
      `거의 다 왔어요! '${currentWord}'를 다시 천천히 말해보세요! 💪`,
      `괜찮아요! 한 번 더 '${currentWord}'라고 해볼까요? 🌟`
    ];
    return encouragementMessages[Math.floor(Math.random() * encouragementMessages.length)];
  }
}

// 간단한 유사도 계산
function calculateSimilarity(a, b) {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1).fill().map(() => Array(a.length + 1).fill(0));
  
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + substitutionCost
      );
    }
  }
  
  return matrix[b.length][a.length];
}

// 메인 요청 핸들러
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 프리플라이트 처리
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        status: 204, 
        headers: corsHeaders 
      });
    }

    try {
      // 채팅 API
      if (path === '/api/chat' && request.method === 'POST') {
        const data = await parseJsonRequest(request);
        const { message, sessionState } = data;

        if (!message) {
          return jsonResponse({ error: "메시지가 필요합니다." }, { status: 400 });
        }

        const session = createSessionFromState(sessionState);

        // 퀴즈 모드 처리
        if (session.quizMode && session.waitingForPronunciation) {
          const response = handleQuizResponse(session, message);
          return jsonResponse({
            response,
            sessionState: session,
          });
        }

        // 일반 대화 처리
        session.conversationHistory.push({ role: 'user', content: message });

        if (session.conversationHistory.length > MAX_HISTORY_LENGTH) {
          session.conversationHistory = session.conversationHistory.slice(-MAX_HISTORY_LENGTH);
        }

        const messages = [
          { role: 'system', content: session.systemPrompt },
          ...session.conversationHistory,
        ];

        const completion = await callOpenAI('chat/completions', {
          model: 'gpt-4o-mini',
          messages: messages,
          temperature: 0.7,
          max_tokens: 300,
        }, env.OPENAI_API_KEY);

        const result = await completion.json();
        const aiResponse = result.choices[0].message.content;
        session.conversationHistory.push({ role: 'assistant', content: aiResponse });

        return jsonResponse({
          response: aiResponse,
          sessionState: session,
        });
      }

      // 복습 시작 API
      if (path === '/api/start_review' && request.method === 'POST') {
        const data = await parseJsonRequest(request);
        const { words, sessionState } = data;

        const session = createSessionFromState(sessionState);

        session.todayVocabulary = Array.isArray(words)
          ? words.map((word) => String(word).trim()).filter(Boolean)
          : [];
        session.quizMode = true;
        session.currentQuizIndex = 0;
        session.waitingForPronunciation = false;

        const vocabList = session.todayVocabulary.join(', ');
        const responseText = `📚 복습을 시작해볼까요!

오늘 배운 단어들: ${vocabList}

총 ${session.todayVocabulary.length}개의 단어를 복습할 거예요! 🌟
첫 번째 문제 나갑니다! 💪`;

        return jsonResponse({
          response: responseText,
          sessionState: session,
        });
      }

      // 다음 문제 API
      if (path === '/api/next_question' && request.method === 'POST') {
        const data = await parseJsonRequest(request);
        const { sessionState } = data;

        const session = createSessionFromState(sessionState);

        if (session.currentQuizIndex >= session.todayVocabulary.length) {
          session.quizMode = false;
          session.waitingForPronunciation = false;

          const completionMessage = `🎉 와! 모든 복습을 완료했어요!

총 ${session.todayVocabulary.length}개의 단어를 모두 연습했어요! 
정말 대단해요! 👏✨

매일 이렇게 복습하면 영어 실력이 쑥쑥 늘어날 거예요! 💪

🌟 이제 자유롭게 영어로 대화해볼까요?
🌟 궁금한 것이 있으면 언제든 물어보세요!`;

          return jsonResponse({
            response: completionMessage,
            sessionState: session,
            celebration: true,
          });
        }

        const currentWord = session.todayVocabulary[session.currentQuizIndex];
        const questionText = `🎯 문제 ${session.currentQuizIndex + 1}번

'${currentWord}'를 영어로 발음해보세요!

먼저 Emma 선생님의 발음을 들어보세요 👂`;

        session.waitingForPronunciation = true;

        return jsonResponse({
          question: questionText,
          targetWord: currentWord,
          sessionState: session,
        });
      }

      // TTS API
      if (path === '/api/speak' && request.method === 'POST') {
        const data = await parseJsonRequest(request);
        const { text } = data;

        if (!text) {
          return jsonResponse({ error: "텍스트가 필요합니다." }, { status: 400 });
        }

        try {
          const speech = await callOpenAI('audio/speech', {
            model: 'tts-1',
            voice: 'nova',
            input: text,
            response_format: 'mp3',
          }, env.OPENAI_API_KEY);

          return new Response(speech.body, {
            headers: {
              'Content-Type': 'audio/mpeg',
              'Cache-Control': 'public, max-age=300',
              ...corsHeaders,
            },
          });
        } catch (error) {
          return jsonResponse({
            error: error instanceof Error ? error.message : 'TTS 생성 중 오류가 발생했습니다.',
            fallback: true,
          }, { status: 502 });
        }
      }

      // STT API
      if (path === '/api/stt' && request.method === 'POST') {
        const formData = await request.formData();
        const audioFile = formData.get('audio');

        if (!audioFile) {
          return jsonResponse({ error: "오디오 파일이 필요합니다." }, { status: 400 });
        }

        const transcriptionFormData = new FormData();
        transcriptionFormData.append('file', audioFile, 'audio.webm');
        transcriptionFormData.append('model', 'whisper-1');
        transcriptionFormData.append('language', 'en');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: transcriptionFormData,
        });

        if (!response.ok) {
          return jsonResponse({ error: '음성 인식에 실패했습니다.' }, { status: 502 });
        }

        const result = await response.json();

        return jsonResponse({ text: result.text || '' });
      }

      // 헬스 체크
      if (path === '/api/health') {
        return jsonResponse({
          status: 'healthy',
          timestamp: new Date().toISOString()
        });
      }

      return jsonResponse({ error: "엔드포인트를 찾을 수 없습니다." }, { status: 404 });

    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({
        error: '서버 오류가 발생했습니다.',
        details: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  },
};