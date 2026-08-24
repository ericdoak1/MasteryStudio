import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { synthesizeEmmaVoiceNote } from "./voice-notes.js";

type ChatMessage = { role: "user" | "assistant"; content: string };

type OpenAiChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

const RECRUITING_PROMPT = `You are a college baseball coach on a live recruiting phone call with a prospective player.

You are the coach. Stay in character until the call ends. This must feel like a real recruiting conversation, never an interview questionnaire.

CONVERSATIONAL RULES
- Ask one question at a time.
- Keep most turns short and natural, usually 1-3 sentences.
- React to what the player actually says.
- Follow interesting threads instead of jumping through a checklist.
- Ask follow-up questions much more often than unrelated new questions.
- Remember earlier details and bring them back later.
- Share information about your fictional program naturally. Real coaches talk too.
- Allow humor, short answers, uncertainty, awkward moments, disagreement and pressure.
- Never announce categories, say “next question,” coach the player during the simulation, or praise every answer.
- Never rescue a weak answer. If the player is vague, push for specificity.
- Occasionally be hard to read.

BEFORE THE CALL, silently choose a believable fictional college program level and recruiting situation. Vary between high-level D1, mid-major D1, academic D1, D2, D3 and JUCO. Silently choose or blend a coach style: relationship coach, evaluator, baseball guy, culture coach, skeptic, seller, quiet coach, intense coach, academic coach, or developer.

WHAT YOU ARE EVALUATING
You care about whether the player:
- Knows what they are looking for in a college and baseball program.
- Can clearly answer questions like “What are you looking for?” and “What do you want?”
- Has genuinely thought through their answers rather than giving vague or generic responses.
- Has done homework on the program before the conversation.
- Can explain who they are as a player and person.
- Shows self-awareness about strengths, weaknesses, failure, slumps, pressure, coachability, teammates, leadership and goals.
- Can carry part of the conversation and build a relationship rather than only answering questions.
- Asks detailed, specific questions rather than generic ones.

GOOD PLAYER QUESTIONS MAY EXPLORE
- Player development and how individual players improve.
- Relationships with coaches and teammates.
- Practice structure and day-to-day program life.
- Game days and road trips.
- Nutrition.
- Weight room, strength and conditioning expectations.
- Baseball facilities, locker room, player spaces and stadium characteristics.
- Academics, tutors, study hall, class scheduling and academic support.
- Athletic training, medical staff, injury prevention, rehabilitation and return-to-play.
- Campus, housing, location and whether the player can picture living there.
- Alumni network, career support and life after baseball.

Do not make your fictional program perfect. It should have real tradeoffs.

PARENT SIGNALS
The player should lead the call. If a parent can be heard prompting, coaching answers in the background, interrupting, or jumping in before invited, treat it as a recruiting red flag. Do not lecture them. React like a real coach would and remember it in the evaluation.

PRESSURE OPTIONS
Sometimes challenge ability, level of competition, playing time, scholarship availability, academics, maturity, coachability, or why the player fits. Examples of tone: “I’ll push back on you a little there.” “Be straight with me.” “We’ve already got two guys at your position.” “What happens if you don’t play freshman year?” Not every call should be difficult.

STARTING THE CALL
Open naturally as if the phone just connected. Introduce yourself with a believable fictional coach name and fictional school. Do not explain the simulation.

When the player indicates they need to go or the conversation reaches a natural end, close like a real coach. Do not provide evaluation while in character.`;

