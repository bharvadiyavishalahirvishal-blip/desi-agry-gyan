export class ApiError extends Error {
  constructor(message, code = 'error', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError('ઇન્ટરનેટ કે સર્વર સાથે જોડાણ થઈ શક્યું નહીં. ફરી પ્રયત્ન કરો.', 'network', 0);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      data?.error?.message || `વિનંતી નિષ્ફળ ગઈ (${response.status}). ફરી પ્રયત્ન કરો.`,
      data?.error?.code || 'request_failed',
      response.status
    );
  }

  return data;
}

export const api = {
  me: () => request('/api/auth/me'),
  register: (payload) => request('/api/auth/register', { method: 'POST', body: payload }),
  login: (payload) => request('/api/auth/login', { method: 'POST', body: payload }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  analyzeCrop: (payload) => request('/api/crop/analyze', { method: 'POST', body: payload }),
  listReports: () => request('/api/crop/reports'),
  getReport: (id) => request(`/api/crop/reports/${id}`),
  deleteReport: (id) => request(`/api/crop/reports/${id}`, { method: 'DELETE' }),

  listConversations: () => request('/api/chat/conversations'),
  createConversation: () => request('/api/chat/conversations', { method: 'POST' }),
  getConversation: (id) => request(`/api/chat/conversations/${id}`),
  deleteConversation: (id) => request(`/api/chat/conversations/${id}`, { method: 'DELETE' }),
  sendMessage: (id, message) => request(`/api/chat/conversations/${id}/messages`, { method: 'POST', body: { message } }),

  fertilizerOptions: () => request('/api/fertilizer/options'),
  calculateFertilizer: (payload) => request('/api/fertilizer/calculate', { method: 'POST', body: payload }),
  fertilizerHistory: () => request('/api/fertilizer/history'),
  deleteFertilizer: (id) => request(`/api/fertilizer/history/${id}`, { method: 'DELETE' }),

  historySummary: () => request('/api/history/summary')
};

const MAX_INPUT_BYTES = 12 * 1024 * 1024;

/**
 * Reads a photo from the device, resizes it in the browser and returns a JPEG data URL.
 * Keeps uploads small so the server-side AI request stays fast on rural connections.
 */
export function photoToDataUrl(file, { maxSize = 1280, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new ApiError('કોઈ ફોટો પસંદ કરેલો નથી.', 'no_file'));
      return;
    }
    if (!file.type || !file.type.startsWith('image/')) {
      reject(new ApiError('ફક્ત ફોટો (JPG, PNG કે WEBP) પસંદ કરો.', 'not_image'));
      return;
    }
    if (file.size > MAX_INPUT_BYTES) {
      reject(new ApiError('ફોટો ખૂબ મોટો છે. બીજો ફોટો પસંદ કરો.', 'too_large'));
      return;
    }

    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      try {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        URL.revokeObjectURL(url);
        resolve(dataUrl);
      } catch {
        URL.revokeObjectURL(url);
        reject(new ApiError('ફોટો તૈયાર થઈ શક્યો નહીં. બીજો ફોટો પસંદ કરો.', 'processing_failed'));
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ApiError('આ ફોટો ખોલી શકાયો નહીં. JPG કે PNG ફોટો પસંદ કરો.', 'unsupported_image'));
    };

    image.src = url;
  });
}
