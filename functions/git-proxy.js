/**
 * Cloudflare Worker function to proxy requests to git.weegeeday.com
 * Handles CORS by forwarding requests and adding appropriate headers
 * 
 * Deploy via: npx wrangler deploy functions/
 */

export async function onRequest(context) {
  const { request } = context
  const url = new URL(request.url)

  // Extract the path after /git-proxy and reconstruct the target URL
  const targetPath = url.pathname.replace(/^\/git-proxy/, '') + url.search
  const targetUrl = `https://git.weegeeday.com${targetPath}`

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    })

    // Clone response and add CORS headers
    const newResponse = new Response(response.body, response)
    newResponse.headers.set('Access-Control-Allow-Origin', '*')
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type')
    newResponse.headers.set('Cache-Control', 'public, max-age=300') // 5 min cache

    return newResponse
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    )
  }
}

// Handle OPTIONS preflight requests
export async function onRequestOptions(context) {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}
