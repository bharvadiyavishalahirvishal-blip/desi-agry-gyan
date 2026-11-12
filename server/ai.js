/**
 * Server-side AI client.
 *
 * Works with any OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter,
 * Groq, Together, Gemini's OpenAI compatibility layer, ...).
 *
 * The API key is read from the server environment only and is never sent to the browser.
 * If the key is missing every call fails with an explicit Gujarati error - the app never
 * fabricates an AI answer.
 */
import { VISION_SYSTEM_PROMPT, buildVisionUserPrompt, CHAT_SYSTEM_PROMPT, DISCLAIMER_GU } from './prompts.js';

const BASE_URL = (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const API_KEY = (process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
const VISION_MODEL = process.env.AI_VISION_MODEL || 'gpt-4o-mini';
const CHAT_MODEL = process.env.AI_CHAT_MODEL || 'gpt-4o-mini';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 60000);

export class AiError extends Error {
  constructor(message, code = 'ai_error', status = 502) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

export function isAiConfigured() {
  return API_KEY.length > 0;
}

export function aiInfo() {
  let host = BASE_URL;
  try {
    host = new URL(BASE_URL).host;
  } catch {
    /* keep raw value */
  }
  return {
    configured: isAiConfigured(),
    provider: host,
    visionModel: VISION_MODEL,
    chatModel: CHAT_MODEL
  };
}

function requireConfigured() {
  if (!isAiConfigured()) {
    throw new AiError(
      'AI સેવા હજી ગોઠવાયેલી નથી. એપના વ્યવસ્થાપકે સર્વર પર OPENAI_API_KEY (અથવા AI_API_KEY) ઉમેરવી પડશે. ત્યાં સુધી અમે કોઈ બનાવેલો જવાબ આપતા નથી.',
      'ai_not_configured',
      503
    );
  }
}

function mapHttpError(status, providerMessage) {
  const detail = String(providerMessage || '').slice(0, 400);
  if (status === 401 || status === 403) {
    return new AiError('AI સેવાની ચાવી (API key) અમાન્ય છે. વ્યવસ્થાપકે સાચી OPENAI_API_KEY સેટ કરવી પડશે.', 'ai_auth_failed', 503);
  }
  if (status === 429) {
    return new AiError('AI સેવાની મર્યાદા (quota/rate limit) પૂરી થઈ ગઈ છે. થોડી વાર પછી ફરી પ્રયત્ન કરો.', 'ai_rate_limited', 429);
  }
  if (status === 404) {
    return new AiError('AI મોડેલ ઉપલબ્ધ નથી. વ્યવસ્થાપકે AI_VISION_MODEL / AI_CHAT_MODEL ચકાસવા પડશે.', 'ai_model_missing', 503);
  }
  if (status === 400 || status === 422) {
    return new AiError('AI સેવાએ વિનંતી સ્વીકારી નહીં. ફોટો બીજી વાર લેવાનો પ્રયત્ન કરો.', 'ai_bad_request', 502);
  }
  return new AiError(`AI સેવામાં ભૂલ થઈ (${status}). થોડી વાર પછી ફરી પ્રયત્ન કરો.`, 'ai_provider_error', 502);
}

async function callChatCompletion({ model, messages, jsonMode = false, maxTokens = 1200 }) {
  requireConfigured();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const body = { model, messages, temperature: 0.2, max_tokens: maxTokens };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const rawText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const providerMessage = payload?.error?.message || rawText;
      console.error('[ai] provider error', response.status, String(providerMessage).slice(0, 300));
      throw mapHttpError(response.status, providerMessage);
    }

    const content = payload?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('').trim()
      : String(content || '').trim();

    if (!text) {
      console.error('[ai] empty completion', rawText.slice(0, 300));
      throw new AiError('AI સેવાએ ખાલી જવાબ આપ્યો. ફરી પ્રયત્ન કરો.', 'ai_empty_response', 502);
    }

    return { text, model: payload?.model || model };
  } catch (error) {
    if (error instanceof AiError) throw error;
    if (error?.name === 'AbortError') {
      throw new AiError('AI સેવાનો જવાબ મોડો આવ્યો. ફરી પ્રયત્ન કરો.', 'ai_timeout', 504);
    }
    console.error('[ai] network error', error?.message);
    throw new AiError('AI સેવા સાથે જોડાણ થઈ શક્યું નહીં. ઇન્ટરનેટ ચકાસીને ફરી પ્રયત્ન કરો.', 'ai_network_error', 502);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(text) {
  const cleaned = String(text)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

const asText = (value, fallback = '') => {
  if (typeof value === 'string') return value.trim().slice(0, 2000);
  if (typeof value === 'number') return String(value);
  return fallback;
};

const asList = (value, limit = 8) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asText(item))
    .filter((item) => item.length > 0)
    .slice(0, limit);
};

function normalizeTreatment(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 4)
    .map((item) => {
      if (typeof item === 'string') return { name: asText(item) };
      return {
        name: asText(item?.name),
        dose: asText(item?.dose),
        waiting_period: asText(item?.waiting_period),
        safety: asText(item?.safety)
      };
    })
    .filter((item) => item.name.length > 0);
}

