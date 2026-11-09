/**
 * OSS: 503 ai_not_configured when GROQ is not configured, after the route
 * has validated the request body. withRateLimit may set req.aiEnabled=false
 * when getAiLimits reports disabled (also tied to GROQ_API_KEY).
 */
export function respondIfAiNotConfigured(req, res) {
  if (req.aiEnabled === false) {
    res.status(503).json({ error: 'ai_not_configured' });
    return true;
  }
  if (!process.env.GROQ_API_KEY) {
    res.status(503).json({ error: 'ai_not_configured' });
    return true;
  }
  return false;
}
