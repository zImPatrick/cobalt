// cobalt/api/src/core
import axios from 'axios';

const ANALYTICS_URL = process.env.ANALYTICS_URL || 'http://cobalt-analytics-api:3000';
const INSTANCE_ID = process.env.ANALYTICS_INSTANCE_ID || '';

export async function trackServiceUsage(serviceName) {
  if (!serviceName || typeof serviceName !== 'string' || !serviceName.trim()) {
    console.error('trackServiceUsage: serviceName is required and must be a non-empty string');
    return;
  }
  try {
    await axios.post(`${ANALYTICS_URL}/api/events/${INSTANCE_ID}/track`, {
      type: 'service_usage',
      name: serviceName,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('trackServiceUsage: failed to track event', err?.response?.data || err.message);
  }
}
