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

// OpenAI API 호출 함수
async function callOpenAI(endpoint, data, apiKey) {
  const response = await fetch(`https://api.openai.com/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
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
        const data = await request.json();
        const { message, sessionState } = data;

        if (!message) {
          return new Response(JSON.stringify({ error: "메시지가 필요합니다." }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const session = new TutorSession();
        Object.assign(session, sessionState);

        // 퀴즈 모드 처리
        if (session.quizMode && session.waitingForPronunciation) {
          const response = handleQuizResponse(session, message);
          return new Response(JSON.stringify({ 
            response, 
            sessionState: session 
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        // 일반 대화 처리
        session.conversationHistory.push({ role: 'user', content: message });

        if (session.conversationHistory.length > 20) {
          session.conversationHistory = session.conversationHistory.slice(-16);
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

        return new Response(JSON.stringify({ 
          response: aiResponse, 
          sessionState: session 
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 복습 시작 API
      if (path === '/api/start_review' && request.method === 'POST') {
        const data = await request.json();
        const { words, sessionState } = data;

        const session = new TutorSession();
        Object.assign(session, sessionState);

        session.todayVocabulary = words.filter(word => word.trim());
        session.quizMode = true;
        session.currentQuizIndex = 0;
        session.waitingForPronunciation = false;

        const vocabList = session.todayVocabulary.join(', ');
        const responseText = `📚 복습을 시작해볼까요!

오늘 배운 단어들: ${vocabList}

총 ${session.todayVocabulary.length}개의 단어를 복습할 거예요! 🌟
첫 번째 문제 나갑니다! 💪`;

        return new Response(JSON.stringify({ 
          response: responseText, 
          sessionState: session 
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 다음 문제 API
      if (path === '/api/next_question' && request.method === 'POST') {
        const data = await request.json();
        const { sessionState } = data;

        const session = new TutorSession();
        Object.assign(session, sessionState);

        if (session.currentQuizIndex >= session.todayVocabulary.length) {
          session.quizMode = false;
          session.waitingForPronunciation = false;
          
          const completionMessage = `🎉 와! 모든 복습을 완료했어요!

총 ${session.todayVocabulary.length}개의 단어를 모두 연습했어요! 
정말 대단해요! 👏✨

매일 이렇게 복습하면 영어 실력이 쑥쑥 늘어날 거예요! 💪

🌟 이제 자유롭게 영어로 대화해볼까요?
🌟 궁금한 것이 있으면 언제든 물어보세요!`;

          return new Response(JSON.stringify({
            response: completionMessage,
            sessionState: session,
            celebration: true
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const currentWord = session.todayVocabulary[session.currentQuizIndex];
        const questionText = `🎯 문제 ${session.currentQuizIndex + 1}번

'${currentWord}'를 영어로 발음해보세요!

먼저 Emma 선생님의 발음을 들어보세요 👂`;

        session.waitingForPronunciation = true;

        return new Response(JSON.stringify({
          question: questionText,
          targetWord: currentWord,
          sessionState: session,
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // TTS API
      if (path === '/api/speak' && request.method === 'POST') {
        const data = await request.json();
        const { text } = data;

        if (!text) {
          return new Response(JSON.stringify({ error: "텍스트가 필요합니다." }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const speech = await callOpenAI('audio/speech', {
          model: 'tts-1',
          voice: 'nova',
          input: text,
          response_format: 'mp3',
        }, env.OPENAI_API_KEY);

        // 오디오를 직접 스트리밍
        return new Response(speech.body, {
          headers: {
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'public, max-age=300',
            ...corsHeaders,
          },
        });
      }

      // STT API
      if (path === '/api/stt' && request.method === 'POST') {
        const formData = await request.formData();
        const audioFile = formData.get('audio');

        if (!audioFile) {
          return new Response(JSON.stringify({ error: "오디오 파일이 필요합니다." }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
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

        const result = await response.json();

        return new Response(JSON.stringify({ text: result.text || '' }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // 헬스 체크
      if (path === '/api/health') {
        return new Response(JSON.stringify({ 
          status: 'healthy',
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      return new Response(JSON.stringify({ error: "엔드포인트를 찾을 수 없습니다." }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ 
        error: "서버 오류가 발생했습니다.",
        details: error.message 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};