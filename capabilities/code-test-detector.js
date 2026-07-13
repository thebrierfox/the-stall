// code-test-detector.js
//
// Analyzes a code snippet or GitHub repository for test coverage presence,
// testing framework detection, and test pattern recognition.
// Pure static analysis — no execution, no external AI service.
//
// Seam: orbisapi.com/proxy/code-test-detector-api — 4,162 sett/wk, 18 payers, $0.005/call
//
// Upstream: native regex analysis + GitHub API (public repos, no auth, 60 req/hr).

const GITHUB_API = "https://api.github.com";
const TIMEOUT    = 10000;
const UA         = "the-stall/3.17 (https://intuitek.ai)";

// Framework signatures — ordered by specificity
const FRAMEWORKS = [
  // JavaScript/TypeScript
  { name: "jest",        pattern: /\b(describe|it|test|expect|beforeEach|afterEach|beforeAll|afterAll)\s*\(|jest\.config|@jest\/|"jest":/i },
  { name: "vitest",      pattern: /\bfrom\s+['"]vitest['"]|vitest\.config|vi\.(mock|fn|spy)/i },
  { name: "mocha",       pattern: /\b(describe|it|before|after)\s*\(|require\s*\(\s*['"]mocha['"]\)|mocha\.opts/i },
  { name: "jasmine",     pattern: /jasmine\.|require\s*\(\s*['"]jasmine['"]\)/i },
  { name: "cypress",     pattern: /cy\.(visit|get|click|type|contains)|cypress\/e2e|Cypress\./i },
  { name: "playwright",  pattern: /from\s+['"]@playwright\/|test\.describe|page\.goto/i },
  // Python
  { name: "pytest",      pattern: /import pytest|@pytest\.|def test_/i },
  { name: "unittest",    pattern: /import unittest|class \w+\(.*TestCase\)/i },
  // Go
  { name: "go-testing",  pattern: /func Test\w+\(t \*testing\.T\)|import\s+"testing"/i },
  // Rust
  { name: "rust-test",   pattern: /#\[test\]|#\[cfg\(test\)\]/i },
  // Java/Kotlin
  { name: "junit",       pattern: /@Test|import org\.junit/i },
  // Ruby
  { name: "rspec",       pattern: /describe ['"]|expect\(.*\)\.(to|not_to)|RSpec\./i },
  // PHP
  { name: "phpunit",     pattern: /class \w+\s+extends.*TestCase|use PHPUnit/i },
];

// Test file patterns
const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.(js|ts|jsx|tsx|py|rb|php|go|rs)$/i,
  /^(test|spec)_\w+\.(py|rb)$/i,
  /\/(test|tests|spec|specs|__tests__)\//i,
  /_test\.(go|rs|py)$/i,
  /Test\.(java|kt|cs)$/i,
];

function detectFrameworks(code) {
  return FRAMEWORKS.filter(f => f.pattern.test(code)).map(f => f.name);
}

function detectTestFilePattern(filename) {
  return TEST_FILE_PATTERNS.some(p => p.test(filename));
}

function analyzeCode(code, filename) {
  const lines       = code.split("\n");
  const testLines   = lines.filter(l => /^\s*(it|test|describe|def test_|func Test|#\[test\]|@Test)\s*[\(\s]/.test(l));
  const assertLines = lines.filter(l => /\b(assert|expect|should|must)\s*[\(\.\s]/i.test(l));

  return {
    line_count:           lines.length,
    has_test_file_name:   filename ? detectTestFilePattern(filename) : null,
    frameworks_detected:  detectFrameworks(code),
    test_function_count:  testLines.length,
    assertion_count:      assertLines.length,
    test_function_samples: testLines.slice(0, 5).map(l => l.trim()),
    has_mocks:            /\b(mock|stub|spy|sinon|jest\.fn|vi\.fn|patch)\b/i.test(code),
    has_fixtures:         /\b(fixture|factory|setUp|setup|beforeEach)\b/i.test(code),
    verdict:              testLines.length > 0 ? "HAS_TESTS" : assertLines.length > 0 ? "HAS_ASSERTIONS" : "NO_TESTS_DETECTED",
  };
}

async function analyzeGitHubRepo(repo) {
  // Fetch repo tree to look for test files
  const treeResp = await fetch(`${GITHUB_API}/repos/${repo}/git/trees/HEAD?recursive=1`, {
    headers: { "User-Agent": UA, Accept: "application/vnd.github.v3+json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!treeResp.ok) {
    if (treeResp.status === 404) throw new Error(`Repository '${repo}' not found or is private`);
    throw new Error(`GitHub API HTTP ${treeResp.status}`);
  }
  const tree = await treeResp.json();
  const files = (tree.tree || []).filter(f => f.type === "blob").map(f => f.path);

  const testFiles    = files.filter(f => detectTestFilePattern(f));
  const sourceFiles  = files.filter(f => /\.(js|ts|jsx|tsx|py|go|rs|java|rb|php|cs|kt)$/.test(f) && !detectTestFilePattern(f));
  const configFiles  = files.filter(f => /(jest|vitest|pytest|karma|cypress|playwright)\.config\.(js|ts|json|ya?ml)$/.test(f));

  // Detect frameworks from config file names
  const frameworksFromConfig = FRAMEWORKS
    .filter(f => configFiles.some(c => c.toLowerCase().includes(f.name.split("-")[0])))
    .map(f => f.name);

  const testRatio = sourceFiles.length > 0
    ? Math.round((testFiles.length / (sourceFiles.length + testFiles.length)) * 100)
    : null;

  return {
    repo,
    total_files:         files.length,
    source_files:        sourceFiles.length,
    test_files:          testFiles.length,
    test_file_ratio_pct: testRatio,
    test_file_samples:   testFiles.slice(0, 10),
    config_files:        configFiles,
    frameworks_from_config: frameworksFromConfig,
    verdict: testFiles.length === 0 ? "NO_TESTS" :
             testRatio !== null && testRatio < 5 ? "MINIMAL_TESTS" :
             testRatio !== null && testRatio >= 20 ? "WELL_TESTED" : "HAS_TESTS",
  };
}

export default {
  name: "code-test-detector",
  price: "$0.160",

  description:
    "Detects testing frameworks and test coverage presence in a code snippet or GitHub repository. For code snippets: identifies test functions, assertions, mocks, fixtures, and frameworks (Jest, pytest, go test, JUnit, RSpec, etc.). For GitHub repos: counts test files vs source files, surfaces config files, and gives a coverage verdict. No code execution — pure static analysis.",

  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "Code snippet to analyze for test patterns.",
      },
      filename: {
        type: "string",
        description: "Optional filename for the code snippet (e.g. 'utils.test.js') — helps confirm test file naming conventions.",
      },
      github_repo: {
        type: "string",
        description: "GitHub repository in 'owner/repo' format (e.g. 'facebook/react'). Analyzes the full repo file tree for test coverage.",
      },
    },
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      mode:         { type: "string",  description: "'code' or 'repo'" },
      analysis:     { type: "object",  description: "Test detection results." },
      verdict:      { type: "string",  description: "'HAS_TESTS' | 'HAS_ASSERTIONS' | 'NO_TESTS_DETECTED' | 'MINIMAL_TESTS' | 'WELL_TESTED' | 'NO_TESTS'" },
      generated_at: { type: "string" },
    },
  },

  async handler(query) {
    if (!query.code && !query.github_repo) {
      throw new Error("provide 'code' for snippet analysis or 'github_repo' for repository analysis");
    }

    if (query.github_repo) {
      const repo = query.github_repo.trim().replace(/^https?:\/\/github\.com\//, "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("invalid github_repo format — use 'owner/repo'");
      const analysis = await analyzeGitHubRepo(repo);
      return { mode: "repo", analysis, verdict: analysis.verdict, generated_at: new Date().toISOString() };
    }

    if (query.code.length > 100000) throw new Error("code snippet too large (max 100,000 chars)");
    const analysis = analyzeCode(query.code, query.filename || null);
    return { mode: "code", analysis, verdict: analysis.verdict, generated_at: new Date().toISOString() };
  },
};
