require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, 'prompts.yaml'), 'utf8');
  return yaml.load(raw);
}

let config = loadConfig();

fs.watchFile(path.join(__dirname, 'prompts.yaml'), { interval: 1000 }, () => {
  try {
    config = loadConfig();
    console.log('[Hot Reload] prompts.yaml reloaded');
  } catch (err) {
    console.error('[Hot Reload] Failed:', err.message);
  }
});

async function callLLM(messages, opts = {}) {
  const base_url = process.env.LLM_BASE_URL || config.llm.base_url || 'https://api.anthropic.com/v1';
  const api_key = process.env.LLM_API_KEY || config.llm.api_key;
  if (!api_key) throw new Error('LLM_API_KEY not set. Set via environment variable or prompts.yaml');
  const { model, max_tokens, temperature } = config.llm;
  const response = await fetch(`${base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api_key}`
    },
    body: JSON.stringify({
      model: opts.model || model,
      messages,
      max_tokens: opts.max_tokens || max_tokens || 500,
      temperature: opts.temperature ?? temperature ?? 0.8
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'LLM API error');
  return data.choices[0].message.content;
}

function getTimeContext() {
  const now = new Date();
  const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
  const hour = now.getHours();
  const weekday = weekdays[now.getDay()];
  const month = now.getMonth() + 1;

  let timeHint = '';
  if (hour < 6) timeHint = '凌晨，夜猫子时间';
  else if (hour < 9) timeHint = '一大早';
  else if (hour < 12) timeHint = '上午';
  else if (hour < 14) timeHint = '中午';
  else if (hour < 18) timeHint = '下午';
  else if (hour < 21) timeHint = '晚上';
  else timeHint = '夜里了';

  return `[当前背景] ${month}月，${weekday}，${timeHint}（${hour}点）。自然地融入对话，不要刻意强调。`;
}

function parseProfileUpdate(raw) {
  if (!raw || raw === '无') return null;
  const profile = {};
  raw.split(',').forEach(pair => {
    const [key, ...valParts] = pair.split('=');
    const val = valParts.join('=');
    if (key && val) profile[key.trim()] = val.trim();
  });
  return Object.keys(profile).length ? profile : null;
}

async function directConversation(conversationHistory, currentStage, completed) {
  try {
    const transcript = conversationHistory
      .map(m => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
      .join('\n');

    const timeContext = getTimeContext();
    const messages = [
      { role: 'system', content: config.director_prompt },
      { role: 'user', content: `${timeContext}\n已完成目标：${completed || '无'}\n当前阶段：${currentStage}\n\n对话记录：\n${transcript}\n\n请输出你的判断和指令：` }
    ];
    const result = await callLLM(messages, { max_tokens: 200, temperature: 0 });

    const completedMatch = result.match(/completed:\s*(.+)/i);
    const goalMatch = result.match(/current_goal:\s*(.+)/i);
    const instructionMatch = result.match(/instruction:\s*(.+)/i);
    const stageMatch = result.match(/stage:\s*(\w+)/i);
    const profileMatch = result.match(/profile_update:\s*(.+)/i);

    const newCompleted = completedMatch ? completedMatch[1].trim() : (completed || '无');
    const currentGoal = goalMatch ? goalMatch[1].trim() : '';
    const instruction = instructionMatch ? instructionMatch[1].trim() : '';
    const stage = stageMatch ? stageMatch[1].trim().toLowerCase() : currentStage;
    const profileRaw = profileMatch ? profileMatch[1].trim() : '无';
    const aiProfile = parseProfileUpdate(profileRaw);

    const validStages = ['icebreak', 'onboarding', 'done'];
    const stageOrder = { icebreak: 0, onboarding: 1, done: 2 };

    const finalStage = (validStages.includes(stage) && stageOrder[stage] >= stageOrder[currentStage])
      ? stage : currentStage;

    console.log(`[Director] stage=${finalStage}, completed=${newCompleted}, goal=${currentGoal}`);
    console.log(`[Director] instruction: ${instruction}`);
    if (aiProfile) console.log(`[Director] profile_update:`, aiProfile);
    return { stage: finalStage, completed: newCompleted, currentGoal, instruction, aiProfile };
  } catch (err) {
    console.error('[Director] Error:', err.message);
    return { stage: currentStage, completed: completed || '无', currentGoal: '', instruction: '' };
  }
}

function buildMessages(conversationHistory, instruction) {
  const timeContext = getTimeContext();
  const systemMessage = config.system_prompt + '\n\n' + timeContext;
  const messages = [
    { role: 'system', content: systemMessage },
    ...conversationHistory
  ];
  if (instruction) {
    messages.push({ role: 'user', content: `[导演指令] ${instruction}` });
  }
  return messages;
}

app.post('/api/chat', async (req, res) => {
  const { message, stage, history, completed } = req.body;
  try {
    const conversationHistory = history || [];
    conversationHistory.push({ role: 'user', content: message });

    const director = await directConversation(conversationHistory, stage, completed);

    const messages = buildMessages(conversationHistory, director.instruction);
    const reply = await callLLM(messages);
    const aiMessages = reply.split('|||').map(m => m.trim()).filter(Boolean);

    res.json({
      messages: aiMessages,
      next_stage: director.stage,
      completed: director.completed,
      ai_profile: director.aiProfile || null,
      raw_reply: reply
    });
  } catch (err) {
    console.error('LLM error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/opening', async (req, res) => {
  try {
    // Director gives instruction for the opening
    const director = await directConversation(
      [{ role: 'user', content: '（用户刚进来）' }],
      'icebreak',
      '无'
    );

    const messages = buildMessages([], director.instruction);
    messages.push({ role: 'user', content: '（用户刚进来，开始吧）' });

    const reply = await callLLM(messages);
    const aiMessages = reply.split('|||').map(m => m.trim()).filter(Boolean);

    res.json({
      messages: aiMessages,
      next_stage: 'icebreak',
      completed: '无'
    });
  } catch (err) {
    console.error('LLM error:', err.message);
    res.json({
      messages: ["嘿。", "刚到，还在热机中。你这会儿忙着呢？"],
      next_stage: 'icebreak',
      completed: '无'
    });
  }
});

app.post('/api/summary', async (req, res) => {
  const { history } = req.body;
  try {
    const transcript = (history || []).map(m =>
      `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`
    ).join('\n');

    const messages = [
      { role: 'system', content: config.summary_prompt },
      { role: 'user', content: `对话记录：\n${transcript}` }
    ];

    const summary = await callLLM(messages, { max_tokens: 800, temperature: 0 });
    res.json({ summary });
  } catch (err) {
    console.error('Summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reload', (req, res) => {
  try {
    config = loadConfig();
    console.log('[Manual Reload] prompts.yaml reloaded');
    res.json({ ok: true, model: config.llm.model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  const base = process.env.LLM_BASE_URL || config.llm.base_url || 'https://api.anthropic.com/v1';
  console.log(`PandaClaw Onboarding running at http://localhost:${PORT}`);
  console.log(`Model: ${config.llm.model} via ${base}`);
});