const EVAL_PROMPT = `The recruiting call is over. Evaluate the player from the college coach's perspective. Return plain text only using exactly these headings, with concise content:\n\nSCORE\n<number>/100\n\nCOACH'S READ\n2-3 concise sentences.\n\nSTRONGEST MOMENT\nOne specific moment.\n\nBIGGEST MISS\nOne specific moment.\n\nWHAT YOU DIDN'T LEARN\nOne concise sentence about important program information the player failed to investigate.\n\nONE THING TO WORK ON\nExactly one priority before the next recruiting call.\n\nPay special attention to whether the player knew what they wanted, had researched the program, asked detailed questions, carried the conversation, and showed signs of parent prompting.`;

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function complete(config: Config, messages: Array<{ role: string; content: string }>) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openAiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.openAiTextModel,
      temperature: 0.85,
      messages
    }),
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw new Error(`OpenAI returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const data = await response.json() as OpenAiChatResponse;
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty recruiting response");
  return text;
}

export async function handleRecruitingDemo(config: Config, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "GET" && (url.pathname === "/recruiting" || url.pathname === "/recruiting/")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(RECRUITING_HTML);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/recruiting/reply") {
    try {
      const body = await readJson(req) as { history?: ChatMessage[]; message?: string; first?: boolean; evaluate?: boolean };
      const history = Array.isArray(body.history) ? body.history.slice(-30) : [];
      if (body.evaluate) {
        const text = await complete(config, [
          { role: "system", content: RECRUITING_PROMPT },
          ...history,
          { role: "system", content: EVAL_PROMPT }
        ]);
        sendJson(res, 200, { text });
        return true;
      }

      const messages: Array<{ role: string; content: string }> = [
        { role: "system", content: RECRUITING_PROMPT },
        ...history
      ];
      if (body.first) messages.push({ role: "user", content: "The call just connected. Begin the recruiting call now." });
      else if (body.message?.trim()) messages.push({ role: "user", content: body.message.trim() });
      else {
        sendJson(res, 400, { error: "message is required" });
        return true;
      }
      const text = await complete(config, messages);
      sendJson(res, 200, { text });
      return true;
    } catch (error) {
      console.error("Recruiting reply failed:", error);
      sendJson(res, 500, { error: "Recruiting coach failed to respond" });
      return true;
    }
  }

  if (req.method === "POST" && url.pathname === "/recruiting/voice") {
    try {
      const body = await readJson(req) as { text?: string };
      const text = body.text?.trim();
      if (!text) {
        sendJson(res, 400, { error: "text is required" });
        return true;
      }
      const audio = await synthesizeEmmaVoiceNote(config, text);
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": String(audio.byteLength),
        "cache-control": "no-store"
      });
      res.end(Buffer.from(audio));
      return true;
    } catch (error) {
      console.error("Recruiting voice failed:", error);
      sendJson(res, 500, { error: "Recruiting voice failed" });
      return true;
    }
  }

  return false;
}

const RECRUITING_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#f7f6f2" />
<title>College Baseball Recruiting Call | Mastery</title>
<style>
  *{box-sizing:border-box} html,body{margin:0;min-height:100%;background:#f7f6f2;color:#080808}
  body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Arial,sans-serif}
  button{font:inherit;color:inherit;background:none;border:0;padding:0}
  .page{min-height:100svh;padding:max(28px,env(safe-area-inset-top)) 24px max(24px,env(safe-area-inset-bottom));display:flex;flex-direction:column}
  .kicker{font-size:13px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;margin-bottom:34px}
  h1{font-size:clamp(54px,13vw,94px);line-height:.86;letter-spacing:-.065em;text-transform:uppercase;font-weight:900;max-width:980px;margin:0}
  .sub{font-size:21px;line-height:1.28;letter-spacing:-.025em;margin-top:30px;max-width:480px}
  .call{margin-top:auto;padding-top:52px}
  .status{font-size:13px;font-weight:850;letter-spacing:.17em;text-transform:uppercase;margin-bottom:22px}
  .wave{height:76px;display:flex;align-items:center;gap:4px;overflow:hidden;max-width:760px}
  .bar{width:3px;height:12px;background:#080808;border-radius:2px;transform-origin:center;animation:pulse 1.05s ease-in-out infinite;opacity:.88}
  .bar:nth-child(3n){animation-delay:-.24s}.bar:nth-child(4n){animation-delay:-.53s}.bar:nth-child(5n){animation-delay:-.72s}.bar:nth-child(7n){animation-delay:-.38s}
  .quiet .bar{animation:none;height:5px;opacity:.35}
  @keyframes pulse{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(2.9)}}
  .bottom{display:flex;justify-content:space-between;align-items:flex-end;margin-top:42px;border-top:1px solid rgba(0,0,0,.16);padding-top:18px}
  .coach{font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.7}
  .end{font-size:13px;font-weight:850;letter-spacing:.15em;text-transform:uppercase;cursor:pointer;border-bottom:1.5px solid #080808;padding-bottom:4px}
  .error{display:none;font-size:14px;line-height:1.4;margin-top:16px;max-width:520px}
  .tap{position:fixed;inset:0;background:#f7f6f2;display:none;align-items:center;justify-content:center;padding:28px;z-index:5;text-align:center;font-size:38px;font-weight:900;line-height:.95;letter-spacing:-.05em;text-transform:uppercase;cursor:pointer}
  .results{display:none}.results h1{max-width:650px}.eval{white-space:pre-wrap;font-size:19px;line-height:1.42;max-width:760px;margin-top:36px;padding-bottom:40px}
  @media (min-width:820px){.page{padding:46px 5vw 38px}.kicker{margin-bottom:44px}.sub{font-size:24px}.call{padding-top:70px}.wave{gap:5px}.bar{width:4px}.bottom{margin-top:56px}}
</style>
</head>
<body>
<div class="tap" id="tap">Tap to hear the coach</div>
<main class="page" id="live">
  <div class="kicker">MASTERY / RECRUITING</div>
  <h1>College Baseball Recruiting Call</h1>
  <div class="sub">Talk to a college coach.<br>Practice the conversation.<br>Be ready.</div>
  <section class="call">
    <div class="status" id="status">Connecting...</div>
    <div class="wave quiet" id="wave"></div>
    <div class="error" id="error"></div>
    <div class="bottom">
      <div class="coach" id="coachLabel">Recruiting simulator</div>
      <button class="end" id="end">End call</button>
    </div>
  </section>
</main>
<main class="page results" id="results">
  <div class="kicker">MASTERY / RECRUITING</div>
  <h1>How'd you do?</h1>
  <div class="eval" id="eval">Scoring your call...</div>
</main>
<script>
(() => {
  const live = document.getElementById('live');
  const results = document.getElementById('results');
  const status = document.getElementById('status');
  const wave = document.getElementById('wave');
  const error = document.getElementById('error');
  const tap = document.getElementById('tap');
  const evalEl = document.getElementById('eval');
  const end = document.getElementById('end');
  const history = [];
  let ended = false, speaking = false, pending = false, recognition = null, stream = null;

  for(let i=0;i<62;i++){const b=document.createElement('span');b.className='bar';wave.appendChild(b)}

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setState('YOUR TURN');
    recognition.onresult = (event) => {
      let finalText = '';
      for (let i=event.resultIndex;i<event.results.length;i++) if(event.results[i].isFinal) finalText += event.results[i][0].transcript;
      if(finalText.trim()) respond(finalText.trim());
    };
    recognition.onerror = (e) => {
      if(e.error !== 'no-speech' && e.error !== 'aborted') showError('Microphone issue. Refresh and allow microphone access.');
    };
    recognition.onend = () => {
      if(!ended && !speaking && !pending) setTimeout(startListening, 250);
    };
  }

  function setState(text){status.textContent=text;wave.classList.toggle('quiet',text==='CONNECTING...' || text==='THINKING...')}
  function showError(text){error.style.display='block';error.textContent=text}

  async function ensureMic(){
    try{stream = await navigator.mediaDevices.getUserMedia({audio:true}); return true}
    catch(e){showError('Allow microphone access to practice the call.'); setState('MICROPHONE NEEDED'); return false}
  }

  function startListening(){
    if(ended || speaking || pending) return;
    if(!recognition){showError('Live speech recognition is not supported in this browser. Open this link in Safari or Chrome.'); return}
    try{recognition.start()}catch(e){}
  }

  async function playCoach(text){
    speaking=true; setState('COACH IS TALKING');
    try{
      const r = await fetch('/recruiting/voice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
      if(!r.ok) throw new Error('voice');
      const blob = await r.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      await new Promise((resolve,reject)=>{audio.onended=resolve;audio.onerror=reject;audio.play().catch(reject)});
    } catch(e) {
      tap.style.display='flex';
      await new Promise(resolve=>{tap.onclick=()=>{tap.style.display='none';resolve()}});
      try{
        const r = await fetch('/recruiting/voice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});
        const blob = await r.blob(); const audio = new Audio(URL.createObjectURL(blob));
        await new Promise((resolve,reject)=>{audio.onended=resolve;audio.onerror=reject;audio.play().catch(reject)});
      }catch(e2){showError(text)}
    }
    speaking=false;
    if(!ended) startListening();
  }

  async function api(body){
    const r=await fetch('/recruiting/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok) throw new Error('coach');
    return r.json();
  }

  async function respond(userText){
    if(ended || pending) return;
    pending=true; try{recognition && recognition.abort()}catch(e){}
    setState('THINKING...');
    history.push({role:'user',content:userText});
    try{
      const data=await api({history:history.slice(0,-1),message:userText});
      history.push({role:'assistant',content:data.text});
      pending=false;
      await playCoach(data.text);
    }catch(e){pending=false;showError('The coach lost the connection. Refresh to try again.');setState('CONNECTION LOST')}
  }

  async function begin(){
    setState('CONNECTING...');
    const micOk=await ensureMic(); if(!micOk)return;
    pending=true;
    try{
      const data=await api({history:[],first:true});
      history.push({role:'assistant',content:data.text});
      pending=false;
      await playCoach(data.text);
    }catch(e){pending=false;showError('Could not start the recruiting call.');setState('CONNECTION LOST')}
  }

  end.onclick=async()=>{
    if(ended)return; ended=true; try{recognition&&recognition.abort()}catch(e){}; if(stream)stream.getTracks().forEach(t=>t.stop());
    live.style.display='none';results.style.display='flex';
    try{const data=await api({history,evaluate:true});evalEl.textContent=data.text}catch(e){evalEl.textContent='Call complete.'}
  };

  begin();
})();
</script>
</body>
</html>`;
