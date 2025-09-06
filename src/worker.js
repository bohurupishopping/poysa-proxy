/**
 * @file Cloudflare Worker for proxying Supabase API requests for an Accounting/ERP system.
 * @description This worker acts as a secure and performant gateway to a Supabase backend.
 * It handles CORS, injects API keys, and implements a smart edge caching strategy with
 * targeted, secure cache invalidation for master data.
 */

// --- IMPROVEMENT: Centralized configuration object ---
const CONFIG = {
  // Use environment variables for origins, with a fallback for local dev.
  ALLOWED_ORIGINS: (env) => (env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://poysa.de",
  ]),
  CORS_HEADERS: {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS, PURGE, PUT",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,apikey,x-client-info,x-supabase-auth,accept-profile,content-profile,prefer,range,x-requested-with,user-agent,x-purge-secret",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "Content-Range,Range-Unit,Content-Length,Content-Profile,Accept-Profile",
    "Access-Control-Allow-Credentials": "true",
  },
  MASTER_DATA_TABLES: [
    'numbering_settings', 'cash_bank_accounts', 'chart_of_accounts', 'companies',
    'customers', 'financial_periods', 'fixed_assets', 'products', 'profiles',
    'profile_kyc', 'profile_references', 'suppliers', 'tax_group_rates',
    'tax_groups', 'tax_rates', 'tds_rates', 'warehouses'
  ],
  // No need to list transactional tables if the default is no-cache.
  // We can simplify the logic to: "If it's master data, cache it. Otherwise, don't."
};


// --- HELPER FUNCTIONS ---

function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname);
  } catch {
    return false;
  }
}

function getCorsHeadersForRequest(request, env) {
  const origin = request.headers.get("origin");
  const userAgent = request.headers.get("user-agent") || "";
  const isMobileApp = !origin || userAgent.toLowerCase().includes("flutter") || userAgent.toLowerCase().includes("dart");
  const allowedOrigins = CONFIG.ALLOWED_ORIGINS(env);

  if (origin && (allowedOrigins.includes(origin) || isLocalhostOrigin(origin))) {
    return { ...CONFIG.CORS_HEADERS, "Access-Control-Allow-Origin": origin };
  }

  if (isMobileApp || !origin) {
    const mobileHeaders = { ...CONFIG.CORS_HEADERS };
    delete mobileHeaders["Access-Control-Allow-Credentials"];
    return { ...mobileHeaders, "Access-Control-Allow-Origin": "*" };
  }

  // --- IMPROVEMENT: Log rejected origins in non-production environments ---
  if (env.ENVIRONMENT !== 'production') {
    console.log(`CORS Error: Origin '${origin}' is not in the allowed list.`);
  }
  return null;
}

function handleOptions(request, corsHeaders) {
  const requestHeaders = request.headers.get("Access-Control-Request-Headers");
  const headers = {
    ...corsHeaders,
    ...(requestHeaders ? { "Access-Control-Allow-Headers": requestHeaders } : {}),
    "Vary": "Origin, Access-Control-Request-Headers"
  };
  return new Response(null, { status: 204, headers });
}

async function handlePurgeRequest(request, corsHeaders, env) {
  // --- IMPROVEMENT: High-priority security check for the PURGE method ---
  const secret = request.headers.get('X-Purge-Secret');
  if (!secret || secret !== env.PURGE_SECRET) {
    return new Response(JSON.stringify({ purged: false, error: "Forbidden: Invalid or missing purge secret." }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const cache = caches.default;
  const urlToPurge = new URL(request.url);

  // Security check remains crucial
  const isMasterData = CONFIG.MASTER_DATA_TABLES.some(table => urlToPurge.pathname.includes(`/rest/v1/${table}`));
  if (!isMasterData) {
    return new Response(JSON.stringify({ purged: false, error: "Purge denied: Endpoint is not a cacheable master data table." }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Use a new Request object for the cache key, without the secret header
  const cacheKeyRequest = new Request(urlToPurge.toString(), {
      headers: request.headers,
      method: 'GET' // Cache keys are typically for GET requests
  });

  const wasPurged = await cache.delete(cacheKeyRequest);

  return new Response(JSON.stringify({ purged: wasPurged, url: urlToPurge.href, timestamp: new Date().toISOString() }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}


// --- MAIN WORKER LOGIC ---

export default {
  async fetch(request, env, ctx) { // `ctx` is the modern way to get waitUntil
    if (!env.SUPABASE_URL || !env.SUPABASE_KEY || !env.PURGE_SECRET) {
      return new Response("Server configuration error: Required environment variables are missing.", { status: 500 });
    }

    const corsHeaders = getCorsHeadersForRequest(request, env);
    if (!corsHeaders) {
      return new Response(`CORS Error: Origin is not permitted.`, { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return handleOptions(request, corsHeaders);
    }

    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (request.method === "PURGE") {
      return handlePurgeRequest(request, corsHeaders, env);
    }

    const PROXIABLE_PATHS = ["/rest/", "/auth/", "/storage/"];
    if (PROXIABLE_PATHS.some(path => url.pathname.startsWith(path))) {
      const upstreamUrl = `${env.SUPABASE_URL}${url.pathname}${url.search}`;
      const cache = caches.default;

      // Use the request as the cache key.
      const cacheKey = request;
      
      if (request.method === "GET") {
        const cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          // Clone headers to add our own `X-Cache-Status` header for debugging
          const responseHeaders = new Headers(cachedResponse.headers);
          responseHeaders.set('X-Cache-Status', 'HIT');
          Object.entries(corsHeaders).forEach(([key, value]) => responseHeaders.set(key, value));
          
          return new Response(cachedResponse.body, {
              status: cachedResponse.status,
              statusText: cachedResponse.statusText,
              headers: responseHeaders
          });
        }
      }

      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set("apikey", env.SUPABASE_KEY);
      if (!forwardHeaders.has("Authorization")) {
        forwardHeaders.set("Authorization", `Bearer ${env.SUPABASE_KEY}`);
      }

      const init = {
        method: request.method,
        headers: forwardHeaders,
        body: (request.method !== "GET" && request.method !== "HEAD") ? request.body : null,
      };

      const upstreamResponse = await fetch(upstreamUrl, init);
      const responseHeaders = new Headers(upstreamResponse.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => responseHeaders.set(key, value));

      if (request.method === "GET" && upstreamResponse.ok) {
        // --- IMPROVEMENT: Simplified caching logic ---
        if (CONFIG.MASTER_DATA_TABLES.some(table => url.pathname.includes(`/rest/v1/${table}`))) {
          responseHeaders.set("Cache-Control", "public, max-age=3600"); // Cache for 1 hour
          responseHeaders.set('X-Cache-Status', 'MISS');

          const responseToCache = new Response(upstreamResponse.body.clone(), upstreamResponse);
          // Use ctx.waitUntil to not block the response
          ctx.waitUntil(cache.put(cacheKey, responseToCache));
        } else {
          // Default for all other GET requests (transactional data, RPCs, etc.)
          responseHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};