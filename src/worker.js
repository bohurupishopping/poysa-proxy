/**
 * @file Cloudflare Worker for proxying Supabase API requests for an Accounting/ERP system.
 * @description This worker acts as a secure and performant gateway to a Supabase backend.
 * It handles CORS, injects the API key, and implements a smart edge caching strategy tailored
 * to differentiate between stable master data and volatile transactional data.
 */

// --- CONFIGURATION ---

// Allowed origins for CORS. Add your production and development domains here.
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:3000",    // Local development
  "https://poysa.de", // Your production domain
];

// Helper function to check if origin is localhost (for Flutter dev)
function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

// Base CORS headers. Dynamically combined with the correct origin.
const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type,apikey,x-client-info,x-supabase-auth,accept-profile,content-profile,prefer,range",
  "Access-Control-Max-Age": "86400", // 24 hours
  "Access-Control-Expose-Headers": "Content-Range,Range-Unit,Content-Length,Content-Profile,Accept-Profile",
};

// --- CACHING STRATEGY DEFINITIONS ---

// Master data tables that change infrequently. Caching these provides huge performance gains.
const MASTER_DATA_TABLES = [
  'companies', 
  'warehouses', 
   'numbering_settings', 'financial_periods'
];

// Transactional tables or endpoints that change frequently and must always be fresh.
const TRANSACTIONAL_ENDPOINTS = [
  'sales_invoices', 'tax_rates', 'tax_groups', 'tds_rates', 'purchase_bills', 'customers', 'suppliers', 'products', 'invoice_payments', 'bill_payments',
  'inventory_movements', 'journal_entries', 'cash_bank_accounts', 'journal_lines', 'daily_logs',
  'bank_reconciliations', 'sales_invoice_lines', 'purchase_bill_lines', 'chart_of_accounts', 
  'sales_invoice_line_taxes', 'purchase_bill_line_taxes', 'tds_payments',
  'sales_credit_notes', 'purchase_debit_notes', 'journal_vouchers',
  'performance_targets', 'log_attachments', 'profiles',
  '/rpc/' // IMPORTANT: Never cache Remote Procedure Calls (RPCs)
];

// --- HELPER FUNCTIONS ---

/**
 * Validates the request origin and returns the appropriate CORS headers.
 * @param {Request} request The incoming request.
 * @returns {Object|null} A headers object if the origin is allowed, otherwise null.
 */
function getCorsHeadersForRequest(request) {
  const origin = request.headers.get("origin");
  if (origin && (ALLOWED_ORIGINS.includes(origin) || isLocalhostOrigin(origin))) {
    return { ...CORS_HEADERS, "Access-Control-Allow-Origin": origin };
  }
  // Allow requests without an 'origin' (e.g., from native mobile apps, server-to-server)
  if (!origin) {
    return { ...CORS_HEADERS, "Access-Control-Allow-Origin": "*" };
  }
  return null; // Block any other origins not in the allow list
}

/**
 * Handles CORS pre-flight OPTIONS requests.
 * @param {Request} request The incoming request.
 * @param {Object} corsHeaders The CORS headers to apply.
 * @returns {Response} A response with a 204 status and appropriate headers.
 */
function handleOptions(request, corsHeaders) {
  const requestHeaders = request.headers.get("Access-Control-Request-Headers");
  const headers = {
    ...corsHeaders,
    ...(requestHeaders ? { "Access-Control-Allow-Headers": requestHeaders } : {}),
    "Vary": "Origin, Access-Control-Request-Headers"
  };
  return new Response(null, { status: 204, headers });
}

// --- MAIN WORKER LOGIC ---

export default {
  async fetch(request, env) {
    // Ensure essential environment variables are set
    if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
      return new Response("Server configuration error: SUPABASE_URL or SUPABASE_KEY is missing.", { status: 500 });
    }

    // 1. Handle CORS and Pre-flight Requests
    const corsHeaders = getCorsHeadersForRequest(request);
    if (!corsHeaders) {
      return new Response("CORS Error: This origin is not permitted.", { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return handleOptions(request, corsHeaders);
    }

    const url = new URL(request.url);

    // 2. Handle Special Info/Health Routes
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    if (url.pathname === "/info") {
      return new Response(JSON.stringify({
        description: "Accounting API Proxy Worker",
        caching_strategy: {
          long_cache_for_master_data: MASTER_DATA_TABLES,
          no_cache_for_transactional_data: TRANSACTIONAL_ENDPOINTS,
        }
      }), {
        status: 200, headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 3. Core Transparent Proxy Logic for all Supabase endpoints
    if (url.pathname.startsWith("/rest/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/storage/")) {
      const upstreamUrl = `${env.SUPABASE_URL}${url.pathname}${url.search}`;

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

      // 4. Implement Smart Caching on the Response
      if (request.method === "GET") {
        const path = url.pathname;
        if (MASTER_DATA_TABLES.some(table => path.includes(`/rest/v1/${table}`))) {
          // Cache stable data at the edge for 1 hour.
          responseHeaders.set("Cache-Control", "public, max-age=3600");
        } else if (TRANSACTIONAL_ENDPOINTS.some(endpoint => path.includes(endpoint))) {
          // Ensure transactional data and RPC calls are never cached.
          responseHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        } else {
          // Default for any other GET request is not to cache (safe default).
          responseHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    }

    // 5. Fallback for any unknown routes
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};