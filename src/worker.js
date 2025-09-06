/**
@file Cloudflare Worker for proxying Supabase API requests for an Accounting/ERP system.
@description This worker acts as a secure and performant gateway to a Supabase backend.
It handles CORS, injects the API key, and implements a smart edge caching strategy with
targeted cache invalidation for master data.
*/
// --- CONFIGURATION ---
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:3000",
  "https://poysa.de",
  ];
  const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS, PURGE, PUT",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,apikey,x-client-info,x-supabase-auth,accept-profile,content-profile,prefer,range,x-requested-with,user-agent",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Expose-Headers": "Content-Range,Range-Unit,Content-Length,Content-Profile,Accept-Profile",
  "Access-Control-Allow-Credentials": "true",
  };
  // --- CACHING STRATEGY DEFINITIONS ---
  const MASTER_DATA_TABLES = [
  'numbering_settings',
  'cash_bank_accounts',
  'chart_of_accounts',
  'companies',
  'customers',
  'financial_periods',
  'fixed_assets',
  'products',
  'profiles',
  'profile_kyc',
  'profile_references',
  'suppliers',
  'tax_group_rates',
  'tax_groups',
  'tax_rates',
  'tds_rates',
  'warehouses'
  ];
  const TRANSACTIONAL_ENDPOINTS = [
  'bank_reconciliations', 'bill_payments', 'business_proposals', 'daily_logs',
  'estimate_line_taxes', 'estimate_lines', 'estimates',
  'inventory_movements', 'invoice_payments',
  'journal_entries', 'journal_lines', 'journal_voucher_lines', 'journal_vouchers',
  'log_attachments',
  'purchase_bill_line_taxes', 'purchase_bill_lines', 'purchase_bills',
  'purchase_debit_note_line_taxes', 'purchase_debit_note_lines', 'purchase_debit_notes',
  'purchase_order_line_taxes', 'purchase_order_lines', 'purchase_orders',
  'sales_credit_note_line_taxes', 'sales_credit_note_lines', 'sales_credit_notes',
  'sales_invoice_line_taxes', 'sales_invoice_lines', 'sales_invoices',
  'sales_targets',
  'tds_payments',
  '/rpc/'
  ];
  // --- HELPER FUNCTIONS ---
  function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
  const url = new URL(origin);
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0';
  } catch {
  return false;
  }
  }
  function getCorsHeadersForRequest(request) {
  const origin = request.headers.get("origin");
  const userAgent = request.headers.get("user-agent") || "";
  // Check if this is a mobile app request (no origin header or mobile user agent)
  const isMobileApp = !origin || userAgent.toLowerCase().includes("flutter") || userAgent.toLowerCase().includes("dart");
  // Allow specific origins or any localhost/127.0.0.1 origin
  if (origin && (ALLOWED_ORIGINS.includes(origin) || isLocalhostOrigin(origin))) {
  return { ...CORS_HEADERS, "Access-Control-Allow-Origin": origin };
  }
  // For mobile apps or requests without origin, allow all but remove credentials
  if (isMobileApp || !origin) {
  const mobileHeaders = { ...CORS_HEADERS };
  delete mobileHeaders["Access-Control-Allow-Credentials"]; // Remove credentials for wildcard origin
  return { ...mobileHeaders, "Access-Control-Allow-Origin": "*" };
  }
  // For debugging: log rejected origins in development
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
  // --- NEW FUNCTION: Handles Cache Invalidation ---
  /**
  Handles a PURGE request to invalidate a specific URL from the edge cache.
  @param {Request} request The incoming PURGE request.
  @param {Object} corsHeaders The CORS headers to apply to the response.
  @returns {Response} A response indicating the result of the purge operation.
  */
  async function handlePurgeRequest(request, corsHeaders) {
  // Use the default cache provided by Cloudflare's environment
  const cache = caches.default;
  const urlToPurge = new URL(request.url);
  // For security, only allow purging of master data tables
  const isMasterData = MASTER_DATA_TABLES.some(table => urlToPurge.pathname.includes(`/rest/v1/${table}`));
  if (!isMasterData) {
  return new Response(JSON.stringify({
  purged: false,
  error: "Purge denied: This endpoint is not a cacheable master data table."
  }), {
  status: 403, // Forbidden
  headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
  }
  // Delete the cached response for the exact URL
  const wasPurged = await cache.delete(new Request(urlToPurge.toString(), { method: 'GET' }));
  return new Response(JSON.stringify({
  purged: wasPurged,
  url: urlToPurge.href,
  timestamp: new Date().toISOString()
  }), {
  status: 200,
  headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
  }
  // --- MAIN WORKER LOGIC ---
  export default {
  async fetch(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
  return new Response("Server configuration error: SUPABASE_URL or SUPABASE_KEY is missing.", { status: 500 });
  }
  
  const origin = request.headers.get("origin");
  
  const corsHeaders = getCorsHeadersForRequest(request);
  if (!corsHeaders) {
    return new Response(`CORS Error: Origin '${origin}' is not permitted.`, {
      status: 403,
      headers: { "Content-Type": "text/plain" }
    });
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
  
  // --- MODIFIED: Route PURGE requests to the new handler ---
  if (request.method === "PURGE") {
    return handlePurgeRequest(request, corsHeaders);
  }
  
  
  if (url.pathname.startsWith("/rest/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/storage/")) {
    const upstreamUrl = `${env.SUPABASE_URL}${url.pathname}${url.search}`;
  
    // --- MODIFIED: Use the default cache for GET requests ---
    // This enables us to use `cache.delete()` later
    const cache = caches.default;
    if (request.method === "GET") {
      const cachedResponse = await cache.match(request);
      if (cachedResponse) {
        const headers = new Headers(cachedResponse.headers);
        Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          statusText: cachedResponse.statusText,
          headers
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
  
    if (request.method === "GET") {
      const path = url.pathname;
      if (MASTER_DATA_TABLES.some(table => path.includes(`/rest/v1/${table}`))) {
        responseHeaders.set("Cache-Control", "public, max-age=3600");
  
        // --- MODIFIED: Store the response in the cache ---
        // Clone the response to allow its body to be used by both cache and the client
        const responseToCache = new Response(upstreamResponse.body.clone(), upstreamResponse);
        // Don't wait for the cache write to complete before returning to the user
        // `ctx.waitUntil` is the modern way to do this in modules syntax
        // For service worker syntax, you'd just call `cache.put`
        if (env.ctx && typeof env.ctx.waitUntil === 'function') {
          env.ctx.waitUntil(cache.put(request, responseToCache));
        } else {
          // Fallback for older environments or local testing
          cache.put(request, responseToCache);
        }
  
      } else if (TRANSACTIONAL_ENDPOINTS.some(endpoint => path.includes(endpoint))) {
        responseHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      } else {
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