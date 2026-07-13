// code-api-surface.js
//
// Analyzes code (any text, any language) and returns its API surface:
// HTTP routes, exported symbols, middleware, and a summary.
// Pure static analysis — no execution, no external services.
//
// Seam: goblinpowerunit.ai/x402/v1/code/api-surface
//       484 sett/wk, 41 payers, $0.174/call (upstream)
//       We price at $0.10 — same capability, 42% cheaper.
//
// Supports: Express/Hono/Fastify (JS), FastAPI/Flask/Django (Python),
//           Spring Boot (Java), ASP.NET (C#), Rails (Ruby), Gin (Go)

// ── Route detection regexes per framework ──────────────────────────────────

const ROUTE_PATTERNS = [
  // JavaScript/TypeScript — Express, Hono, Fastify, Elysia
  {
    fw: "express",  lang: "javascript",
    re: /(?:app|router|server)\.(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // @Method() decorators — NestJS, AdonisJS (with or without explicit path)
  {
    fw: "nestjs",  lang: "typescript",
    re: /@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*(?:['"`]([^'"`]*)['"`]\s*)?\)/gi,
    extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] || "/" }),
  },
  // Python — FastAPI
  {
    fw: "fastapi",  lang: "python",
    re: /@(?:app|router)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/gi,
    extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
  // Python — Flask
  {
    fw: "flask",  lang: "python",
    re: /@(?:app|blueprint)\s*\.route\s*\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]+)\])?/gi,
    extract: (m) => {
      const methods = m[2]
        ? m[2].split(",").map(x => x.trim().replace(/['"]/g, "").toUpperCase())
        : ["GET"];
      return methods.map(method => ({ method, path: m[1] }));
    },
    multi: true,
  },
  // Python — Django urls.py
  {
    fw: "django",  lang: "python",
    re: /(?:path|re_path|url)\s*\(\s*r?['"]([^'"]+)['"](?:[^)]*name\s*=\s*['"]([^'"]+)['"])?/gi,
    extract: (m) => ({ method: "*", path: m[1], name: m[2] || null }),
  },
  // Java — Spring Boot
  {
    fw: "spring",  lang: "java",
    re: /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/gi,
    extract: (m) => {
      const methodMap = { GetMapping:"GET", PostMapping:"POST", PutMapping:"PUT",
                          PatchMapping:"PATCH", DeleteMapping:"DELETE", RequestMapping:"*" };
      return { method: methodMap[m[1]] || "*", path: m[2] };
    },
  },
  // C# — ASP.NET Core
  {
    fw: "aspnet",  lang: "csharp",
    re: /\[(Http(?:Get|Post|Put|Patch|Delete)|Route)\s*\(\s*['"]([^'"]+)['"]/gi,
    extract: (m) => {
      const method = m[1].startsWith("Http") ? m[1].replace("Http","").toUpperCase() : "*";
      return { method, path: m[2] };
    },
  },
  // Ruby — Rails routes.rb
  {
    fw: "rails",  lang: "ruby",
    re: /(?:get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi,
    extract: (m, full) => ({ method: full.match(/(get|post|put|patch|delete)/i)?.[1].toUpperCase() || "*", path: m[1] }),
  },
  // Go — Gin
  {
    fw: "gin",  lang: "go",
    re: /router\s*\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
    extract: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
  },
];

// ── Export detection ─────────────────────────────────────────────────────────

const EXPORT_PATTERNS = [
  // ESM named exports
  { re: /export\s+(?:async\s+)?function\s+(\w+)/g,    kind: "function" },
  { re: /export\s+(?:abstract\s+)?class\s+(\w+)/g,    kind: "class"    },
  { re: /export\s+(?:const|let|var)\s+(\w+)/g,        kind: "const"    },
  { re: /export\s+type\s+(\w+)/g,                     kind: "type"     },
  { re: /export\s+interface\s+(\w+)/g,                kind: "interface"},
  // CJS
  { re: /module\.exports\s*=\s*\{([^}]+)\}/g,         kind: "cjs-map"  },
  { re: /exports\.(\w+)\s*=/g,                        kind: "cjs-prop" },
  // Python
  { re: /^def\s+(\w+)\s*\(/gm,                        kind: "function" },
  { re: /^class\s+(\w+)\s*[:(]/gm,                    kind: "class"    },
];

// ── Language / framework detection ──────────────────────────────────────────

function detectLang(code) {
  if (/@[A-Z]\w+Mapping|import\s+org\.spring|public\s+class\s+\w+/.test(code)) return "java";
  if (/namespace\s+\w+|using\s+Microsoft|\[Http[A-Z]|\.cshtml/.test(code)) return "csharp";
  if (/func\s+\w+\s*\(|package\s+\w+|:=|":= "/.test(code)) return "go";
  if (/def\s+\w+.*\bdo\b|Rails\.application|\.rb:/.test(code)) return "ruby";
  if (/from\s+fastapi|from\s+flask|import\s+django|def\s+\w+\s*\(.*\)\s*:|:\s*\n\s+/.test(code)) return "python";
  if (/:\s*\w+(?:\[\]|\?)?;|interface\s+\w+\s*\{|<T>|readonly\s+\w+/.test(code)) return "typescript";
  return "javascript";
}

const FW_SIGNATURES = [
  // Python frameworks (check before JS since both use app.get patterns)
  { fw: "fastapi",  re: /from\s+fastapi|import\s+fastapi|FastAPI\s*\(/ },
  { fw: "flask",    re: /from\s+flask|import\s+flask|Flask\s*\(/ },
  { fw: "django",   re: /from\s+django|import\s+django|urlpatterns/ },
  // JS/TS frameworks
  { fw: "nestjs",   re: /@(Controller|Injectable|Module)\s*\(|from\s+['"]@nestjs/ },
  { fw: "express",  re: /require\s*\(\s*['"]express['"]|from\s+['"]express['"]/ },
  { fw: "hono",     re: /from\s+['"]hono['"]|new Hono\s*\(/ },
  { fw: "fastify",  re: /require\s*\(\s*['"]fastify['"]|from\s+['"]fastify['"]/ },
  { fw: "gin",      re: /gin\.Default\s*\(|gin\.New\s*\(/ },
  { fw: "spring",   re: /@SpringBootApplication|import\s+org\.springframework/ },
  { fw: "aspnet",   re: /WebApplication\.Create|app\.MapGet|IActionResult/ },
  { fw: "rails",    re: /Rails\.application|ActionController/ },
];

function detectFramework(code, routes) {
  for (const sig of FW_SIGNATURES) {
    if (sig.re.test(code)) return sig.fw;
  }
  if (routes.length === 0) return "unknown";
  const fwCounts = {};
  routes.forEach(r => { fwCounts[r.fw] = (fwCounts[r.fw] || 0) + 1; });
  return Object.entries(fwCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || "unknown";
}

// ── Middleware detection ─────────────────────────────────────────────────────

const MIDDLEWARE_PATTERNS = [
  { re: /cors\s*\(|app\.use\s*\(\s*cors/i,       name: "cors"       },
  { re: /helmet\s*\(|app\.use\s*\(\s*helmet/i,   name: "helmet"     },
  { re: /express\.json\s*\(|bodyParser\.json/i,  name: "json-body"  },
  { re: /express\.static\s*\(/i,                 name: "static"     },
  { re: /rateLimit\s*\(|rate.limit/i,            name: "rate-limit" },
  { re: /session\s*\(|express.session/i,         name: "session"    },
  { re: /passport\s*\./i,                        name: "passport"   },
  { re: /jwt\.verify|jsonwebtoken/i,             name: "jwt"        },
  { re: /multer\s*\(/i,                          name: "multer"     },
  { re: /swagger|openapi/i,                      name: "openapi"    },
  { re: /prometheus|prom-client/i,               name: "prometheus" },
  { re: /sentry\.init|@sentry/i,                 name: "sentry"     },
  { re: /datadog|dd-trace/i,                     name: "datadog"    },
];

// ── Main analysis ────────────────────────────────────────────────────────────

function analyzeApiSurface(code) {
  const routes   = [];
  const seenRoutes = new Set();

  for (const pat of ROUTE_PATTERNS) {
    let match;
    const re = new RegExp(pat.re.source, pat.re.flags);
    while ((match = re.exec(code)) !== null) {
      const extracted = pat.extract(match, code);
      const items = pat.multi ? extracted : [extracted];
      for (const item of items) {
        if (!item) continue;
        const key = `${item.method}:${item.path}`;
        if (!seenRoutes.has(key)) {
          seenRoutes.add(key);
          routes.push({ ...item, fw: pat.fw });
        }
      }
    }
  }

  const exports = [];
  const seenExports = new Set();
  for (const pat of EXPORT_PATTERNS) {
    let m;
    const re = new RegExp(pat.re.source, pat.re.flags);
    while ((m = re.exec(code)) !== null) {
      const name = pat.kind === "cjs-map"
        ? m[1].split(",").map(s => s.trim().replace(/[:].*/,"").replace(/['"]/g,"")).filter(Boolean)
        : [m[1]];
      for (const n of name) {
        if (n && !seenExports.has(n)) {
          seenExports.add(n);
          exports.push({ kind: pat.kind, name: n });
        }
      }
    }
  }

  const middleware = MIDDLEWARE_PATTERNS
    .filter(p => p.re.test(code))
    .map(p => p.name);

  const lang = detectLang(code);
  const framework = detectFramework(code, routes);

  const summary = [
    routes.length  ? `${routes.length} route${routes.length!==1?"s":""}` : null,
    exports.length ? `${exports.length} export${exports.length!==1?"s":""}` : null,
    middleware.length ? `middleware: ${middleware.join(", ")}` : null,
  ].filter(Boolean).join(", ");

  return {
    lang,
    framework,
    routes:     routes.map(({ method, path, name }) => ({ method, path, ...(name ? { name } : {}) })),
    exports:    exports.slice(0, 50),
    middleware,
    route_count:  routes.length,
    export_count: exports.length,
    summary:    summary || "no API surface detected",
  };
}

// ── Capability export ────────────────────────────────────────────────────────

export default {
  name: "code-api-surface",
  price: "$0.160",

  description:
    "Analyzes a code snippet and returns its API surface: HTTP routes (method + path), exported symbols, and middleware. Supports Express, FastAPI, Flask, Django, Spring Boot, ASP.NET, Rails, Gin. Pure static analysis — no code execution. Returns JSON with routes[], exports[], middleware[], lang, framework, and a plain-English summary. $0.10/call.",

  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "Source code to analyze (any language/framework). Max ~50KB recommended.",
      },
      detail: {
        type: "string",
        enum: ["full", "routes", "exports"],
        description: "Output scope: 'full' (default) = all fields; 'routes' = HTTP routes only; 'exports' = exported symbols only.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      lang:         { type: "string", description: "Detected programming language." },
      framework:    { type: "string", description: "Detected framework (express, fastapi, flask, etc.)." },
      routes:       { type: "array",  description: "HTTP routes [{method, path}]." },
      exports:      { type: "array",  description: "Exported symbols [{kind, name}]." },
      middleware:   { type: "array",  description: "Detected middleware names." },
      route_count:  { type: "number" },
      export_count: { type: "number" },
      summary:      { type: "string", description: "One-line plain-English description of the API surface." },
    },
  },

  async handler({ code = "def hello():\n    return 'Hello, World!'", detail = "full" }) {
    if (code.length > 500_000) {
      throw new Error("code exceeds 500KB limit — send a representative excerpt");
    }

    const result = analyzeApiSurface(code);

    if (detail === "routes")  return { lang: result.lang, framework: result.framework, routes: result.routes, route_count: result.route_count, summary: result.summary };
    if (detail === "exports") return { lang: result.lang, exports: result.exports, export_count: result.export_count, summary: result.summary };
    return result;
  },
};
