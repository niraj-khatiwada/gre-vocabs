import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync } from "fs";

const dbPath =
  Bun.env.NODE_ENV === "production" ? "/app/data/vocab.sqlite" : "vocab.sqlite";

if (!existsSync(dbPath)) {
  console.log(`Database file not found at ${dbPath}. Executing migrate.ts...`);

  const migration = Bun.spawnSync(["bun", "./migrate.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  });

  if (migration.exitCode !== 0) {
    console.error("Migration failed! Halting startup.");
    process.exit(1);
  }

  console.log("Migration finished successfully.");
}

const db = new Database(dbPath);
const PORT = 8080;

Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Serve Local Images from GRE/ folder
    if (pathname.match(/\.(png|jpg|jpeg|gif|webp)$/i)) {
      const relativePath = decodeURIComponent(pathname).replace(/^\//, "");
      const imagePath = join(process.cwd(), `/GRE/${relativePath}`);

      const file = Bun.file(imagePath);
      if (await file.exists()) {
        return new Response(file);
      }
      return new Response("Image not found", { status: 404 });
    }

    // API: Search Vocabulary
    if (pathname === "/api/search" && req.method === "GET") {
      const query = url.searchParams.get("q") || "";
      if (!query.trim()) return Response.json([]);

      const results = db
        .prepare(
          `SELECT id, name, ref, text FROM vocab WHERE name LIKE ? OR text LIKE ? LIMIT 20`,
        )
        .all(`%${query}%`, `%${query}%`);

      return Response.json(results);
    }

    // API: List All Sessions
    if (pathname === "/api/sessions" && req.method === "GET") {
      const sessions = db
        .prepare(
          `
        SELECT
          s.id,
          s.created_at,
          s.status,
          COUNT(sc.id) as total_cards,
          SUM(CASE WHEN sc.attempted = 1 THEN 1 ELSE 0 END) as attempted_cards,
          SUM(CASE WHEN sc.flagged = 1 THEN 1 ELSE 0 END) as flagged_cards
        FROM sessions s
        LEFT JOIN session_cards sc ON s.id = sc.session_id
        GROUP BY s.id
        ORDER BY s.id DESC
      `,
        )
        .all();

      return Response.json({ sessions });
    }

    // API: Create a New Independent Session
    if (pathname === "/api/sessions" && req.method === "POST") {
      let sessionId = 0;

      db.transaction(() => {
        const res = db
          .prepare("INSERT INTO sessions (status) VALUES ('active')")
          .run();
        sessionId = Number(res.lastInsertRowid);

        db.prepare(
          `
          INSERT INTO session_cards (session_id, vocab_id, attempted, flagged)
          SELECT ?, id, 0, 0 FROM vocab
        `,
        ).run(sessionId);
      })();

      return Response.json({ id: sessionId });
    }

    // API: Delete Session
    const deleteSessionMatch = pathname.match(/^\/api\/sessions\/(\d+)$/);
    if (deleteSessionMatch && req.method === "DELETE") {
      const sessionId = Number(deleteSessionMatch[1]);
      db.transaction(() => {
        db.prepare("DELETE FROM session_cards WHERE session_id = ?").run(
          sessionId,
        );
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      })();
      return Response.json({ success: true });
    }

    // API: Get Next Card for a Session (Normal or Review mode)
    const nextCardMatch = pathname.match(/^\/api\/sessions\/(\d+)\/next$/);
    if (nextCardMatch && req.method === "GET") {
      const sessionId = Number(nextCardMatch[1]);
      const reviewMode = url.searchParams.get("review") === "true";

      let query = "";
      if (reviewMode) {
        query = `
          SELECT sc.id as session_card_id, v.id as vocab_id, v.name, v.text, v.ref
          FROM session_cards sc
          JOIN vocab v ON sc.vocab_id = v.id
          WHERE sc.session_id = ? AND sc.flagged = 1
          ORDER BY RANDOM()
          LIMIT 1
        `;
      } else {
        query = `
          SELECT sc.id as session_card_id, v.id as vocab_id, v.name, v.text, v.ref
          FROM session_cards sc
          JOIN vocab v ON sc.vocab_id = v.id
          WHERE sc.session_id = ? AND sc.attempted = 0
          ORDER BY RANDOM()
          LIMIT 1
        `;
      }

      const nextCard = db.prepare(query).get(sessionId) as {
        session_card_id: number;
        vocab_id: number;
        name: string;
        text: string;
        ref: string;
      } | null;

      const stats = db
        .prepare(
          `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN attempted = 1 THEN 1 ELSE 0 END) as attempted,
          SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) as flagged
        FROM session_cards
        WHERE session_id = ?
      `,
        )
        .get(sessionId);

      return Response.json({ card: nextCard || null, stats });
    }

    // API: Answer Card (Right or Wrong)
    const answerMatch = pathname.match(/^\/api\/cards\/(\d+)\/answer$/);
    if (answerMatch && req.method === "POST") {
      const sessionCardId = Number(answerMatch[1]);
      const { answer, reviewMode } = (await req.json()) as {
        answer: "right" | "wrong";
        reviewMode?: boolean;
      };

      db.transaction(() => {
        if (reviewMode) {
          if (answer === "right") {
            db.prepare("UPDATE session_cards SET flagged = 0 WHERE id = ?").run(
              sessionCardId,
            );
          }
        } else {
          const isWrong = answer === "wrong" ? 1 : 0;
          db.prepare(
            "UPDATE session_cards SET attempted = 1, flagged = ? WHERE id = ?",
          ).run(isWrong, sessionCardId);
        }

        const card = db
          .prepare("SELECT session_id FROM session_cards WHERE id = ?")
          .get(sessionCardId) as { session_id: number };

        const remaining = db
          .prepare(
            "SELECT COUNT(*) as count FROM session_cards WHERE session_id = ? AND attempted = 0",
          )
          .get(card.session_id) as { count: number };

        if (remaining.count === 0) {
          db.prepare(
            "UPDATE sessions SET status = 'completed' WHERE id = ?",
          ).run(card.session_id);
        }
      })();

      return Response.json({ success: true });
    }

    if (pathname === "/") {
      return new Response(HTML_CONTENT, {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`App running at http://localhost:${PORT}`);
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GRE Vocabulary Practice</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --muted: #94a3b8;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --success: #22c55e;
      --danger: #ef4444;
      --border: #334155;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 2rem 1rem; }

    .container { width: 100%; max-width: 650px; }
    header { text-align: center; margin-bottom: 2rem; }
    h1 { font-size: 2.2rem; margin-bottom: 0.5rem; }
    p.subtitle { color: var(--muted); }

    .btn {
      background: var(--primary);
      color: white;
      border: none;
      padding: 0.75rem 1.25rem;
      font-size: 0.95rem;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--text); }
    .btn-secondary:hover { background: var(--border); }
    .btn-danger { background: transparent; border: 1px solid var(--danger); color: var(--danger); padding: 0.4rem 0.8rem; }
    .btn-danger:hover { background: var(--danger); color: white; }

    .dashboard { display: flex; flex-direction: column; gap: 1rem; }
    .action-bar { display: flex; justify-content: space-between; align-items: center; }
    .button-group { display: flex; gap: 0.5rem; }
    .session-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .session-item {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .session-item:hover { border-color: var(--primary); }
    .badge { padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; background: var(--border); }
    .badge.completed { background: var(--success); color: #000; }

    .card-view { display: none; flex-direction: column; gap: 1.25rem; margin-top: 1rem; }
    .card-header { display: flex; justify-content: space-between; align-items: center; color: var(--muted); }

    .toggle-container {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--card-bg);
      padding: 0.4rem 0.8rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      cursor: pointer;
      user-select: none;
    }
    .toggle-container:hover { border-color: var(--primary); }
    .toggle-container input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: var(--primary);
      cursor: pointer;
    }

    .flashcard {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.5rem 1.5rem;
      min-height: 320px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3);
      width: 100%;
    }
    .word { font-size: 2.5rem; font-weight: 700; margin-bottom: 1rem; color: #fff; }
    .markdown-content {
      text-align: left;
      width: 100%;
      margin-top: 1.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      line-height: 1.6;
      font-size: 1.1rem;
    }

    /* Scoped slightly smaller markdown font for search results */
    .search-markdown {
      margin-top: 0.8rem;
      padding-top: 0.8rem;
      border-top: 1px solid var(--border);
      font-size: 0.95rem;
    }

    .actions { display: flex; gap: 1rem; justify-content: center; width: 100%; margin-top: 1rem; }
    .btn-right { background: var(--success); flex: 1; }
    .btn-wrong { background: var(--danger); flex: 1; }

    .completion-view { display: none; text-align: center; padding: 3rem 1rem; }

    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(4px);
      z-index: 100;
      justify-content: center;
      align-items: flex-start;
      padding-top: 5rem;
    }
    .modal-content {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      width: 100%;
      max-width: 600px;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      max-height: 80vh;
      overflow-y: auto;
    }
    .search-input {
      width: 100%;
      padding: 0.8rem 1rem;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 8px;
      font-size: 1.1rem;
    }

    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      width: 32px; height: 32px;
      border: 3px solid var(--border);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      margin: 2rem auto;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>GRE Vocabulary Flashcards</h1>
      <p class="subtitle">Session-based practice deck</p>
    </header>

    <!-- Home View -->
    <div id="view-home" class="dashboard">
      <div class="action-bar">
        <h2>Sessions</h2>
        <div class="button-group">
          <button class="btn btn-secondary" onclick="openSearchModal()">🔍 Search</button>
          <button class="btn" onclick="startNewSession()">+ New Session</button>
        </div>
      </div>
      <div id="session-list" class="session-list"><div class="spinner"></div></div>
    </div>

    <!-- Practice View -->
    <div id="view-practice" class="card-view">
      <div class="card-header">
        <button class="btn btn-secondary" onclick="showHome()">← Exit</button>
        <span id="progress-text" style="opacity: 0;">0/0</span>
        <label class="toggle-container">
          <input type="checkbox" id="chk-review" onchange="toggleReviewMode(this.checked)">
          <span id="review-toggle-label" style="font-size: 0.85rem; font-weight: 600;">Review (0)</span>
        </label>
      </div>

      <div class="flashcard">
        <div id="card-word" class="word">Loading...</div>
        <div id="card-answer" class="markdown-content" style="display: none;"></div>
        <button id="btn-reveal" class="btn" style="margin-top: 1rem;" onclick="revealCard()">Reveal Answer</button>
        <button id="btn-exit-review" class="btn btn-secondary" style="display: none; margin-top: 1rem;" onclick="exitReviewMode()">Back to Normal Mode</button>
      </div>

      <div id="answer-actions" class="actions" style="display: none;">
        <button class="btn btn-wrong" onclick="answerCard('wrong')">Wrong 👎</button>
        <button class="btn btn-right" onclick="answerCard('right')">Right 👍</button>
      </div>
    </div>

    <!-- Completion View -->
    <div id="view-complete" class="completion-view">
      <h2>Session Completed! 🎉</h2>
      <p style="color: var(--muted); margin: 1.5rem 0;">You have attempted all words in this session.</p>
      <button class="btn" onclick="showHome()">Return to Dashboard</button>
    </div>
  </div>

  <!-- Search Modal -->
  <div id="modal-search" class="modal-overlay" onclick="closeSearchModal(event)">
    <div class="modal-content" onclick="event.stopPropagation()">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h3>Search Vocabulary</h3>
        <button class="btn btn-secondary" style="padding: 0.3rem 0.8rem;" onclick="closeSearchModal()">Esc</button>
      </div>
      <input type="text" id="search-query" class="search-input" placeholder="Type a word..." oninput="handleSearch(this.value)" autofocus />
      <div id="search-results-list" style="display: flex; flex-direction: column; gap: 0.5rem;"></div>
    </div>
  </div>

  <script>
    let currentSessionId = null;
    let currentCard = null;
    let isReviewMode = false;

    async function loadSessions() {
      const listEl = document.getElementById('session-list');
      listEl.innerHTML = '<div class="spinner"></div>';

      const res = await fetch('/api/sessions');
      const data = await res.json();

      if (data.sessions.length === 0) {
        listEl.innerHTML = '<p style="color: var(--muted); text-align: center;">No sessions started yet.</p>';
        return;
      }

      listEl.innerHTML = data.sessions.map(s => \`
        <div class="session-item">
          <div style="cursor: pointer; flex: 1;" onclick="openSession(\${s.id})">
            <strong>Session #\${s.id}</strong>
            <div style="font-size: 0.85rem; color: var(--muted)">\${new Date(s.created_at).toLocaleString()}</div>
          </div>
          <div style="display: flex; gap: 1rem; align-items: center;">
            <span>\${s.attempted_cards} / \${s.total_cards} (\${s.flagged_cards} reviewing)</span>
            <span class="badge \${s.status === 'completed' ? 'completed' : ''}">\${s.status}</span>
            <button class="btn btn-danger" onclick="confirmDeleteSession(\${s.id}, event)">🗑️</button>
          </div>
        </div>
      \`).join('');
    }

    async function confirmDeleteSession(sessionId, event) {
      event.stopPropagation();
      if (confirm(\`Delete Session #\${sessionId}?\`)) {
        await fetch(\`/api/sessions/\${sessionId}\`, { method: 'DELETE' });
        loadSessions();
      }
    }

    async function startNewSession() {
      const res = await fetch('/api/sessions', { method: 'POST' });
      const data = await res.json();
      openSession(data.id);
    }

    async function openSession(id) {
      currentSessionId = id;
      isReviewMode = false;
      document.getElementById('chk-review').checked = false;
      document.getElementById('view-home').style.display = 'none';
      document.getElementById('view-complete').style.display = 'none';
      document.getElementById('view-practice').style.display = 'flex';
      fetchNextCard();
    }

    function toggleReviewMode(checked) {
      isReviewMode = checked;
      fetchNextCard();
    }

    function exitReviewMode() {
      document.getElementById('chk-review').checked = false;
      isReviewMode = false;
      fetchNextCard();
    }

    async function fetchNextCard() {
      document.getElementById('card-answer').style.display = 'none';
      document.getElementById('answer-actions').style.display = 'none';
      document.getElementById('btn-reveal').style.display = 'inline-block';
      document.getElementById('btn-exit-review').style.display = 'none';
      document.getElementById('card-word').innerText = 'Loading...';

      const res = await fetch(\`/api/sessions/\${currentSessionId}/next?review=\${isReviewMode}\`);
      const data = await res.json();

      document.getElementById('progress-text').innerText = \`\${data.stats.attempted}/\${data.stats.total}\`;
      document.getElementById('review-toggle-label').innerText = \`Review Mode\`;

      if (!data.card) {
        if (isReviewMode) {
          document.getElementById('card-word').innerText = 'No cards left to review!';
          document.getElementById('btn-reveal').style.display = 'none';
          document.getElementById('btn-exit-review').style.display = 'inline-block';
          return;
        }
        showCompletion();
        return;
      }

      currentCard = data.card;
      document.getElementById('card-word').innerText = currentCard.name;

      try {
        const fullMarkdown = currentCard.text + "\\n\\nReference: " + currentCard.ref;
        document.getElementById('card-answer').innerHTML = marked.parse(fullMarkdown);
      } catch(e) {
        document.getElementById('card-answer').innerText = currentCard.text;
      }
    }

    function revealCard() {
      document.getElementById('btn-reveal').style.display = 'none';
      document.getElementById('card-answer').style.display = 'block';
      document.getElementById('answer-actions').style.display = 'flex';
    }

    async function answerCard(answer) {
      if (!currentCard) return;
      await fetch(\`/api/cards/\${currentCard.session_card_id}/answer\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer, reviewMode: isReviewMode })
      });
      fetchNextCard();
    }

    function showCompletion() {
      document.getElementById('view-practice').style.display = 'none';
      document.getElementById('view-complete').style.display = 'block';
    }

    function showHome() {
      document.getElementById('view-home').style.display = 'flex';
      document.getElementById('view-practice').style.display = 'none';
      document.getElementById('view-complete').style.display = 'none';
      loadSessions();
    }

    function openSearchModal() {
      document.getElementById('modal-search').style.display = 'flex';
      document.getElementById('search-query').value = '';
      document.getElementById('search-query').focus();
      document.getElementById('search-results-list').innerHTML = '';
    }

    function closeSearchModal(e) {
      if (e) e.stopPropagation();
      document.getElementById('modal-search').style.display = 'none';
    }

    let searchTimeout = null;
    function handleSearch(query) {
      clearTimeout(searchTimeout);
      const resultsList = document.getElementById('search-results-list');
      if (!query.trim()) { resultsList.innerHTML = ''; return; }

      searchTimeout = setTimeout(async () => {
        const res = await fetch(\`/api/search?q=\${encodeURIComponent(query)}\`);
        const results = await res.json();

        resultsList.innerHTML = results.map(item => \`
          <div style="padding: 0.8rem; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;">
            <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
              <strong>\${item.name}</strong> <span class="badge">\${item.ref}</span>
            </div>
            <div class="markdown-content search-markdown" style="display: none;">
              \${marked.parse ? marked.parse(item.text || 'No description provided.') : (item.text || 'No description provided.')}
            </div>
          </div>
        \`).join('');
      }, 200);
    }

    loadSessions();
  </script>
</body>
</html>
`;