/** Normalises model output into the shape the UI renders, without inventing content. */
export function normalizeAnalysis(raw, model) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const issues = Array.isArray(obj.possible_issues)
    ? obj.possible_issues
        .slice(0, 4)
        .map((issue) => ({
          name: asText(issue?.name),
          category: asText(issue?.category, 'અન્ય'),
          likelihood: asText(issue?.likelihood, 'નીચી'),
          symptoms_visible: asList(issue?.symptoms_visible),
          organic_treatment: asList(issue?.organic_treatment),
          chemical_treatment: normalizeTreatment(issue?.chemical_treatment),
          prevention: asList(issue?.prevention)
        }))
        .filter((issue) => issue.name.length > 0)
    : [];

  return {
    is_plant: obj.is_plant !== false,
    crop: asText(obj.crop, 'અસ્પષ્ટ'),
    photo_quality: asText(obj.photo_quality, 'મધ્યમ'),
    overall_confidence: asText(obj.overall_confidence, 'નીચી'),
    summary: asText(obj.summary, 'ફોટા પરથી સ્પષ્ટ માહિતી મળી નથી.'),
    possible_issues: issues,
    immediate_steps: asList(obj.immediate_steps, 6),
    ask_expert: obj.ask_expert === true,
    expert_note: asText(obj.expert_note),
    disclaimer: DISCLAIMER_GU,
    model: model || null
  };
}

/** Vision analysis of a crop photo. Throws AiError on any failure. */
export async function analyzeCropImage({ imageBase64, mime, cropName, note }) {
  const messages = [
    { role: 'system', content: VISION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: buildVisionUserPrompt({ cropName, note }) },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } }
      ]
    }
  ];

  const { text, model } = await callChatCompletion({
    model: VISION_MODEL,
    messages,
    jsonMode: true,
    maxTokens: 1600
  });

  const parsed = parseJsonLoose(text);
  if (!parsed) {
    // The provider answered but not as JSON: keep the real text, do not invent a diagnosis.
    return {
      analysis: {
        is_plant: true,
        crop: cropName || 'અસ્પષ્ટ',
        photo_quality: 'મધ્યમ',
        overall_confidence: 'નીચી',
        summary: text.slice(0, 4000),
        possible_issues: [],
        immediate_steps: [],
        ask_expert: true,
        expert_note: 'AI નો જવાબ સ્વરૂપમાં આવ્યો નથી. કૃષિ નિષ્ણાતની સલાહ લેવી સારી રહેશે.',
        disclaimer: DISCLAIMER_GU,
        unstructured: true,
        model
      },
      model
    };
  }

  return { analysis: normalizeAnalysis(parsed, model), model };
}

/** Gujarati farming chat answer with the previous turns as context. */
export async function chatAnswer({ history, question }) {
  const safeHistory = Array.isArray(history)
    ? history
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
        .slice(-12)
        .map((item) => ({ role: item.role, content: String(item.content || '').slice(0, 4000) }))
    : [];

  const messages = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...safeHistory,
    { role: 'user', content: String(question || '').slice(0, 4000) }
  ];

  const { text, model } = await callChatCompletion({
    model: CHAT_MODEL,
    messages,
    jsonMode: false,
    maxTokens: 900
  });

  return { answer: text, model };
}
