import { type Plugin, tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const FALLBACK_DB_PATH = join(
  process.env.HOME || "",
  ".local",
  "share",
  "opencode",
  "opencode.db",
);

const resolveDbPath = () => {
  if (process.env.OPENCODE_DB_PATH) {
    return process.env.OPENCODE_DB_PATH;
  }

  try {
    const result = spawnSync("opencode", ["db", "path"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (result.status === 0) {
      const path = (result.stdout || "").trim();
      if (path) return path;
    }
  } catch {
    // fall through to fallback path
  }

  return FALLBACK_DB_PATH;
};

const DEFAULT_DB_PATH = resolveDbPath();

const openReadonlyDb = () => {
  try {
    return {
      db: new Database(DEFAULT_DB_PATH, { readonly: true, create: false, strict: true }),
      error: null,
    };
  } catch (error) {
    return {
      db: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const escapeLike = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

const SEARCH_CONFIG = {
  roles: ["user", "assistant"],
  defaultSessions: 6,
  maxSessions: 12,
  snippetsPerSession: 2,
  snippetLength: 220,
  sinceHours: 24 * 180,
} as const;

const TRANSCRIPT_CONFIG = {
  roles: ["user", "assistant"],
  defaultLimit: 80,
  maxLimit: 120,
  maxCharsPerEntry: 600,
  includeEmpty: false,
} as const;

type SessionMetaRow = {
  id: string;
  title: string | null;
  directory: string | null;
  slug: string | null;
  time_created: number;
  time_updated: number;
  worktree: string | null;
  project_name: string | null;
};

type SessionSearchInput = {
  query: string;
  limitSessions?: number;
};

const toSafeLimitSessions = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return SEARCH_CONFIG.defaultSessions;
  const integer = Math.trunc(parsed);
  if (integer < 1) return 1;
  if (integer > SEARCH_CONFIG.maxSessions) return SEARCH_CONFIG.maxSessions;
  return integer;
};

export const runSessionSearch = (input: SessionSearchInput) => {
  const term = String(input.query || "").trim();

  if (!term) {
    return {
      query: term,
      sessions: [],
      stats: {
        totalSessions: 0,
        totalMatches: 0,
      },
      error: {
        code: "INVALID_QUERY",
        message: "query must contain at least one non-whitespace character",
      },
    };
  }

  const { db, error } = openReadonlyDb();

  if (!db) {
    return {
      query: term,
      sessions: [],
      stats: {
        totalSessions: 0,
        totalMatches: 0,
      },
      error: {
        code: "DB_OPEN_FAILED",
        message: "Unable to open OpenCode history database",
        details: error,
        dbPath: DEFAULT_DB_PATH,
      },
    };
  }

  try {
    const textExpr = "json_extract(p.data, '$.text')";
    const words = term.toLowerCase().split(/\s+/).filter(Boolean);

    const where: string[] = [
      "json_extract(p.data, '$.type') = 'text'",
      `${textExpr} IS NOT NULL`,
      "json_extract(m.data, '$.role') IN ('user','assistant')",
    ];

    const cutoff = Date.now() - SEARCH_CONFIG.sinceHours * 60 * 60 * 1000;
    const params: any[] = [];

    for (const word of words) {
      where.push("lower(json_extract(p.data, '$.text')) LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(word)}%`);
    }

    where.push("p.time_created >= ?");
    params.push(cutoff);

    const sessionSql = `
      SELECT
        s.id AS session_id,
        s.title AS title,
        s.directory AS directory,
        COUNT(*) AS match_count,
        MAX(p.time_created) AS last_match_ms
      FROM part p
      JOIN message m ON m.id = p.message_id
      JOIN session s ON s.id = p.session_id
      WHERE ${where.join(" AND ")}
      GROUP BY s.id
      ORDER BY COUNT(*) DESC, MAX(p.time_created) DESC
      LIMIT ?
    `;

    const limitSessions = toSafeLimitSessions(input.limitSessions);
    const sessionRows = db.query(sessionSql).all(...params, limitSessions);
    const totalMatches = sessionRows.reduce((sum: number, row: any) => sum + Number(row.match_count || 0), 0);

    const snippetSql = `
      SELECT
        p.session_id AS session_id,
        p.time_created AS time_created,
        json_extract(m.data, '$.role') AS role,
        substr(${textExpr}, 1, ?) AS snippet
      FROM part p
      JOIN message m ON m.id = p.message_id
      JOIN session s ON s.id = p.session_id
      WHERE ${where.join(" AND ")}
        AND p.session_id = ?
      ORDER BY p.time_created DESC
      LIMIT ?
    `;

    const baseSnippetParams = [...params];
    const sessions = sessionRows.map((row: any) => {
      const snippetRows = db
        .query(snippetSql)
        .all(SEARCH_CONFIG.snippetLength, ...baseSnippetParams, row.session_id, SEARCH_CONFIG.snippetsPerSession)
        .map((snippet: any) => ({
          time: new Date(Number(snippet.time_created)).toISOString(),
          role: snippet.role,
          text: snippet.snippet,
        }));

      return {
        sessionId: row.session_id,
        title: row.title,
        directory: row.directory,
        matchCount: Number(row.match_count || 0),
        lastMatch: new Date(Number(row.last_match_ms)).toISOString(),
        snippets: snippetRows,
      };
    });

    const suggestedTranscriptCalls = sessions.slice(0, 3).map((session: any) => ({
      tool: "session-transcript",
      args: {
        sessionId: session.sessionId,
        limit: 60,
        order: "asc",
      },
    }));

    return {
      query: term,
      filters: {
        roles: [...SEARCH_CONFIG.roles],
        sinceHours: SEARCH_CONFIG.sinceHours,
        snippetsPerSession: SEARCH_CONFIG.snippetsPerSession,
        snippetLength: SEARCH_CONFIG.snippetLength,
      },
      stats: {
        totalSessions: sessions.length,
        totalMatches,
      },
      sessions,
      nextStep: {
        message:
          "If you need full context, always ask the user to pick a session with the question tool (first option is recommended), then call session-transcript for the selected sessionId.",
        suggestedCalls: suggestedTranscriptCalls,
        suggestedQuestionCall: {
          tool: "question",
          args: {
            questions: [
              {
                header: "Pick session",
                question: "Which session should I open for full transcript context?",
                options: sessions.slice(0, 8).map((session: any, index: number) => ({
                  label: `${session.sessionId.slice(0, 24)}${index === 0 ? "*" : ""}`,
                  description:
                    session.title || session.directory || `matchCount=${session.matchCount}`,
                })),
                multiple: false,
              },
            ],
          },
        },
      },
    };
  } finally {
    db.close();
  }
};

export const SessionHistoryPlugin: Plugin = async () => {
  return {
    tool: {
      "session-search": tool({
        description:
          "Read-only search over local opencode chat history. Returns matching sessions and snippets. Use the session-transcript tool to fetch the full conversation context.",
        args: {
          query: tool.schema
            .string()
            .trim()
            .min(1)
            .max(200)
            .describe("Text to search for in chat history."),
          limitSessions: tool.schema
            .number()
            .int()
            .min(1)
            .max(SEARCH_CONFIG.maxSessions)
            .default(SEARCH_CONFIG.defaultSessions)
            .describe("Maximum number of matching sessions to return."),
        },
        async execute(args: any) {
          return JSON.stringify(runSessionSearch(args));
        },
      }),

      "session-transcript": tool({
        description:
          "Read-only transcript reconstruction for a specific opencode session. Use after session-search to fetch full conversational context.",
        args: {
          sessionId: tool.schema
            .string()
            .min(5)
            .describe("Session ID to reconstruct transcript from (for example, ses_xxx)."),
          limit: tool.schema
            .number()
            .int()
            .min(1)
            .max(TRANSCRIPT_CONFIG.maxLimit)
            .default(TRANSCRIPT_CONFIG.defaultLimit)
            .describe("Maximum transcript entries returned."),
          order: tool.schema
            .enum(["asc", "desc"])
            .default("asc")
            .describe("Chronological or reverse-chronological ordering."),
        },
        async execute(args: any) {
          const { db, error } = openReadonlyDb();

          if (!db) {
            return JSON.stringify({
              sessionId: args.sessionId,
              found: false,
              error: {
                code: "DB_OPEN_FAILED",
                message: "Unable to open OpenCode history database",
                details: error,
                dbPath: DEFAULT_DB_PATH,
              },
              entries: [],
            });
          }

          try {
            const sessionMeta = db
              .query(
                `
                SELECT
                  s.id,
                  s.title,
                  s.directory,
                  s.slug,
                  s.time_created,
                  s.time_updated,
                  p.worktree,
                  p.name AS project_name
                FROM session s
                LEFT JOIN project p ON p.id = s.project_id
                WHERE s.id = ?
                LIMIT 1
                `,
              )
              .get(args.sessionId) as SessionMetaRow | null;

            if (!sessionMeta) {
              return JSON.stringify({
                sessionId: args.sessionId,
                found: false,
                error: "Session not found",
                entries: [],
              });
            }

            const where: string[] = [
              "p.session_id = ?",
              "json_extract(p.data, '$.type') = 'text'",
              "json_extract(m.data, '$.role') IN ('user','assistant')",
            ];
            const params: any[] = [args.sessionId];

            if (!TRANSCRIPT_CONFIG.includeEmpty) {
              where.push("json_extract(p.data, '$.text') IS NOT NULL");
              where.push("length(trim(json_extract(p.data, '$.text'))) > 0");
            }

            const orderSql = args.order === "desc" ? "DESC" : "ASC";
            const sql = `
              SELECT
                p.id AS part_id,
                p.message_id AS message_id,
                p.time_created AS time_created,
                json_extract(m.data, '$.role') AS role,
                substr(json_extract(p.data, '$.text'), 1, ?) AS text
              FROM part p
              JOIN message m ON m.id = p.message_id
              WHERE ${where.join(" AND ")}
              ORDER BY p.time_created ${orderSql}
              LIMIT ?
            `;

            const rows = db.query(sql).all(TRANSCRIPT_CONFIG.maxCharsPerEntry, ...params, args.limit);

            const entries = rows.map((row: any) => ({
              partId: row.part_id,
              messageId: row.message_id,
              timeMs: Number(row.time_created),
              time: new Date(Number(row.time_created)).toISOString(),
              role: row.role,
              text: row.text,
            }));

            return JSON.stringify({
              sessionId: sessionMeta.id,
              found: true,
              session: {
                title: sessionMeta.title,
                slug: sessionMeta.slug,
                directory: sessionMeta.directory,
                projectName: sessionMeta.project_name,
                projectWorktree: sessionMeta.worktree,
                timeCreated: new Date(Number(sessionMeta.time_created)).toISOString(),
                timeUpdated: new Date(Number(sessionMeta.time_updated)).toISOString(),
              },
              filters: {
                roles: [...TRANSCRIPT_CONFIG.roles],
                order: args.order,
                includeEmpty: TRANSCRIPT_CONFIG.includeEmpty,
                maxCharsPerEntry: TRANSCRIPT_CONFIG.maxCharsPerEntry,
              },
              stats: {
                entriesReturned: entries.length,
                limit: args.limit,
              },
              entries,
            });
          } finally {
            db.close();
          }
        },
      }),
    },
  };
};

export default SessionHistoryPlugin;
