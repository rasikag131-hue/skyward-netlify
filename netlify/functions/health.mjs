export default async function handler() {
  return Response.json({ status: 'ok' }, {
    headers: {
      'Cache-Control': 'no-store',
      'Netlify-CDN-Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export const config = { path: '/api/health' };
